/**
 * W19 管理端更新方法与凭证恢复（企业边界 + 并发安全）。
 *
 * 六要素（TRD §11.2）：服务端校验对象状态、企业边界隔离、成功后返回最新结果。
 * 并发修改：单调 version 乐观锁——路由层先读快照，更新时携带 expectedVersion，
 * SET version = version + 1，0 行命中即期间被他人修改（路由层判 409 conflict）。
 */
import type { Kysely } from "kysely";
import { appendOperatingSnapshot } from "./provider-operating-snapshot-writer.js";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import type {
  ProviderResource,
  UnifiedModel,
  ModelRoute,
  OperatingSnapshotInput,
} from "./provider-repository.js";
import { ModelRouteNotReadyError } from "./provider-repository.js";
import type { PrincipalGrant } from "./grant-repository.js";
import { AdminBillingWrites } from "./admin-billing-writes.js";

/**
 * 单调 version 乐观锁（P2-01 整改，替代 updated_at 毫秒截断）。
 * version 每次更新 +1，比较无精度损耗；同毫秒并发写也不会 ABA。
 */
function versionLock(expectedVersion: number) {
  return sql<boolean>`version = ${expectedVersion}`;
}

export { CurrentSubscriptionPeriodRequiredError } from "./provider-operating-snapshot-writer.js";

export class AdminWriteRepository {
  constructor(private db: Kysely<Database>) {}

  /** 更新厂商资源基础字段（version 乐观锁；凭证轮换走 adminRecoverResource）。 */
  async updateProviderResource(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    patch: {
      name?: string;
      concurrency_limit?: number | null;
      upstream_models?: string[] | null;
      operating_snapshot?: OperatingSnapshotInput;
      bind_current_subscription_period?: boolean;
    },
  ): Promise<ProviderResource | null> {
    return this.db.transaction().execute(async (trx) => {
      const {
        operating_snapshot: operating,
        bind_current_subscription_period: bindCurrentSubscriptionPeriod,
        upstream_models: upstreamModels,
        ...basePatch
      } = patch;
      const resourcePatch = {
        ...basePatch,
        ...(upstreamModels !== undefined
          ? {
              upstream_models: upstreamModels
                ? (JSON.stringify(upstreamModels) as unknown as string[])
                : null,
            }
          : {}),
      };
      const updated = await trx
        .updateTable("provider_resource")
        .set({ ...resourcePatch, version: sql`version + 1`, updated_at: new Date() })
        .where("id", "=", id)
        .where("enterprise_id", "=", enterpriseId)
        .where(versionLock(expectedVersion))
        .returningAll()
        .executeTakeFirst();
      if (!updated) return null;
      if (operating) {
        await appendOperatingSnapshot(
          trx, enterpriseId, id, updated.mode, operating,
          bindCurrentSubscriptionPeriod ?? false,
        );
      }
      return updated as ProviderResource;
    });
  }

