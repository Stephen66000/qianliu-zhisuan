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

/** 四告警域（PRD §11）。 */
export type AlertDomain =
  | "RESOURCE_UNAVAILABLE"
  | "USAGE_SPIKE"
  | "QUOTA_ANOMALY"
  | "CREDENTIAL_INVALID";

export interface AlertEvent {
  id: string;
  alertKey: string;
  domain: AlertDomain;
  signal: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string | null;
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
  status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "IGNORED" | "AUTO_RESOLVED";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** 派生候选（评估一次得到的"当前应为 OPEN 的告警"）。 */
interface DerivedAlert {
  alertKey: string;
  domain: AlertDomain;
  signal: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string;
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
}

export interface AlertThresholds {
  /** 提前耗尽覆盖时长阈值（小时）。 */
  exhaustCoverageHours: number;
  /** 用量突增费用阈值（元）。 */
  usageSpikeCost: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  exhaustCoverageHours: 24,
  usageSpikeCost: 100,
};

const ISOLATED = new Set(["CREDENTIAL_INVALID", "EXHAUSTED", "EXPIRED", "UNAVAILABLE"]);

export class AlertEventRepository {
  constructor(
    private db: import("kysely").Kysely<import("../kysely.js").Database>,
    private thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
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

    // 取当前 OPEN/INVESTIGATING 事件
    const openEvents = await this.db
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "in", ["OPEN", "INVESTIGATING"])
      .execute();

    const openByKey = new Map(openEvents.map((e) => [e.alert_key, e]));

    // upsert 派生的告警
    for (const d of derived) {
      const existing = openByKey.get(d.alertKey);
      if (existing) {
        await this.db
          .updateTable("alert_event")
          .set({
            last_seen_at: new Date(),
            title: d.title,
            detail: d.detail,
            severity: d.severity,
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
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
          .execute();
      }
    }

    // 源已恢复 → AUTO_RESOLVED（保留历史，不再出现在未处理列表）
    for (const e of openEvents) {
      if (!derivedKeys.has(e.alert_key)) {
        await this.db
          .updateTable("alert_event")
          .set({ status: "AUTO_RESOLVED", resolved_at: new Date() })
          .where("id", "=", e.id)
          .execute();
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
    return rows.map((r) => this.toEvent(r));
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
    out.push(...(await this.deriveUsageSpike(enterpriseId)));
    out.push(...(await this.deriveCredential(enterpriseId)));
    return out;
  }

  /** 域1：资源降级 + 提前耗尽（按【最新】快照）。 */
  private async deriveResource(enterpriseId: string): Promise<DerivedAlert[]> {
    const out: DerivedAlert[] = [];
    const resources = await this.db
      .selectFrom("provider_resource")
      .select(["id", "name", "status"])
      .where("enterprise_id", "=", enterpriseId)
      .execute();
    for (const r of resources) {
      if (r.status === "DEGRADED") {
        out.push({
          alertKey: `RESOURCE_UNAVAILABLE:degraded:${r.id}`,
          domain: "RESOURCE_UNAVAILABLE",
          signal: "resource_degraded",
          severity: "MEDIUM",
          title: `资源降级：${r.name}`,
          detail: "资源处于降级观察态，可能部分不可用",
          resourceId: r.id,
          principalId: null,
          aiRequestId: null,
        });
      }
    }
    // 提前耗尽：每个资源只取最新快照（snapshot_at 最大）
    const forecasts = await this.db
      .selectFrom("supply_forecast")
      .innerJoin("provider_resource", "provider_resource.id", "supply_forecast.provider_resource_id")
      .select([
        "supply_forecast.provider_resource_id",
        "provider_resource.name as resource_name",
        "supply_forecast.coverage_hours",
        "supply_forecast.forecast_exhaust_at",
        "supply_forecast.snapshot_at",
      ])
      .where("supply_forecast.enterprise_id", "=", enterpriseId)
      .where("supply_forecast.forecast_exhaust_at", "is not", null)
      .orderBy("supply_forecast.snapshot_at", "desc")
      .execute();
    const latestByResource = new Map<string, (typeof forecasts)[number]>();
    for (const f of forecasts) {
      if (!latestByResource.has(f.provider_resource_id)) {
        latestByResource.set(f.provider_resource_id, f);
      }
    }
    for (const f of latestByResource.values()) {
      const coverage = f.coverage_hours === null ? null : Number(f.coverage_hours);
      if (coverage !== null && coverage < this.thresholds.exhaustCoverageHours) {
        out.push({
          alertKey: `RESOURCE_UNAVAILABLE:exhaust:${f.provider_resource_id}`,
          domain: "RESOURCE_UNAVAILABLE",
          signal: "forecast_exhaust",
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

  /** 域2：主体当月费用超阈值（阈值配置化）。 */
  private async deriveUsageSpike(enterpriseId: string): Promise<DerivedAlert[]> {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const rows = await this.db
      .selectFrom("ledger_transaction")
      .select(["principal_id", (eb) => eb.fn.sum("total_api_cost").as("monthly_cost")])
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
          signal: "usage_cost_spike",
          severity: "MEDIUM",
          title: "主体费用异常增长",
          detail: `当月 API 费用 ${cost.toFixed(2)} 元，超过阈值 ${this.thresholds.usageSpikeCost} 元`,
          resourceId: null,
          principalId: r.principal_id,
          aiRequestId: null,
        });
      }
    }
    return out;
  }

  /** 域4：凭证失效/隔离态。 */
  private async deriveCredential(enterpriseId: string): Promise<DerivedAlert[]> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .select(["id", "name", "status", "refresh_error_classification"])
      .where("enterprise_id", "=", enterpriseId)
      .execute();
    const out: DerivedAlert[] = [];
    for (const r of resources) {
      if (ISOLATED.has(r.status)) {
        out.push({
          alertKey: `CREDENTIAL_INVALID:${r.status}:${r.id}`,
          domain: "CREDENTIAL_INVALID",
          signal: "credential_invalid",
          severity: "HIGH",
          title: `凭证失效：${r.name}`,
          detail: `资源状态 ${r.status}${r.refresh_error_classification ? `（${r.refresh_error_classification}）` : ""}，需重新授权后受控恢复（WT-19）`,
          resourceId: r.id,
          principalId: null,
          aiRequestId: null,
        });
      }
    }
    return out;
  }

  private toEvent(r: {
    id: string;
    alert_key: string;
    domain: string;
    signal: string;
    severity: string;
    title: string;
    detail: string | null;
    resource_id: string | null;
    principal_id: string | null;
    ai_request_id: string | null;
    status: string;
    first_seen_at: Date;
    last_seen_at: Date;
    resolved_at: Date | null;
    resolution_note: string | null;
  }): AlertEvent {
    return {
      id: r.id,
      alertKey: r.alert_key,
      domain: r.domain as AlertDomain,
      signal: r.signal,
      severity: r.severity as AlertEvent["severity"],
      title: r.title,
      detail: r.detail,
      resourceId: r.resource_id,
      principalId: r.principal_id,
      aiRequestId: r.ai_request_id,
      status: r.status as AlertEvent["status"],
      firstSeenAt: r.first_seen_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
      resolutionNote: r.resolution_note,
    };
  }
}
