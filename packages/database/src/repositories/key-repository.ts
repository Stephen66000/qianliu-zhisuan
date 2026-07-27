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

export type PrincipalKey = Selectable<PrincipalKeyTable>;

export interface CreatedKey {
  /** Key 明文，仅此一次返回给客户端。 */
  plaintext: string;
  /** 持久化的记录（不含明文）。 */
  record: PrincipalKey;
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
    const plaintext = this.generateKey();
    const digest = this.digestKey(plaintext, this.pepper);
    const record = await this.db
      .insertInto("principal_key")
      .values({
        enterprise_id: enterpriseId,
        principal_id: principalId,
        key_prefix: this.keyPrefix(plaintext),
        key_digest: digest,
        allowed_model_ids: opts?.allowedModelIds ?? null,
        ip_allowlist: opts?.ipAllowlist ?? null,
        expires_at: opts?.expiresAt ?? null,
        quota_limit: opts?.quotaLimit ?? null,
        concurrency_limit: opts?.concurrencyLimit ?? null,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { plaintext, record };
  }

  /**
   * 重置 Key：单事务撤销旧 Key + 创建新 Key（TRD §5.3 L218）。
   * 返回新 Key 明文（一次展示）。
   */
  async reset(enterpriseId: string, principalId: string): Promise<CreatedKey> {
    return this.db.transaction().execute(async (trx) => {
      // 撤销所有 ACTIVE Key
      await trx
        .updateTable("principal_key")
        .set({ status: "REVOKED", revoked_at: new Date() })
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .where("status", "=", "ACTIVE")
        .execute();
      // 创建新 Key（复用 create 逻辑但用 trx）
      const plaintext = this.generateKey();
      const digest = this.digestKey(plaintext, this.pepper);
      const record = await trx
        .insertInto("principal_key")
        .values({
          enterprise_id: enterpriseId,
          principal_id: principalId,
          key_prefix: this.keyPrefix(plaintext),
          key_digest: digest,
          status: "ACTIVE",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { plaintext, record };
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
