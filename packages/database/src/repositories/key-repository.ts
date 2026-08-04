/**
 * Principal Key 仓储 —— 下游 Key 生命周期（W03）。
 *
 * 依据：TRD §5.3。
 * - 一次展示：create 返回明文 key，DB 只存 digest（调用方负责不存明文）。
 * - 重置单事务：撤销旧 Key + 创建新 Key（L218）。
 * - 停用主体撤销全部 Key（L219）：revokeAllByPrincipal。
 * - 每主体默认一把有效主 Key（L214）。
 */
import type { Kysely, Selectable } from "kysely";
import type { Database, PrincipalKeyTable } from "../kysely.js";
import { PrincipalNotActiveError } from "./principal-repository.js";
import { mergeDeclaredModelIds } from "./employee-model-authorization-policy.js";

export type PrincipalKey = Selectable<PrincipalKeyTable>;

export interface CreatedKey {
  /** Key 明文，仅此一次返回给客户端。 */
  plaintext: string;
  /** 持久化的记录（不含明文）。 */
  record: PrincipalKey;
}

const ACTIVE_KEY_UNIQUE_INDEX = "principal_key_one_active_per_principal_uq";

/** 数据库唯一约束判定出的“主体已有 ACTIVE Key”，供 API 稳定映射为 409。 */
export class ActiveKeyExistsError extends Error {
  constructor() {
    super("principal already has an active key");
    this.name = "ActiveKeyExistsError";
  }
}

function isActiveKeyUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === "23505" && pgError.constraint === ACTIVE_KEY_UNIQUE_INDEX;
}

function jsonArray<T>(value: T[]): T[] {
  return JSON.stringify(value) as unknown as T[];
}

export class KeyRepository {
  constructor(
    private db: Kysely<Database>,
    private pepper: string,
    private generateKey: () => string,
    private digestKey: (key: string, pepper: string) => string,
    private keyPrefix: (key: string) => string,
  ) {}

  /**
   * 为主体创建新 Key（一次展示）。
   * 不检查是否已有 Key——调用方决定是否先 revoke（重置流程用 reset）。
   */
  async create(
    enterpriseId: string,
    principalId: string,
    opts?: {
      allowedModelIds?: string[] | null;
      ipAllowlist?: string[] | null;
      expiresAt?: Date | null;
      quotaLimit?: bigint | null;
      concurrencyLimit?: number | null;
    },
  ): Promise<CreatedKey> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const principal = await trx
          .selectFrom("principal")
          .select("id")
          .where("enterprise_id", "=", enterpriseId)
          .where("id", "=", principalId)
          .where("status", "=", "ACTIVE")
          .where("archived_at", "is", null)
          .forKeyShare()
          .executeTakeFirst();
        if (!principal) throw new PrincipalNotActiveError();

