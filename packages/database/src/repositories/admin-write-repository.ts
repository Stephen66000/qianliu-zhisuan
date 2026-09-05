/**
 * W19 管理端更新方法与凭证恢复（企业边界 + 并发安全）。
 *
 * 六要素（TRD §11.2）：服务端校验对象状态、企业边界隔离、成功后返回最新结果。
 * 并发修改：单调 version 乐观锁——路由层先读快照，更新时携带 expectedVersion，
 * SET version = version + 1，0 行命中即期间被他人修改（路由层判 409 conflict）。
 */
import type { Kysely, Transaction } from "kysely";
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

/**
 * 单调 version 乐观锁（P2-01 整改，替代 updated_at 毫秒截断）。
 * version 每次更新 +1，比较无精度损耗；同毫秒并发写也不会 ABA。
 */
function versionLock(expectedVersion: number) {
  return sql<boolean>`version = ${expectedVersion}`;
}

export class CurrentSubscriptionPeriodRequiredError extends Error {
  constructor() {
    super("current subscription period is required for Coding Plan quota configuration");
    this.name = "CurrentSubscriptionPeriodRequiredError";
  }
}

async function bindPlanSnapshotToCurrentPeriod(
  trx: Transaction<Database>, enterpriseId: string, resourceId: string,
  operating: OperatingSnapshotInput,
): Promise<OperatingSnapshotInput> {
  const now = new Date();
  const period = await trx.selectFrom("provider_subscription_period")
    .select(["id", "finance_event_id", "migration_source_record_id", "product_name",
      "period_start", "period_end_exclusive"])
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", resourceId)
    .where("reversed_by_event_id", "is", null)
    .where("period_start", "<=", now)
    .where("period_end_exclusive", ">", now)
    .orderBy("period_start", "desc").orderBy("created_at", "desc").orderBy("id", "desc")
    .forUpdate().executeTakeFirst();
  if (!period) throw new CurrentSubscriptionPeriodRequiredError();

  const event = period.finance_event_id
    ? await trx.selectFrom("provider_finance_event")
      .select(["account_amount", "account_currency"])
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", period.finance_event_id).executeTakeFirst()
    : null;
  let snapshotQuery = trx.selectFrom("provider_resource_operating_snapshot")
    .select(["package_cost", "currency"])
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", resourceId)
    .where((eb) => eb.or([eb("package_cost", "is not", null), eb("total_quota", "is not", null)]));
  snapshotQuery = period.migration_source_record_id
    ? snapshotQuery.where("id", "=", period.migration_source_record_id)
    : snapshotQuery.where("effective_from", "<=", period.period_start)
      .where("effective_until", ">=", period.period_end_exclusive);
  const prior = await snapshotQuery
    .orderBy("collected_at", "desc").orderBy("version", "desc").executeTakeFirst();

  return {
    ...operating,
    collected_at: now,
    package_name: operating.package_name ?? period.product_name,
    package_cost: event?.account_amount ?? prior?.package_cost ?? null,
    currency: event?.account_currency ?? prior?.currency ?? null,
    effective_from: period.period_start,
    effective_until: period.period_end_exclusive,
    subscription_period_id: period.id,
  };
}

async function appendOperatingSnapshot(
  trx: Transaction<Database>, enterpriseId: string, resourceId: string,
  resourceMode: ProviderResource["mode"], operating: OperatingSnapshotInput,
  bindCurrentSubscriptionPeriod: boolean,
): Promise<void> {
  const snapshot = bindCurrentSubscriptionPeriod
    && resourceMode === "CODING_PLAN" && operating.source === "ADMIN"
    ? await bindPlanSnapshotToCurrentPeriod(trx, enterpriseId, resourceId, operating)
    : operating;
  const previous = await trx.selectFrom("provider_resource_operating_snapshot")
    .select("version").where("provider_resource_id", "=", resourceId)
    .orderBy("version", "desc").executeTakeFirst();
  await trx.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: enterpriseId,
    provider_resource_id: resourceId,
    version: (previous?.version ?? 0) + 1,
    source: snapshot.source,
    collected_at: snapshot.collected_at,
    currency: snapshot.currency ?? null,
    recharge_amount: snapshot.recharge_amount ?? null,
    current_balance: snapshot.current_balance ?? null,
    cumulative_cost: snapshot.cumulative_cost ?? null,
    current_period_cost: snapshot.current_period_cost ?? null,
    cost_period_start: snapshot.cost_period_start ?? null,
    cost_period_end: snapshot.cost_period_end ?? null,
    balance_updated_at: snapshot.balance_updated_at ?? null,
    package_name: snapshot.package_name ?? null,
    package_cost: snapshot.package_cost ?? null,
    total_quota: snapshot.total_quota ?? null,
    quota_unit: snapshot.quota_unit ?? null,
    used_quota: snapshot.used_quota ?? null,
    remaining_quota: snapshot.remaining_quota ?? null,
    effective_from: snapshot.effective_from ?? null,
    effective_until: snapshot.effective_until ?? null,
    reset_cycle: snapshot.reset_cycle ?? null,
    reset_anchor_at: snapshot.reset_anchor_at ?? null,
    reset_timezone: snapshot.reset_timezone ?? null,
    usage_calculation: snapshot.usage_calculation ?? "MANUAL_SNAPSHOT",
    next_reset_at: snapshot.next_reset_at ?? null,
    subscription_period_id: snapshot.subscription_period_id ?? null,
  }).execute();
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
      .where("archived_at", "is", null)
      .where(versionLock(expectedVersion))
      .returningAll()
      .executeTakeFirst();
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
    let query = this.db.updateTable("billing_rule").set({
      archived_at: archived ? new Date() : null,
      archived_by_admin_id: archived ? actorAdminId : null,
      version: sql`version + 1`,
      updated_at: new Date(),
    }).where("id", "=", id).where("enterprise_id", "=", enterpriseId)
      .where(versionLock(expectedVersion));
    if (archived) query = query.where("enabled", "=", false).where("archived_at", "is", null);
    else query = query.where("archived_at", "is not", null);
    return query.returningAll().executeTakeFirst();
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
