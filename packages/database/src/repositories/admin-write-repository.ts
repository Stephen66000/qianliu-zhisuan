/**
 * W19 管理端更新方法与凭证恢复（企业边界 + 并发安全）。
 *
 * 六要素（TRD §11.2）：服务端校验对象状态、企业边界隔离、成功后返回最新结果。
 * 并发修改：单调 version 乐观锁——路由层先读快照，更新时携带 expectedVersion，
 * SET version = version + 1，0 行命中即期间被他人修改（路由层判 409 conflict）。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import type {
  ProviderResource,
  UnifiedModel,
  ModelRoute,
  OperatingSnapshotInput,
} from "./provider-repository.js";
import type { PrincipalGrant } from "./grant-repository.js";

/**
 * 单调 version 乐观锁（P2-01 整改，替代 updated_at 毫秒截断）。
 * version 每次更新 +1，比较无精度损耗；同毫秒并发写也不会 ABA。
 */
function versionLock(expectedVersion: number) {
  return sql<boolean>`version = ${expectedVersion}`;
}

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
    },
  ): Promise<ProviderResource | null> {
    return this.db.transaction().execute(async (trx) => {
      const {
        operating_snapshot: operating,
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
        const previous = await trx
          .selectFrom("provider_resource_operating_snapshot")
          .select("version")
          .where("provider_resource_id", "=", id)
          .orderBy("version", "desc")
          .executeTakeFirst();
        await trx.insertInto("provider_resource_operating_snapshot").values({
          enterprise_id: enterpriseId,
          provider_resource_id: id,
          version: (previous?.version ?? 0) + 1,
          source: operating.source,
          collected_at: operating.collected_at,
          currency: operating.currency ?? null,
          recharge_amount: operating.recharge_amount ?? null,
          current_balance: operating.current_balance ?? null,
          cumulative_cost: operating.cumulative_cost ?? null,
          current_period_cost: operating.current_period_cost ?? null,
          cost_period_start: operating.cost_period_start ?? null,
          cost_period_end: operating.cost_period_end ?? null,
          balance_updated_at: operating.balance_updated_at ?? null,
          package_name: operating.package_name ?? null,
          package_cost: operating.package_cost ?? null,
          total_quota: operating.total_quota ?? null,
          quota_unit: operating.quota_unit ?? null,
          used_quota: operating.used_quota ?? null,
          remaining_quota: operating.remaining_quota ?? null,
          effective_from: operating.effective_from ?? null,
          effective_until: operating.effective_until ?? null,
          reset_cycle: operating.reset_cycle ?? null,
          reset_anchor_at: operating.reset_anchor_at ?? null,
          reset_timezone: operating.reset_timezone ?? null,
          usage_calculation: operating.usage_calculation ?? "MANUAL_SNAPSHOT",
          next_reset_at: operating.next_reset_at ?? null,
        }).execute();
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
    return this.db
      .updateTable("model_route")
      .set({ ...patch, version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", id)
      .where("enterprise_id", "=", enterpriseId)
      .where(versionLock(expectedVersion))
      .returningAll()
      .executeTakeFirst() as Promise<ModelRoute | null>;
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
    patch: {
      effective_to?: Date | null;
      enabled?: boolean;
    },
  ) {
    return this.db
      .updateTable("billing_rule")
      .set({ ...patch, version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", id)
      .where("enterprise_id", "=", enterpriseId)
      .where(versionLock(expectedVersion))
      .returningAll()
      .executeTakeFirst();
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
