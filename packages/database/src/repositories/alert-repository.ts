/**
 * 异常告警仓储（W20）—— 四告警域派生视图 + 处置状态复用 discrepancy 状态机。
 *
 * 依据：PRD §11（四告警域 + 可标记已处理，一期只在管理后台展示）。
 *
 * 设计（Evidence 记录决策）：
 *   - 不新建 alert 表。告警是对既有事实的实时判定（派生视图），保证与源事实零漂移：
 *       域1 厂商/模型不可用、提前耗尽 → provider_resource.status + supply_forecast；
 *       域2 主体用量/费用突增 → ledger_transaction 当前自然月聚合（阈值判定在路由层配置）；
 *       域3 限流/拒绝/额度扣减异常 → reconciliation_discrepancy（OPEN）；
 *       域4 凭证失效/非预期使用 → provider_resource.credential_* 状态。
 *   - "标记已处理"复用 reconciliation_discrepancy 状态机（OPEN/INVESTIGATING/RESOLVED/IGNORED）。
 *     派生告警用稳定 alert_key（domain:entity_id）作为处置记录载体，
 *     落在同一表但 reconciliation_run_id 为 NULL（非对账来源）。
 *   - 语义：标记已处理只抑制展示，不删源事实；告警条件仍在时未处理的会再出现
 *     （不能"标记掉"一个仍然失效的凭证）。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";

/** 告警域（PRD §11）。 */
export type AlertDomain =
  | "RESOURCE_UNAVAILABLE" // 域1：厂商/模型不可用、错误率升高、提前耗尽
  | "USAGE_SPIKE" // 域2：主体用量/费用突增
  | "QUOTA_ANOMALY" // 域3：限流/拒绝/额度扣减异常
  | "CREDENTIAL_INVALID"; // 域4：凭证失效/非预期使用

export interface AlertItem {
  /** 稳定派生键（domain:entity_id），处置记录载体。 */
  alertKey: string;
  domain: AlertDomain;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string;
  /** 关联对象（用于追踪到请求/资源）。 */
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
  /** 处置状态（来自 discrepancy 状态机；无记录 = OPEN）。 */
  status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "IGNORED";
  /** 处置记录 id（用于标记已处理；无记录 = null，首次标记时创建）。 */
  dispositionId: string | null;
}

const ISOLATED_STATUSES = ["CREDENTIAL_INVALID", "EXHAUSTED", "EXPIRED", "UNAVAILABLE"];

export class AlertRepository {
  constructor(private db: Kysely<Database>) {}

  /** 派生四域告警（实时判定）+ 合并处置状态。 */
  async listAlerts(enterpriseId: string): Promise<AlertItem[]> {
    const [resourceAlerts, spikeAlerts, discrepancyAlerts, credentialAlerts] =
      await Promise.all([
        this.deriveResourceAlerts(enterpriseId),
        this.deriveUsageSpikeAlerts(enterpriseId),
        this.deriveDiscrepancyAlerts(enterpriseId),
        this.deriveCredentialAlerts(enterpriseId),
      ]);

    const derived = [
      ...resourceAlerts,
      ...spikeAlerts,
      ...discrepancyAlerts,
      ...credentialAlerts,
    ];

    // 合并处置状态（alert_key → disposition）
    const dispositions = await this.db
      .selectFrom("reconciliation_discrepancy")
      .select(["id", "discrepancy_type", "ai_request_id", "status", "detail"])
      .where("enterprise_id", "=", enterpriseId)
      .where(sql`detail->>'alert_key'`, "is not", null)
      .execute();

    const dispositionByKey = new Map<string, { id: string; status: AlertItem["status"] }>();
    for (const d of dispositions) {
      const key = (d.detail as Record<string, unknown> | null)?.["alert_key"];
      if (typeof key === "string") {
        dispositionByKey.set(key, {
          id: d.id,
          status: d.status as AlertItem["status"],
        });
      }
    }

    return derived.map((alert) => {
      const disposition = dispositionByKey.get(alert.alertKey);
      return {
        ...alert,
        status: disposition?.status ?? "OPEN",
        dispositionId: disposition?.id ?? null,
      };
    });
  }