        const manualModelIds = opts?.allowedModelIds ?? [];
        const managedModels = await trx.selectFrom("employee_model_rule_assignment")
          .innerJoin("principal_grant", "principal_grant.id", "employee_model_rule_assignment.grant_id")
          .select("employee_model_rule_assignment.unified_model_id")
          .where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
          .where("employee_model_rule_assignment.principal_id", "=", principalId)
          .where("employee_model_rule_assignment.status", "=", "ACTIVE")
          .where("principal_grant.status", "=", "ACTIVE")
          .execute();
        const effectiveModelIds = mergeDeclaredModelIds(
          manualModelIds,
          managedModels.map((item) => item.unified_model_id),
        );
        const plaintext = this.generateKey();
        const digest = this.digestKey(plaintext, this.pepper);
        const record = await trx
          .insertInto("principal_key")
          .values({
            enterprise_id: enterpriseId,
            principal_id: principalId,
            key_prefix: this.keyPrefix(plaintext),
            key_digest: digest,
            // 安全缺省：未显式传入授权时不允许任何模型，避免 null（全部模型）扩大权限。
            allowed_model_ids: jsonArray(effectiveModelIds),
            ip_allowlist: opts?.ipAllowlist ? jsonArray(opts.ipAllowlist) : null,
            expires_at: opts?.expiresAt ?? null,
            quota_limit: opts?.quotaLimit ?? null,
            concurrency_limit: opts?.concurrencyLimit ?? null,
            status: "ACTIVE",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx.deleteFrom("principal_model_manual_authorization")
          .where("enterprise_id", "=", enterpriseId)
          .where("principal_id", "=", principalId)
          .execute();
        if (manualModelIds.length > 0) {
          await trx.insertInto("principal_model_manual_authorization")
            .values(manualModelIds.map((modelId) => ({
              enterprise_id: enterpriseId,
              principal_id: principalId,
              unified_model_id: modelId,
            })))
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        return { plaintext, record };
      });
    } catch (error) {
      if (isActiveKeyUniqueViolation(error)) {
        throw new ActiveKeyExistsError();
      }
      throw error;
    }
  }

  /**
   * 重置 Key：单事务撤销旧 Key + 创建新 Key（TRD §5.3 L218）。
   * 返回新 Key 明文（一次展示）。
   */
  async reset(enterpriseId: string, principalId: string): Promise<CreatedKey | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const principal = await trx
        .selectFrom("principal")
        .select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", principalId)
        .where("status", "=", "ACTIVE")
        .where("archived_at", "is", null)
        .forKeyShare()
        .executeTakeFirst();
      if (!principal) throw new PrincipalNotActiveError();

      // 锁定当前有效 Key。并发重置中，后到事务会在锁释放后看到已撤销状态并返回 undefined。
      const activeKeys = await trx
        .selectFrom("principal_key")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .where("status", "=", "ACTIVE")
        .orderBy("created_at", "desc")
        .forUpdate()
        .execute();
      const source = activeKeys[0];
      if (!source) return undefined;

      // 兼容历史异常数据：撤销该主体全部 ACTIVE Key，但只以最新一把为限制来源。
      await trx
        .updateTable("principal_key")
        .set({ status: "REVOKED", revoked_at: new Date() })
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .where("status", "=", "ACTIVE")
        .execute();
      // 创建新 Key（复用 create 逻辑但用 trx）
      const [manualModels, managedModels] = await Promise.all([
        trx.selectFrom("principal_model_manual_authorization")
          .select("unified_model_id")
          .where("enterprise_id", "=", enterpriseId)
          .where("principal_id", "=", principalId)
          .execute(),
        trx.selectFrom("employee_model_rule_assignment")
          .innerJoin("principal_grant", "principal_grant.id", "employee_model_rule_assignment.grant_id")
          .select("employee_model_rule_assignment.unified_model_id")
          .where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
          .where("employee_model_rule_assignment.principal_id", "=", principalId)
          .where("employee_model_rule_assignment.status", "=", "ACTIVE")
          .where("principal_grant.status", "=", "ACTIVE")
          .execute(),
      ]);
      const effectiveAllowedModelIds = mergeDeclaredModelIds(
        manualModels.length > 0
          ? manualModels.map((item) => item.unified_model_id)
          : (source.allowed_model_ids ?? []).filter((modelId) =>
            !managedModels.some((item) => item.unified_model_id === modelId)),
        managedModels.map((item) => item.unified_model_id),
      );
      const plaintext = this.generateKey();
      const digest = this.digestKey(plaintext, this.pepper);
      const record = await trx
        .insertInto("principal_key")
        .values({
          enterprise_id: enterpriseId,
          principal_id: principalId,
          key_prefix: this.keyPrefix(plaintext),
          key_digest: digest,
          // 兼容尚未执行 0022 的滚动升级节点：历史 null 也按最小权限收紧为 []。
          allowed_model_ids: jsonArray(effectiveAllowedModelIds),
          ip_allowlist:
            source.ip_allowlist === null ? null : jsonArray(source.ip_allowlist),
          expires_at: source.expires_at,
          quota_limit: source.quota_limit,
          concurrency_limit: source.concurrency_limit,
          status: "ACTIVE",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { plaintext, record };
    });
  }

  /** 更新当前有效 Key 的模型授权。空数组表示不允许任何模型。 */
  async updateAllowedModels(
    enterpriseId: string,
    principalId: string,
    allowedModelIds: string[],
  ): Promise<PrincipalKey | undefined> {
    return this.db.transaction().execute(async (trx) => {
      // 与规则发布/停用共用同一把 Key 行锁；必须先锁后读取 Grant，避免用旧快照覆盖新发布权限。
      const activeKey = await trx.selectFrom("principal_key")
        .select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .where("status", "=", "ACTIVE")
        .forUpdate()
        .executeTakeFirst();
      if (!activeKey) return undefined;
      await trx.deleteFrom("principal_model_manual_authorization")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .execute();
      if (allowedModelIds.length > 0) {
        await trx.insertInto("principal_model_manual_authorization")
          .values(allowedModelIds.map((modelId) => ({
            enterprise_id: enterpriseId,
            principal_id: principalId,
            unified_model_id: modelId,
          })))
          .execute();
      }
      const managed = await trx.selectFrom("employee_model_rule_assignment")
        .innerJoin("principal_grant", "principal_grant.id", "employee_model_rule_assignment.grant_id")
        .select("employee_model_rule_assignment.unified_model_id")
        .where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
        .where("employee_model_rule_assignment.principal_id", "=", principalId)
        .where("employee_model_rule_assignment.status", "=", "ACTIVE")
        .where("principal_grant.status", "=", "ACTIVE")
        .execute();
      const effectiveIds = mergeDeclaredModelIds(
        allowedModelIds,
        managed.map((item) => item.unified_model_id),
      );
      return trx.updateTable("principal_key")
        .set({ allowed_model_ids: jsonArray(effectiveIds) })
        .where("id", "=", activeKey.id)
        .returningAll()
        .executeTakeFirst();
    });
  }

  /** 停用主体时撤销全部有效 Key（TRD §5.3 L219）。 */
  async revokeAllByPrincipal(enterpriseId: string, principalId: string): Promise<number> {
    const result = await this.db
      .updateTable("principal_key")
      .set({ status: "REVOKED", revoked_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .where("status", "=", "ACTIVE")
      .executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0);
  }

  /** 列表（只返回 prefix 等元数据，不含 digest 明文也不返回明文 key）。 */
  async listByPrincipal(enterpriseId: string, principalId: string): Promise<PrincipalKey[]> {
    return this.db
      .selectFrom("principal_key")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .orderBy("created_at", "desc")
      .execute();
  }

  /** 当前有效 Key（每主体默认一把）。 */
  async findActive(enterpriseId: string, principalId: string): Promise<PrincipalKey | undefined> {
    return this.db
      .selectFrom("principal_key")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .where("status", "=", "ACTIVE")
      .executeTakeFirst();
  }
}
