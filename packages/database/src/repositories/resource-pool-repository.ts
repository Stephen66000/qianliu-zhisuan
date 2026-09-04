/**
 * 资源池仓储（W11）—— 凭证生命周期状态机的落库侧。
 *
 * 依据：TRD §5.4（provider_resource 凭证/健康字段）、§9 行 598（熔断/冷却/半开；
 * 健康状态是派生运行状态，事实以 PostgreSQL 为准）、§14 行 853（隔离/恢复审计）。
 *
 * 职责边界：
 *   - 状态推导规则在 @qianliu/domain（resource-lifecycle.ts，纯函数）；
 *   - 本仓储只做：读当前状态 → 应用迁移（status + 字段更新 + resource_status_event 审计，
 *     同事务）→ 查询可服务资源（硬过滤，供 W12 评分使用）。
 *   - 恢复边界：终态默认由 adminRecover 受控恢复；Coding Plan 厂商额度接口当次确认
 *     凭证有效且所有窗口有余量时，允许 recordQuotaSyncRecovery 自动恢复。
 */
import type { Kysely, Selectable } from "kysely";
import type { Database, ProviderResourceTable, ResourceStatusEventTable } from "../kysely.js";
import {
  deriveResourceTransition,
  deriveSuccessTransition,
  deriveCredentialExpiry,
  deriveRefreshFailure,
  deriveAdminRecovery,
  deriveQuotaSyncRecovery,
  deriveBalanceSyncRecovery,
  evaluateAdmission,
  RESOURCE_STATUS,
  type ErrorClassification,
  type ResourceRuntimeState,
  type ResourceStatus,
  type StateTransition,
} from "@qianliu/domain";
import { refreshEmployeeKeyModels } from "./employee-model-rule-lifecycle.js";

export type ResourceStatusEvent = Selectable<ResourceStatusEventTable>;
export type ProviderResourceRow = Selectable<ProviderResourceTable>;

/** 可服务资源视图（硬过滤后的路由候选输入）。 */
export interface ServableResource {
  id: string;
  enterpriseId: string;
  providerId: string;
  resourcePoolId: string | null;
  mode: "API" | "CODING_PLAN";
  status: ResourceStatus;
  /** true = 冷却到期后的半开探测（W12 评分时可降权）。 */
  probe: boolean;
}

/** `last_probe_at` 同时作为可过期租约时间与释放 fencing token。 */
export interface HalfOpenProbeLease {
  resourceId: string;
  acquiredAt: Date;
}

function toRuntimeState(row: ProviderResourceRow): ResourceRuntimeState {
  return {
    status: row.status as ResourceStatus,
    consecutiveFailures: row.consecutive_failures,
    cooldownUntil: row.cooldown_until ? row.cooldown_until.getTime() : null,
  };
}

export class ResourcePoolRepository {
  constructor(private db: Kysely<Database>) {}

  async getResource(resourceId: string): Promise<ProviderResourceRow | undefined> {
    return this.db
      .selectFrom("provider_resource")
      .selectAll()
      .where("id", "=", resourceId)
      .executeTakeFirst();
  }