  /**
   * 标记告警已处理。派生告警首次标记时创建处置记录。
   * discrepancy.reconciliation_run_id 必填——派生告警处置挂在一个每企业一次性创建的
   * sentinel 对账 run（result=PASS，标记 algorithm_version=alert_disposition）下，
   * 避免改动表结构/新增迁移。
   */
  async setDisposition(
    enterpriseId: string,
    alertKey: string,
    domain: AlertDomain,
    status: "INVESTIGATING" | "RESOLVED" | "IGNORED",
    resolutionNote: string | undefined,
    aiRequestId: string | null,
  ): Promise<void> {
    const existing = await this.db
      .selectFrom("reconciliation_discrepancy")
      .select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where(sql`detail->>'alert_key'`, "=", alertKey)
      .executeTakeFirst();

    const resolvedAt = status === "RESOLVED" || status === "IGNORED" ? new Date() : null;

    if (existing) {
      await this.db
        .updateTable("reconciliation_discrepancy")
        .set({ status, resolution_note: resolutionNote ?? null, resolved_at: resolvedAt })
        .where("id", "=", existing.id)
        .execute();
      return;
    }

    const sentinelRunId = await this.ensureSentinelRun(enterpriseId);
    await this.db
      .insertInto("reconciliation_discrepancy")
      .values({
        enterprise_id: enterpriseId,
        reconciliation_run_id: sentinelRunId,
        discrepancy_type: domain,
        ai_request_id: aiRequestId,
        detail: { alert_key: alertKey },
        severity: "MEDIUM",
        status,
        resolution_note: resolutionNote ?? null,
        resolved_at: resolvedAt,
      })
      .execute();
  }

