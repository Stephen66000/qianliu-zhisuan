/**
 * 告警事实仓储（P1-05 整改）—— 独立 alert_event 表，生命周期 + 幂等 + 历史。
 *
 * 依据：TRD §13（八类技术信号归并四告警域；阈值由配置管理；告警写入 alert_event）。
 *
 * 与旧实现的区别（双审 P1-05 驳回点）：
 *   - 不再复用 reconciliation_discrepancy（语义污染对账）；
 *   - 每次评估写入/更新 alert_event（事实持久化），源恢复 → AUTO_RESOLVED（保留历史）；
 *   - 唯一键 (enterprise_id, alert_key) WHERE status='OPEN' 保证活跃告警幂等；
 *   - 提前耗尽按【最新】supply_forecast 快照判定（旧实现读全部快照会报陈旧告警）；
 *   - 阈值由构造参数注入（配置管理，不硬编码）。
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { deriveDepartmentBudgetAlerts } from "./alert-event-department-budget.js";
import {
  deriveCallDeductionAlerts,
  deriveCredentialAlerts,
} from "./alert-event-operational-derivations.js";
import { decimalTextsEqual } from "./dashboard-helpers.js";
import { ProviderRepository } from "./provider-repository.js";
import {
  deriveDispatchAlerts,
  deriveRoutingAlerts,
  deriveStreamingAlerts,
  toAlertEvent,
} from "./alert-event-request-derivations.js";
import {
  DEFAULT_THRESHOLDS,
  type AlertEvent,
  type AlertThresholds,
  type DerivedAlert,
} from "./alert-event-types.js";

export type {
  AlertDomain,
  AlertEvent,
  AlertThresholds,
  DerivedAlert,
} from "./alert-event-types.js";
export { DEFAULT_THRESHOLDS } from "./alert-event-types.js";

const RESOURCE_UNAVAILABLE_STATES = new Set([
  "DEGRADED",
  "EXHAUSTED",
  "RATE_LIMITED",
  "UNAVAILABLE",
]);

export class AlertEventRepository {
  constructor(
    private db: Kysely<Database>,
    private thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
    private includeDepartmentBudget = false,
  ) {}

  /**
   * 评估并落库（幂等）：
   *   1. 派生当前应为 OPEN 的告警集合；
   *   2.  upsert：已存在 OPEN 同 key → 刷新 last_seen；不存在 → 插入；
   *   3. 之前 OPEN 但本次未派生 → AUTO_RESOLVED（源已恢复，保留历史）。
   * 返回当前 OPEN + INVESTIGATING（看板"未处理"）。
   */
  async evaluate(enterpriseId: string): Promise<AlertEvent[]> {
    const derived = await this.derive(enterpriseId);
    const derivedKeys = new Set(derived.map((d) => d.alertKey));

    // 取全部事件并按 key 选最新一条：终态事件也用于抑制“源仍异常时立即重开”。
    const events = await this.db
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("last_seen_at", "desc")
      .execute();
    const latestByKey = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (!latestByKey.has(event.alert_key))
        latestByKey.set(event.alert_key, event);
    }

    // upsert 派生的告警
    for (const d of derived) {
      const existing = latestByKey.get(d.alertKey);
      const isActive =
        existing?.status === "OPEN" || existing?.status === "INVESTIGATING";
      if (existing && isActive) {
        await this.db
          .updateTable("alert_event")
          .set({
            last_seen_at: new Date(),
            domain: d.domain,
            signal: d.signal,
            title: d.title,
            detail: d.detail,
            severity: d.severity,
            resource_id: d.resourceId,
            principal_id: d.principalId,
            ai_request_id: d.aiRequestId,
          })
          .where("id", "=", existing.id)
          .execute();
      } else if (existing && existing.source_cleared_at === null) {
        // 管理员已处置，但源事实仍异常：刷新 last_seen，不能立即重开同 key。
        await this.db
          .updateTable("alert_event")
          .set({
            last_seen_at: new Date(),
            domain: d.domain,
            signal: d.signal,
            title: d.title,
            detail: d.detail,
            severity: d.severity,
            resource_id: d.resourceId,
            principal_id: d.principalId,
            ai_request_id: d.aiRequestId,
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        const now = new Date();
        await this.db
          .insertInto("alert_event")
          .values({
            enterprise_id: enterpriseId,
            alert_key: d.alertKey,
            domain: d.domain,
            signal: d.signal,
            severity: d.severity,
            title: d.title,
            detail: d.detail,
            resource_id: d.resourceId,
            principal_id: d.principalId,
            ai_request_id: d.aiRequestId,
            status: "OPEN",
          })
          .onConflict((oc) =>
            oc
              .columns(["enterprise_id", "alert_key"])
              .where("status", "=", "OPEN")
              .doUpdateSet({
                last_seen_at: now,
                domain: d.domain,
                signal: d.signal,
                severity: d.severity,
                title: d.title,
                detail: d.detail,
              }),
          )
          .execute();
      }
    }

    // 源已恢复 → AUTO_RESOLVED（保留历史，不再出现在未处理列表）
    for (const e of latestByKey.values()) {
      if (!derivedKeys.has(e.alert_key)) {
        const sourceClearedAt = new Date();
        if (e.status === "OPEN" || e.status === "INVESTIGATING") {
          await this.db
            .updateTable("alert_event")
            .set({
              status: "AUTO_RESOLVED",
              resolved_at: sourceClearedAt,
              source_cleared_at: sourceClearedAt,
            })
            .where("id", "=", e.id)
            .execute();
        } else if (e.source_cleared_at === null) {
          await this.db
            .updateTable("alert_event")
            .set({ source_cleared_at: sourceClearedAt })
            .where("id", "=", e.id)
            .execute();
        }
      }
    }

    return this.list(enterpriseId, ["OPEN", "INVESTIGATING"]);
  }

  /** 列表（看板）：默认未处理；includeHistory=true 时含已处理历史。 */
  async list(
    enterpriseId: string,
    statuses: Array<AlertEvent["status"]> = ["OPEN", "INVESTIGATING"],
  ): Promise<AlertEvent[]> {
    const rows = await this.db
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "in", statuses)
      .orderBy("last_seen_at", "desc")
      .execute();
    return rows.map(toAlertEvent);
  }

  /** 历史（含已处理/已忽略/自动恢复）。 */
  async listHistory(enterpriseId: string): Promise<AlertEvent[]> {
    return this.list(enterpriseId, ["RESOLVED", "IGNORED", "AUTO_RESOLVED"]);
  }

  /** 处置（标记已处理/忽略/处理中）。 */
  async setDisposition(
    enterpriseId: string,
    alertKey: string,
    status: "INVESTIGATING" | "RESOLVED" | "IGNORED",
    resolutionNote: string | undefined,
    resolvedBy: string,
  ): Promise<boolean> {
    const resolved = status === "RESOLVED" || status === "IGNORED";
    const result = await this.db
      .updateTable("alert_event")
      .set({
        status,
        resolution_note: resolutionNote ?? null,
        resolved_at: resolved ? new Date() : null,
        resolved_by: resolvedBy,
      })
      .where("enterprise_id", "=", enterpriseId)
      .where("alert_key", "=", alertKey)
      .where("status", "in", ["OPEN", "INVESTIGATING"])
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  /** 派生当前应为 OPEN 的告警（不落库，evaluate 内调用）。 */
  private async derive(enterpriseId: string): Promise<DerivedAlert[]> {
    const out: DerivedAlert[] = [];
    out.push(...(await this.deriveResource(enterpriseId)));
    out.push(...(await this.derivePrincipalUsage(enterpriseId)));
    out.push(...(await deriveCallDeductionAlerts(this.db, enterpriseId)));
    out.push(...(await deriveCredentialAlerts(this.db, enterpriseId)));
    out.push(...(await deriveRoutingAlerts(this.db, enterpriseId)));
    out.push(...(await deriveStreamingAlerts(this.db, enterpriseId)));
    out.push(...(await deriveDispatchAlerts(this.db, enterpriseId)));
    if (this.includeDepartmentBudget) {
      out.push(...(await deriveDepartmentBudgetAlerts(this.db, enterpriseId)));
    }
    return out;
  }

  /** 信号 1 + 7：资源不可用、供给异常（按【最新】预测快照）。 */
  private async deriveResource(enterpriseId: string): Promise<DerivedAlert[]> {
    const out: DerivedAlert[] = [];
    const resources = await this.db
      .selectFrom("provider_resource")
      .select(["id", "name", "status", "consecutive_failures"])
      .where("enterprise_id", "=", enterpriseId)
      .execute();
    for (const r of resources) {
      if (
        RESOURCE_UNAVAILABLE_STATES.has(r.status) ||
        r.consecutive_failures >= this.thresholds.resourceFailureCount
      ) {
        out.push({
          alertKey: `RESOURCE_UNAVAILABLE:resource:${r.id}`,
          domain: "RESOURCE_UNAVAILABLE",
          signal: "resource_unavailable",
          severity: "MEDIUM",
          title: `资源不可用：${r.name}`,
          detail: `资源状态 ${r.status}，连续失败 ${r.consecutive_failures} 次`,
          resourceId: r.id,
          principalId: null,
          aiRequestId: null,
        });
      }
    }
    // 提前耗尽：每个资源只取最新快照（snapshot_at 最大）
    const forecasts = await sql<{
      provider_resource_id: string;
      resource_name: string;
      mode: string;
      coverage_hours: string | null;
      forecast_exhaust_at: Date | null;
      snapshot_at: Date;
      remaining_quota: string;
    }>`
      WITH latest AS (
        SELECT DISTINCT ON (provider_resource_id) *
          FROM supply_forecast
         WHERE enterprise_id = ${enterpriseId}
         ORDER BY provider_resource_id, snapshot_at DESC
      )
      SELECT f.provider_resource_id, pr.name AS resource_name, pr.mode,
             f.coverage_hours, f.forecast_exhaust_at, f.snapshot_at,
             f.remaining_quota
        FROM latest f
        JOIN provider_resource pr ON pr.id = f.provider_resource_id
       WHERE pr.enterprise_id = ${enterpriseId}
         AND f.forecast_exhaust_at IS NOT NULL
    `.execute(this.db);
    const current = new Map(
      (
        await new ProviderRepository(this.db).listCurrentOperatingSnapshots(
          enterpriseId,
        )
      ).map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    const latestByResource = new Map<string, (typeof forecasts.rows)[number]>();
    for (const f of forecasts.rows) {
      const snapshot = current.get(f.provider_resource_id);
      const remaining =
        f.mode === "API"
          ? (snapshot?.current_balance ?? null)
          : (snapshot?.remaining_quota ?? null);
      if (
        snapshot &&
        f.snapshot_at >= snapshot.calculated_at &&
        decimalTextsEqual(f.remaining_quota, remaining)
      ) {
        latestByResource.set(f.provider_resource_id, f);
      }
    }
    for (const f of latestByResource.values()) {
      const coverage =
        f.coverage_hours === null ? null : Number(f.coverage_hours);
      if (
        coverage !== null &&
        coverage < this.thresholds.exhaustCoverageHours
      ) {
        out.push({
          alertKey: `RESOURCE_UNAVAILABLE:exhaust:${f.provider_resource_id}`,
          domain: "RESOURCE_UNAVAILABLE",
          signal: "supply_anomaly",
          severity: "HIGH",
          title: `预计提前耗尽：${f.resource_name}`,
          detail: `覆盖时长 ${coverage}h（阈值 ${this.thresholds.exhaustCoverageHours}h），预计 ${f.forecast_exhaust_at?.toISOString() ?? "未知"} 耗尽`,
          resourceId: f.provider_resource_id,
          principalId: null,
          aiRequestId: null,
        });
      }
    }
    return out;
  }

  /** 信号 2：主体额度、超额或费用异常。 */
  private async derivePrincipalUsage(
    enterpriseId: string,
  ): Promise<DerivedAlert[]> {
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    const rows = await this.db
      .selectFrom("ledger_transaction")
      .select([
        "principal_id",
        (eb) => eb.fn.sum("total_api_cost").as("monthly_cost"),
      ])
      .where("enterprise_id", "=", enterpriseId)
      .where("created_at", ">=", monthStart)
      .groupBy("principal_id")
      .execute();
    const out: DerivedAlert[] = [];
    for (const r of rows) {
      const cost = Number(r.monthly_cost);
      if (Number.isFinite(cost) && cost > this.thresholds.usageSpikeCost) {
        out.push({
          alertKey: `USAGE_SPIKE:cost:${r.principal_id}`,
          domain: "USAGE_SPIKE",
          signal: "principal_usage_anomaly",
          severity: "MEDIUM",
          title: "主体费用异常增长",
          detail: `当月 API 费用 ${cost.toFixed(2)} 元，超过阈值 ${this.thresholds.usageSpikeCost} 元`,
          resourceId: null,
          principalId: r.principal_id,
          aiRequestId: null,
        });
      }
    }
    const quotas = await this.db
      .selectFrom("principal_grant")
      .innerJoin(
        "quota_counter",
        "quota_counter.grant_id",
        "principal_grant.id",
      )
      .select([
        "principal_grant.id as grant_id",
        "principal_grant.principal_id",
        "principal_grant.quota_value",
        "quota_counter.used_value",
        "quota_counter.overage_value",
      ])
      .where("principal_grant.enterprise_id", "=", enterpriseId)
      .where("principal_grant.status", "=", "ACTIVE")
      .execute();
    for (const q of quotas) {
      const quotaValue = BigInt(q.quota_value);
      const usedValue = BigInt(q.used_value);
      const overageValue = BigInt(q.overage_value);
      const ratio =
        quotaValue === 0n
          ? usedValue > 0n
            ? 1
            : 0
          : Number((usedValue * 10_000n) / quotaValue) / 10_000;
      if (overageValue > 0n || ratio >= this.thresholds.principalQuotaRatio) {
        out.push({
          alertKey: `USAGE_SPIKE:quota:${q.grant_id}`,
          domain: "USAGE_SPIKE",
          signal: "principal_usage_anomaly",
          severity: overageValue > 0n ? "HIGH" : "MEDIUM",
          title: "主体额度使用异常",
          detail: `额度使用率 ${(ratio * 100).toFixed(1)}%，超额 ${overageValue.toString()}`,
          resourceId: null,
          principalId: q.principal_id,
          aiRequestId: null,
        });
      }
    }
    return out;
  }
}