  /**
   * 被动请求失败 → 应用状态迁移（若有）。
   * 返回应用的迁移；null = 无状态变化（幂等/不计入健康的错误类）。
   */
  async recordFailure(
    resourceId: string,
    classification: ErrorClassification,
    now: Date = new Date(),
    options: { retryAfterMs?: number; cooldownUntil?: number } = {},
  ): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", resourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const transition = deriveResourceTransition(
        toRuntimeState(row),
        classification,
        now.getTime(),
        options,
      );
      if (!transition) return null;
      await this.applyTransitionTx(trx, row, transition, classification, "system");
      return transition;
    });
  }

  /**
   * 冷却到期的单资源半开租约。条件 UPDATE 保证多进程/多实例同时只有一个
   * 真实业务请求获得探针资格。
   */
  async tryAcquireHalfOpenProbe(
    resourceId: string,
    now: Date = new Date(),
    // 非 Gateway 调用的兼容默认值；Gateway 生产路径必须显式传入总超时派生租期。
    leaseMs = 11 * 60_000,
  ): Promise<boolean> {
    return (await this.acquireHalfOpenProbeLease(resourceId, now, leaseMs)) !== null;
  }

  /**
   * 获取带 fencing token 的半开探针租约。进程崩溃时 `leaseMs` 后可自动抢占；
   * 迟到的旧请求只能释放自己的 token，不能清掉已被新请求接管的探针。
   */
  async acquireHalfOpenProbeLease(
    resourceId: string,
    now: Date = new Date(),
    leaseMs = 11 * 60_000,
  ): Promise<HalfOpenProbeLease | null> {
    const staleBefore = new Date(now.getTime() - leaseMs);
    const acquired = await this.db
      .updateTable("provider_resource")
      .set({ last_probe_at: now, updated_at: now })
      .where("id", "=", resourceId)
      .where("status", "in", [RESOURCE_STATUS.UNAVAILABLE, RESOURCE_STATUS.RATE_LIMITED])
      .where("cooldown_until", "<=", now)
      .where((eb) => eb.or([
        eb("last_probe_at", "is", null),
        eb("last_probe_at", "<=", staleBefore),
      ]))
      .returning(["id", "last_probe_at"])
      .executeTakeFirst();
    return acquired?.last_probe_at
      ? { resourceId: acquired.id, acquiredAt: acquired.last_probe_at }
      : null;
  }

  async releaseHalfOpenProbe(resourceId: string, acquiredAt: Date): Promise<void> {
    await this.db
      .updateTable("provider_resource")
      .set({ last_probe_at: null, updated_at: new Date() })
      .where("id", "=", resourceId)
      .where("last_probe_at", "=", acquiredAt)
      .execute();
  }

  /** 被动请求成功 → 失败计数清零 / 半开探测成功降级恢复。 */
  async recordSuccess(resourceId: string): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", resourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const transition = deriveSuccessTransition(toRuntimeState(row));
      if (!transition) return null;
      await this.applyTransitionTx(trx, row, transition, null, "system");
      return transition;
    });
  }

  /** 厂商额度接口确认凭证有效且所有已知窗口均有余量后，自动解除隔离。 */
  async recordQuotaSyncRecovery(
    resourceId: string,
  ): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("provider_resource")
        .selectAll().where("id", "=", resourceId).forUpdate().executeTakeFirstOrThrow();
      const transition = deriveQuotaSyncRecovery(toRuntimeState(row));
      if (!transition) return null;
      await trx.updateTable("provider_resource").set({
        credential_refresh_status: "OK",
        refresh_error_classification: null,
        updated_at: new Date(),
      }).where("id", "=", resourceId).execute();
      await this.applyTransitionTx(trx, row, transition, null, "system");
      const provider = await trx.selectFrom("provider").select("code")
        .where("enterprise_id", "=", row.enterprise_id)
        .where("id", "=", row.provider_id)
        .executeTakeFirstOrThrow();
      const [poolPrincipals, assignmentPrincipals, manualPrincipals] = await Promise.all([
        trx.selectFrom("principal_grant").select("principal_id")
          .where("enterprise_id", "=", row.enterprise_id)
          .where("provider", "=", provider.code)
          .where("status", "=", "ACTIVE")
          .execute(),
        trx.selectFrom("employee_model_rule_assignment").select("principal_id")
          .where("enterprise_id", "=", row.enterprise_id)
          .where("provider_resource_id", "=", resourceId)
          .where("status", "=", "ACTIVE")
          .execute(),
        trx.selectFrom("principal_model_manual_authorization")
          .innerJoin("model_route", (join) => join
            .onRef("model_route.enterprise_id", "=", "principal_model_manual_authorization.enterprise_id")
            .onRef("model_route.unified_model_id", "=", "principal_model_manual_authorization.unified_model_id"))
          .select("principal_model_manual_authorization.principal_id")
          .where("principal_model_manual_authorization.enterprise_id", "=", row.enterprise_id)
          .where("model_route.provider_resource_id", "=", resourceId)
          .execute(),
      ]);
      const principalIds = [...new Set([
        ...poolPrincipals.map((item) => item.principal_id),
        ...assignmentPrincipals.map((item) => item.principal_id),
        ...manualPrincipals.map((item) => item.principal_id),
      ])].sort((left, right) => left.localeCompare(right, "en"));
      for (const principalId of principalIds) {
        await refreshEmployeeKeyModels(trx, row.enterprise_id, principalId);
      }
      return transition;
    });
  }

  /** API 厂商余额快照确认恢复后，解除 EXHAUSTED 硬隔离并等待真实请求确认。 */
  async recordBalanceSyncRecovery(
    resourceId: string, operatingSnapshotId: string,
  ): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("provider_resource")
        .selectAll().where("id", "=", resourceId).forUpdate().executeTakeFirstOrThrow();
      const transition = deriveBalanceSyncRecovery(toRuntimeState(row));
      if (!transition) return null;
      const evidence = await trx.selectFrom("provider_resource_operating_snapshot")
        .select("id").where("id", "=", operatingSnapshotId)
        .where("enterprise_id", "=", row.enterprise_id)
        .where("provider_resource_id", "=", row.id)
        .where("source", "=", "PROVIDER_SYNC")
        .where("provider_balance_available", "=", true)
        .where("balance_source", "=", "PROVIDER_API")
        .where("current_balance", ">", "0")
        .where("collected_at", ">", row.updated_at).executeTakeFirst();
      if (!evidence) return null;
      await this.applyTransitionTx(trx, row, transition, null, "system");
      return transition;
    });
  }

  /** 隔离资源额度仍未恢复或同步失败时，只安排下一次检查，不改变隔离原因。 */
  async scheduleQuotaSync(
    resourceId: string,
    nextCheckAt: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    const updated = await this.db.updateTable("provider_resource")
      .set({ cooldown_until: nextCheckAt, updated_at: now })
      .where("id", "=", resourceId)
      .where("status", "in", [
        RESOURCE_STATUS.RATE_LIMITED,
        RESOURCE_STATUS.EXHAUSTED,
        RESOURCE_STATUS.CREDENTIAL_INVALID,
      ])
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  /** 凭证到期检查（WT-19）：到期则迁移 EXPIRED。 */
  async checkCredentialExpiry(resourceId: string, now: Date = new Date()): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", resourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const transition = deriveCredentialExpiry(
        toRuntimeState(row),
        row.credential_expires_at ? row.credential_expires_at.getTime() : null,
        now.getTime(),
      );
      if (!transition) return null;
      await this.applyTransitionTx(trx, row, transition, null, "system");
      return transition;
    });
  }

  /** 刷新失败 → 隔离 + 刷新状态落库（WT-19：仅隔离对应资源）。 */
  async recordRefreshFailure(
    resourceId: string,
    errorClassification: string,
    now: Date = new Date(),
  ): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", resourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const transition = deriveRefreshFailure(toRuntimeState(row));
      await trx
        .updateTable("provider_resource")
        .set({
          credential_refresh_status: "FAILED",
          refresh_error_classification: errorClassification,
          last_refresh_at: now,
          updated_at: now,
        })
        .where("id", "=", resourceId)
        .execute();
      if (!transition) return null;
      await this.applyTransitionTx(trx, row, transition, errorClassification, "system");
      return transition;
    });
  }

  /**
   * 人工受控恢复（WT-19：重新授权/充值后）。
   * 仅隔离态可恢复；同时可选更新凭证版本/过期时间（新凭证已就位的事实）。
   */
  async adminRecover(
    resourceId: string,
    opts?: { credentialVersion?: number; credentialExpiresAt?: Date | null },
    now: Date = new Date(),
  ): Promise<StateTransition | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", resourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const transition = deriveAdminRecovery(toRuntimeState(row));
      if (!transition) return null;
      await trx
        .updateTable("provider_resource")
        .set({
          credential_refresh_status: "OK",
          refresh_error_classification: null,
          ...(opts?.credentialVersion !== undefined ? { credential_version: opts.credentialVersion } : {}),
          ...(opts?.credentialExpiresAt !== undefined ? { credential_expires_at: opts.credentialExpiresAt } : {}),
          updated_at: now,
        })
        .where("id", "=", resourceId)
        .execute();
      await this.applyTransitionTx(trx, row, transition, null, "admin");
      return transition;
    });
  }

  /** 状态迁移落库：status/字段更新 + 审计事件（调用方须在事务内）。 */
  private async applyTransitionTx(
    trx: Kysely<Database>,
    row: ProviderResourceRow,
    transition: StateTransition,
    errorClassification: string | null,
    actor: "system" | "admin",
  ): Promise<void> {
    const now = new Date();
    await trx
      .updateTable("provider_resource")
      .set({
        status: transition.toStatus,
        consecutive_failures: transition.consecutiveFailures,
        cooldown_until: transition.cooldownUntil ? new Date(transition.cooldownUntil) : null,
        last_probe_at: null,
        updated_at: now,
      })
      .where("id", "=", row.id)
      .execute();
    await trx
      .insertInto("resource_status_event")
      .values({
        enterprise_id: row.enterprise_id,
        provider_resource_id: row.id,
        from_status: row.status,
        to_status: transition.toStatus,
        reason: transition.reason,
        error_classification: errorClassification,
        consecutive_failures: transition.consecutiveFailures,
        cooldown_until: transition.cooldownUntil ? new Date(transition.cooldownUntil) : null,
        actor,
        created_at: now,
      })
      .execute();
  }

  /**
   * 可服务资源硬过滤（WT-07 同池选择；W12 评分在此之后）。
   * 规则：ACTIVE/DEGRADED 直接可服务；UNAVAILABLE 且冷却到期 → 半开探测；
   * 终态隔离（CREDENTIAL_INVALID/EXHAUSTED/EXPIRED）与冷却中 UNAVAILABLE 排除。
   */
  async listServableResources(
    enterpriseId: string,
    poolId?: string,
    now: Date = new Date(),
  ): Promise<ServableResource[]> {
    let query = this.db
      .selectFrom("provider_resource")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId);
    if (poolId !== undefined) {
      query = query.where("resource_pool_id", "=", poolId);
    }
    const rows = await query.execute();
    const servable: ServableResource[] = [];
    for (const row of rows) {
      const admission = evaluateAdmission(toRuntimeState(row), now.getTime());
      if (!admission.admit) continue;
      servable.push({
        id: row.id,
        enterpriseId: row.enterprise_id,
        providerId: row.provider_id,
        resourcePoolId: row.resource_pool_id,
        mode: row.mode,
        status: row.status as ResourceStatus,
        probe: admission.probe,
      });
    }
    return servable;
  }

  /** 资源的状态迁移审计轨迹（WT-19 隔离/恢复留痕核查）。 */
  async listStatusEvents(resourceId: string): Promise<ResourceStatusEvent[]> {
    return this.db
      .selectFrom("resource_status_event")
      .selectAll()
      .where("provider_resource_id", "=", resourceId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
  }
}

export { RESOURCE_STATUS };