  /** 更新统一模型（version 乐观锁）。 */
  async updateUnifiedModel(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    patch: { display_name?: string; status?: "ACTIVE" | "DISABLED" },
  ): Promise<UnifiedModel | null> {
    return this.db
      .updateTable("unified_model")
      .set({ ...patch, version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", id)
      .where("enterprise_id", "=", enterpriseId)
      .where("archived_at", "is", null)
      .where(versionLock(expectedVersion))
      .returningAll()
      .executeTakeFirst() as Promise<UnifiedModel | null>;
  }

  /** 更新模型路由（version 乐观锁；启用/停用/优先级/权重）。 */
  async updateModelRoute(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    patch: { priority?: number; weight?: number; enabled?: boolean },
  ): Promise<ModelRoute | null> {
    return this.db.transaction().execute(async (trx) => {
      if (patch.enabled === true) {
        const target = await trx.selectFrom("model_route")
          .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
          .select(["model_route.unified_model_id", "model_route.provider_resource_id", "model_route.upstream_model", "unified_model.status"])
          .where("model_route.id", "=", id)
          .where("model_route.enterprise_id", "=", enterpriseId)
          .where("model_route.archived_at", "is", null)
          .executeTakeFirst();
        if (target?.status === "PENDING_CONFIG") {
          const validated = await trx.selectFrom("provider_model_validation")
            .select("id")
            .where("enterprise_id", "=", enterpriseId)
            .where("provider_resource_id", "=", target.provider_resource_id)
            .where("upstream_model", "=", target.upstream_model)
            .where("status", "=", "SUCCEEDED")
            .executeTakeFirst();
          if (!validated) throw new ModelRouteNotReadyError();
        }
      }
      return trx
        .updateTable("model_route")
        .set({ ...patch, version: sql`version + 1`, updated_at: new Date() })
        .where("id", "=", id)
        .where("enterprise_id", "=", enterpriseId)
        .where("archived_at", "is", null)
        .where(versionLock(expectedVersion))
        .returningAll()
        .executeTakeFirst() as Promise<ModelRoute | null>;
    });
  }

  /** 更新主体额度（version 乐观锁；调额/允许超额/有效期/停用）。 */
  async updateGrant(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    patch: {
      quota_value?: bigint;
      allow_overage?: boolean;
      valid_until?: Date | null;
      status?: "ACTIVE" | "DISABLED";
    },
  ): Promise<PrincipalGrant | null> {
    return this.db
      .updateTable("principal_grant")
      .set({ ...patch, version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", id)
      .where("enterprise_id", "=", enterpriseId)
      .where(
        "principal_id",
        "in",
        this.db
          .selectFrom("principal")
          .select("id")
          .where("enterprise_id", "=", enterpriseId)
          .where("status", "=", "ACTIVE")
          .where("archived_at", "is", null),
      )
      .where(versionLock(expectedVersion))
      .returningAll()
      .executeTakeFirst() as Promise<PrincipalGrant | null>;
  }

  /** 更新计价规则（version 乐观锁；历史账本仍冻结原 rule_version）。 */
  async updateBillingRule(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    patch: Parameters<AdminBillingWrites["updateBillingRule"]>[3],
  ) {
    return new AdminBillingWrites(this.db).updateBillingRule(enterpriseId, id, expectedVersion, patch);
  }

  async setUnifiedModelArchived(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    archived: boolean,
    actorAdminId: string,
  ): Promise<UnifiedModel | null> {
    let query = this.db.updateTable("unified_model").set({
      archived_at: archived ? new Date() : null,
      archived_by_admin_id: archived ? actorAdminId : null,
      version: sql`version + 1`,
      updated_at: new Date(),
    }).where("id", "=", id).where("enterprise_id", "=", enterpriseId)
      .where(versionLock(expectedVersion));
    if (archived) query = query.where("status", "!=", "ACTIVE").where("archived_at", "is", null);
    else query = query.where("archived_at", "is not", null);
    return query.returningAll().executeTakeFirst() as Promise<UnifiedModel | null>;
  }

  async setModelRouteArchived(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    archived: boolean,
    actorAdminId: string,
  ): Promise<ModelRoute | null> {
    let query = this.db.updateTable("model_route").set({
      archived_at: archived ? new Date() : null,
      archived_by_admin_id: archived ? actorAdminId : null,
      version: sql`version + 1`,
      updated_at: new Date(),
    }).where("id", "=", id).where("enterprise_id", "=", enterpriseId)
      .where(versionLock(expectedVersion));
    if (archived) query = query.where("enabled", "=", false).where("archived_at", "is", null);
    else query = query.where("archived_at", "is not", null);
    return query.returningAll().executeTakeFirst() as Promise<ModelRoute | null>;
  }

  async setBillingRuleArchived(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    archived: boolean,
    actorAdminId: string,
  ) {
    return new AdminBillingWrites(this.db).setBillingRuleArchived(enterpriseId, id, expectedVersion, archived, actorAdminId);
  }

  /**
   * 凭证恢复 + 可选轮换（WT-19 受控恢复）。
   *
   * 单事务：企业边界 + 行锁 → 状态机恢复（仅隔离态可恢复，返回 null = 非隔离态）
   * → 可选轮换凭证（密文+指纹+版本递增）。
   * 返回恢复后的资源行；null = 资源存在但当前状态不可恢复（路由层判 409）。
   */
  async adminRecoverResource(
    enterpriseId: string,
    resourceId: string,
    rotation?: {
      credential_encrypted: { ciphertext: string; nonce: string; tag: string };
      credential_fingerprint: string;
    },
  ): Promise<ProviderResource | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", resourceId)
        .where("enterprise_id", "=", enterpriseId)
        .forUpdate()
        .executeTakeFirst();

      if (!row) {
        throw new AdminRecoverNotFoundError();
      }

      // 仅隔离态（CREDENTIAL_INVALID/EXHAUSTED/EXPIRED/UNAVAILABLE）可管理恢复
      const RECOVERABLE = new Set([
        "CREDENTIAL_INVALID",
        "EXHAUSTED",
        "EXPIRED",
        "UNAVAILABLE",
      ]);
      if (!RECOVERABLE.has(row.status)) {
        return null;
      }

      // Chat 401 形成的凭证隔离不能靠人工改状态解除；管理员必须提交新凭证。
      // 额度耗尽或临时不可用仍可在外部事实恢复后手工解除。
      if (row.status === "CREDENTIAL_INVALID" && (
        !rotation || rotation.credential_fingerprint === row.credential_fingerprint
      )) {
        throw new AdminCredentialRotationRequiredError();
      }

      const now = new Date();
      const updated = await trx
        .updateTable("provider_resource")
        .set({
          status: "DEGRADED",
          consecutive_failures: 0,
          cooldown_until: null,
          credential_refresh_status: "OK",
          refresh_error_classification: null,
          ...(rotation
            ? {
                credential_ciphertext: JSON.stringify(rotation.credential_encrypted),
                credential_fingerprint: rotation.credential_fingerprint,
                credential_version: (row.credential_version ?? 0) + 1,
              }
            : {}),
          updated_at: now,
        })
        .where("id", "=", resourceId)
        .returningAll()
        .executeTakeFirstOrThrow();

      // 状态迁移审计（不可覆盖，actor=admin；沿用 0010 resource_status_event）
      await trx
        .insertInto("resource_status_event")
        .values({
          enterprise_id: enterpriseId,
          provider_resource_id: resourceId,
          from_status: row.status,
          to_status: "DEGRADED",
          reason: "admin_recover",
          error_classification: null,
          consecutive_failures: 0,
          cooldown_until: null,
          actor: "admin",
        })
        .execute();

      return updated as ProviderResource;
    });
  }
}

/** 资源不存在（或不属于本企业）——路由层捕获转 404。 */
export class AdminRecoverNotFoundError extends Error {
  constructor() {
    super("provider resource not found");
    this.name = "AdminRecoverNotFoundError";
  }
}

/** CREDENTIAL_INVALID 只能通过实际轮换凭证或受控 Chat 探测恢复。 */
export class AdminCredentialRotationRequiredError extends Error {
  constructor() {
    super("credential rotation is required for credential-invalid resource recovery");
    this.name = "AdminCredentialRotationRequiredError";
  }
}