  /** 每企业一个 sentinel run（派生告警处置的挂载点），幂等获取或创建。 */
  private async ensureSentinelRun(enterpriseId: string): Promise<string> {
    const existing = await this.db
      .selectFrom("reconciliation_run")
      .select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("algorithm_version", "=", "alert_disposition")
      .executeTakeFirst();
    if (existing) {
      return existing.id;
    }
    const now = new Date();
    const run = await this.db
      .insertInto("reconciliation_run")
      .values({
        enterprise_id: enterpriseId,
        range_from: now,
        range_to: now,
        result: "PASS",
        algorithm_version: "alert_disposition",
        finished_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return run.id;
  }

  /** 域1：资源不可用 / 提前耗尽（DEGRADED 或隔离态 + 预测覆盖时长不足）。 */
  private async deriveResourceAlerts(enterpriseId: string): Promise<AlertItem[]> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .select(["id", "name", "status"])
      .where("enterprise_id", "=", enterpriseId)
      .execute();

    const alerts: AlertItem[] = [];
    for (const r of resources) {
      if (r.status === "DEGRADED") {
        alerts.push({
          alertKey: `RESOURCE_UNAVAILABLE:${r.id}:degraded`,
          domain: "RESOURCE_UNAVAILABLE",
          severity: "MEDIUM",
          title: `资源降级：${r.name}`,
          detail: "资源处于降级观察态，可能部分不可用",
          resourceId: r.id,
          principalId: null,
          aiRequestId: null,
          status: "OPEN",
          dispositionId: null,
        });
      }
    }

    // 提前耗尽：supply_forecast 覆盖时长 < 24h 且可计算（resource_name 需 join provider_resource）
    const forecasts = await this.db
      .selectFrom("supply_forecast")
      .innerJoin(
        "provider_resource",
        "provider_resource.id",
        "supply_forecast.provider_resource_id",
      )
      .select([
        "supply_forecast.provider_resource_id",
        "provider_resource.name as resource_name",
        "supply_forecast.coverage_hours",
        "supply_forecast.forecast_exhaust_at",
      ])
      .where("supply_forecast.enterprise_id", "=", enterpriseId)
      .where("supply_forecast.forecast_exhaust_at", "is not", null)
      .execute();
    for (const f of forecasts) {
      const coverage = f.coverage_hours === null ? null : Number(f.coverage_hours);
      if (coverage !== null && coverage < 24) {
        alerts.push({
          alertKey: `RESOURCE_UNAVAILABLE:${f.provider_resource_id}:exhaust`,
          domain: "RESOURCE_UNAVAILABLE",
          severity: "HIGH",
          title: `预计提前耗尽：${f.resource_name}`,
          detail: `覆盖时长 ${coverage}h，预计 ${f.forecast_exhaust_at?.toISOString() ?? "未知"} 耗尽`,
          resourceId: f.provider_resource_id,
          principalId: null,
          aiRequestId: null,
          status: "OPEN",
          dispositionId: null,
        });
      }
    }
    return alerts;
  }

  /** 域2：主体当月费用突增（> 阈值，阈值在路由层配置）。 */
  private async deriveUsageSpikeAlerts(enterpriseId: string): Promise<AlertItem[]> {
    // 当月各主体 API 费用聚合（仅展示层判定，不重算账本——读取后端已落账的 total_api_cost）
    const rows = await this.db
      .selectFrom("ledger_transaction")
      .select([
        "principal_id",
        (eb) => eb.fn.sum("total_api_cost").as("monthly_cost"),
      ])
      .where("enterprise_id", "=", enterpriseId)
      .where(
        "created_at",
        ">=",
        new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
      )
      .groupBy("principal_id")
      .execute();

    const alerts: AlertItem[] = [];
    for (const r of rows) {
      const cost = Number(r.monthly_cost);
      // 阈值判定（一期固定 100 元，后续可配置）：突增 = 当月费用异常偏高
      if (Number.isFinite(cost) && cost > 100) {
        alerts.push({
          alertKey: `USAGE_SPIKE:${r.principal_id}:cost`,
          domain: "USAGE_SPIKE",
          severity: "MEDIUM",
          title: "主体费用异常增长",
          detail: `当月 API 费用 ${cost.toFixed(2)} 元，超过阈值 100 元`,
          resourceId: null,
          principalId: r.principal_id,
          aiRequestId: null,
          status: "OPEN",
          dispositionId: null,
        });
      }
    }
    return alerts;
  }

  /** 域3：对账 OPEN 差异（额度扣减/账本异常）。 */
  private async deriveDiscrepancyAlerts(enterpriseId: string): Promise<AlertItem[]> {
    const rows = await this.db
      .selectFrom("reconciliation_discrepancy")
      .select(["id", "discrepancy_type", "ai_request_id", "severity", "status", "detail"])
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "OPEN")
      .where(sql`detail->>'alert_key'`, "is", null) // 只取对账来源（非派生处置记录）
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();

    return rows.map((r) => ({
      alertKey: `QUOTA_ANOMALY:${r.id}`,
      domain: "QUOTA_ANOMALY" as const,
      severity: (r.severity as AlertItem["severity"]) ?? "MEDIUM",
      title: `账本异常：${r.discrepancy_type}`,
      detail: "对账发现差异，需人工核查",
      resourceId: null,
      principalId: null,
      aiRequestId: r.ai_request_id,
      status: "OPEN" as const,
      dispositionId: r.id,
    }));
  }

  /** 域4：凭证失效 / 刷新失败。 */
  private async deriveCredentialAlerts(enterpriseId: string): Promise<AlertItem[]> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .select(["id", "name", "status", "credential_refresh_status", "refresh_error_classification"])
      .where("enterprise_id", "=", enterpriseId)
      .execute();

    const alerts: AlertItem[] = [];
    for (const r of resources) {
      if (ISOLATED_STATUSES.includes(r.status)) {
        alerts.push({
          alertKey: `CREDENTIAL_INVALID:${r.id}`,
          domain: "CREDENTIAL_INVALID",
          severity: "HIGH",
          title: `凭证失效：${r.name}`,
          detail: `资源状态 ${r.status}${r.refresh_error_classification ? `（${r.refresh_error_classification}）` : ""}，需重新授权后受控恢复（WT-19）`,
          resourceId: r.id,
          principalId: null,
          aiRequestId: null,
          status: "OPEN",
          dispositionId: null,
        });
      }
    }
    return alerts;
  }
}
