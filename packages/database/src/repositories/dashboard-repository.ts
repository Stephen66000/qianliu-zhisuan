/**
 * 首页看板聚合仓储（W18）—— 只读聚合，不在前端重算。
 *
 * 依据：PRD §10.2（首页看板核心指标）、TRD §12（首页口径，行 733-746）。
 *
 * 分层：
 *   - 本仓储：SQL 聚合查询（计数/求和/最早耗尽），口径在后端，前端只展示；
 *   - 前端：只读消费，不重算（M5 集成点约束，详细计划行 146）。
 *
 * 口径（TRD §12）：
 *   1. 资源账号数：当前企业未删除的资源账号数量；
 *   2. 本账期活跃人数：当月至少一次成功调用的、启用中（status=ACTIVE 且未归档）的 EMPLOYEE 数量；
 *   3. 当前正在使用人数：存在进行中请求或最近 5 分钟有成功请求的、启用中（status=ACTIVE 且未归档）的员工去重数；
 *   4. 本月套餐支出（按订阅录入时间归月）/ 5. 本月 API 已冻结账本费用 / 6. 本月充值金额；
 *   7. 预计最早耗尽：可计算资源中最早的 forecast_exhaust_at + 可信度 + 下一恢复时间；
 *   8. 本月调度节省：只汇总 dispatch_decision 中 saving_calculable=true 且动作已执行的节省值。
 *
 * 当前账期 = 企业自然月（月初 00:00 ~ 月末 23:59:59，按企业时区 UTC+8）。
 * 首页不计算同比、环比和用量增速（TRD §12 行 746）。
 *
 * POOL-010：厂商侧经营指标只取最新 provider_resource_operating_snapshot；
 * 主体 Grant/Counter 仅用于“已分配额度”，禁止冒充厂商购买额度。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { Decimal } from "decimal.js";
import type { Database } from "../kysely.js";
import { ProviderRepository } from "./provider-repository.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";
import {
  decimalTextsEqual,
  getMonthlyTokenUsage,
  shanghaiNaturalMonth,
} from "./dashboard-helpers.js";
import { listDashboardOverages } from "./dashboard-overages.js";
import type {
  DashboardSummary,
  ResourceUsageOverview,
} from "./dashboard-types.js";
import { buildResourceBreakdown } from "./dashboard-breakdown.js";
import { loadResourceModelUsageDetails } from "./resource-model-usage.js";
import { loadDashboardResourceStatus } from "./dashboard-resource-status.js";
import { loadMonthlyOperatingCosts } from "./monthly-operating-cost.js";
import { summarizeDashboardMonthlySpend } from "./dashboard-monthly-spend.js";

export type * from "./dashboard-types.js";

export class DashboardRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * 首页聚合（TRD §12 八项口径）。
   * @param enterpriseId 企业边界（多租户隔离）
   * @param now 当前时间戳（毫秒），用于确定当前自然月 + "最近 5 分钟"窗口
   */
  async getSummary(enterpriseId: string, now: number = Date.now()): Promise<DashboardSummary> {
    const date = new Date(now);
    const { start: monthStart, end: monthEnd } = shanghaiNaturalMonth(date);
    // 最近 5 分钟窗口
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);
    const currentOperatingSnapshots = await new ProviderRepository(this.db)
      .listCurrentOperatingSnapshots(enterpriseId, date);
    const monthlyOperatingCosts = await loadMonthlyOperatingCosts(
      this.db, enterpriseId, monthStart, monthEnd,
    );
    const dashboardSpend = summarizeDashboardMonthlySpend(
      monthlyOperatingCosts.resources, monthStart, monthEnd,
    );

    // 并行执行独立聚合查询
    const [
      resourceAccountCount,
      activeEmployeeCount,
      currentInUseCount,
      earliestExhaustion,
      dispatchSavingBreakdown,
      resourceStatus,
      overageList,
      monthlyTokenUsage,
    ] = await Promise.all([
      this.countResources(enterpriseId),
      this.countActiveEmployees(enterpriseId, monthStart, monthEnd),
      this.countInUseEmployees(enterpriseId, now, fiveMinutesAgo),
      this.findEarliestExhaustion(enterpriseId, currentOperatingSnapshots),
      this.monthlyDispatchSavingBreakdown(enterpriseId, monthStart, monthEnd),
      loadDashboardResourceStatus(this.db, enterpriseId),
      listDashboardOverages(this.db, enterpriseId),
      getMonthlyTokenUsage(this.db, enterpriseId, monthStart, monthEnd),
    ]);

    return {
      resourceAccountCount,
      activeEmployeeCount,
      currentInUseCount,
      monthlyPackagePayment: dashboardSpend.packagePayment,
      monthlyPackagePayments: dashboardSpend.packagePayments,
      monthlyApiCost: dashboardSpend.apiCost,
      monthlyApiCosts: dashboardSpend.apiCosts,
      monthlyApiSpendReason: dashboardSpend.apiCostReason,
      monthlyTotalSpend: dashboardSpend.totalSpend,
      monthlyTotalSpends: dashboardSpend.totalSpends,
      monthlyRechargeAmount: monthlyOperatingCosts.summary.rechargeAmount,
      monthlyRechargeAmounts: monthlyOperatingCosts.summary.rechargeAmounts,
      earliestExhaustion,
      monthlyDispatchSaving: dispatchSavingBreakdown.realizedSwitchCount === 0
        ? "0" : dispatchSavingBreakdown.realizedAmount,
      dispatchSavingBreakdown,
      resourceStatus,
      overageList,
      monthlyTokenUsage,
    };
  }

  /** 厂商资源“用量总览”专用重聚合；首页默认路径不得调用。 */
  async getResourceUsageOverview(
    enterpriseId: string,
    now: number = Date.now(),
  ): Promise<ResourceUsageOverview> {
    const date = new Date(now);
    const { start: monthStart, end: monthEnd } = shanghaiNaturalMonth(date);
    const [currentOperatingSnapshots, monthlyOperatingCosts] = await Promise.all([
      new ProviderRepository(this.db).listCurrentOperatingSnapshots(enterpriseId, date),
      loadMonthlyOperatingCosts(this.db, enterpriseId, monthStart, monthEnd),
    ]);
    const [providerSummaries, modelDetails] = await Promise.all([
      buildResourceBreakdown(
        this.db,
        enterpriseId,
        monthStart,
        monthEnd,
        date,
        currentOperatingSnapshots,
        monthlyOperatingCosts.resources,
      ),
      loadResourceModelUsageDetails(
        this.db,
        enterpriseId,
        monthStart,
        monthEnd,
        date,
        currentOperatingSnapshots,
      ),
    ]);
    return { generatedAt: date.toISOString(), providerSummaries, modelDetails };
  }

  /** 1. 资源账号数（未删除的资源账号数量）。 */
  private async countResources(enterpriseId: string): Promise<number> {
    const row = await this.db
      .selectFrom("provider_resource")
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "<>", "DELETED")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .executeTakeFirstOrThrow();
    return Number((row as { cnt: bigint | number }).cnt);
  }

  /** 2. 本账期活跃人数（当月至少一次成功调用的、启用中且未归档的 EMPLOYEE 去重数）。 */
  private async countActiveEmployees(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<number> {
    // 仅统计启用中（status=ACTIVE）且未归档的员工，与超额列表口径一致；
    // 归档/停用主体（如 POOL-008/009 验收遗留）不计入，避免首页人数虚高。
    const row = await sql<{ cnt: bigint }>`
      SELECT COUNT(DISTINCT r.principal_id) AS cnt
      FROM ai_request r
      INNER JOIN principal p ON p.id = r.principal_id
      WHERE r.enterprise_id = ${enterpriseId}
        AND p.type = 'EMPLOYEE'
        AND p.status = 'ACTIVE'
        AND p.archived_at IS NULL
        AND r.status = 'SUCCEEDED'
        AND r.started_at >= ${monthStart}
        AND r.started_at < ${monthEnd}
    `.execute(this.db);
    return Number(row.rows[0]?.cnt ?? 0n);
  }

  /** 3. 当前正在使用人数（进行中请求或最近 5 分钟成功请求的、启用中且未归档的员工去重数）。 */
  private async countInUseEmployees(
    enterpriseId: string,
    _now: number,
    fiveMinutesAgo: Date,
  ): Promise<number> {
    // 进行中（finished_at IS NULL）或最近 5 分钟成功（finished_at >= now-5min）；
    // 仅统计启用中（status=ACTIVE）且未归档的员工，与活跃人数口径一致。
    const row = await sql<{ cnt: bigint }>`
      SELECT COUNT(DISTINCT r.principal_id) AS cnt
      FROM ai_request r
      INNER JOIN principal p ON p.id = r.principal_id
      WHERE r.enterprise_id = ${enterpriseId}
        AND p.type = 'EMPLOYEE'
        AND p.status = 'ACTIVE'
        AND p.archived_at IS NULL
        AND (r.finished_at IS NULL
             OR (r.status = 'SUCCEEDED' AND r.finished_at >= ${fiveMinutesAgo}))
    `.execute(this.db);
    return Number(row.rows[0]?.cnt ?? 0n);
  }

  /** 7. 预计最早耗尽（可计算资源中最早的 forecast_exhaust_at）。 */
  private async findEarliestExhaustion(
    enterpriseId: string,
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<DashboardSummary["earliestExhaustion"]> {
    const result = await sql<{
      resource_id: string;
      resource_name: string;
      provider_code: string;
      forecast_exhaust_at: Date | null;
      next_recover_at: Date | null;
      confidence: string;
      not_calculable_reason: string | null;
      mode: string;
      remaining_quota: string;
      snapshot_at: Date;
    }>`
      WITH latest_forecast AS (
        SELECT DISTINCT ON (provider_resource_id) *
          FROM supply_forecast
         WHERE enterprise_id = ${enterpriseId}
         ORDER BY provider_resource_id, snapshot_at DESC
      )
      SELECT pr.id AS resource_id, pr.name AS resource_name, p.code AS provider_code,
             f.forecast_exhaust_at, f.next_recover_at, f.confidence,
             f.not_calculable_reason, pr.mode, f.remaining_quota, f.snapshot_at
        FROM latest_forecast f
        JOIN provider_resource pr ON pr.id = f.provider_resource_id
        JOIN provider p ON p.id = pr.provider_id
       WHERE f.forecast_exhaust_at IS NOT NULL
         AND f.not_calculable_reason IS NULL
         AND pr.status <> 'DELETED'
    `.execute(this.db);
    const current = new Map(
      currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    const row = result.rows
      .filter((forecast) => {
        const snapshot = current.get(forecast.resource_id);
        const remaining = forecast.mode === "API"
          ? snapshot?.current_balance ?? null
          : snapshot?.remaining_quota ?? null;
        return snapshot !== undefined &&
          forecast.snapshot_at >= snapshot.calculated_at &&
          decimalTextsEqual(forecast.remaining_quota, remaining);
      })
      .sort((left, right) =>
        left.forecast_exhaust_at!.getTime() - right.forecast_exhaust_at!.getTime(),
      )[0];
    if (!row) return null;
    return {
      resourceId: row.resource_id,
      resourceName: row.resource_name,
      providerCode: row.provider_code,
      forecastExhaustAt: row.forecast_exhaust_at ? row.forecast_exhaust_at.toISOString() : null,
      nextRecoverAt: row.next_recover_at ? row.next_recover_at.toISOString() : null,
      confidence: row.confidence,
      notCalculableReason: row.not_calculable_reason,
    };
  }

  /** POOL20-035：已实现、潜在估算、避免高峰扣减严格分层。 */
  private async monthlyDispatchSavingBreakdown(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<DashboardSummary["dispatchSavingBreakdown"]> {
    const result = await sql<{
      final_action: string; saving_calculable: boolean; dispatch_saving: string | null;
      dispatch_input: Record<string, unknown> | null;
    }>`
      SELECT final_action, saving_calculable, dispatch_saving, dispatch_input
        FROM dispatch_decision
       WHERE enterprise_id = ${enterpriseId}
         AND decided_at >= ${monthStart} AND decided_at < ${monthEnd}
    `.execute(this.db);
    let realized = new Decimal(0);
    let realizedSwitchCount = 0;
    let switchCount = 0;
    let rejectedRequestCount = 0;
    let avoided = new Decimal(0);
    let avoidedDeductionCount = 0;
    for (const row of result.rows) {
      if (row.final_action === "REJECT") rejectedRequestCount += 1;
      if (row.final_action !== "SWITCH") continue;
      switchCount += 1;
      if (row.saving_calculable && row.dispatch_saving !== null) {
        realized = realized.plus(row.dispatch_saving);
        realizedSwitchCount += 1;
      }
      const input = row.dispatch_input;
      const usage = input?.usageEvidence;
      const actualEvidence = input?.actualPricingEvidence;
      if (input?.resourceMode !== "CODING_PLAN" || !usage || typeof usage !== "object"
        || !Array.isArray(actualEvidence)) continue;
      const baselineMultiplier = new Decimal(String(input.priceMultiplier ?? "NaN"));
      const first = actualEvidence[0];
      const snapshot = first && typeof first === "object"
        ? (first as Record<string, unknown>).billingRuleSnapshot : null;
      const actualMultiplierRaw = snapshot && typeof snapshot === "object"
        ? (snapshot as Record<string, unknown>).multiplier : null;
      const usageRow = usage as Record<string, unknown>;
      if (actualMultiplierRaw === null || actualMultiplierRaw === undefined
        || !baselineMultiplier.isFinite()) continue;
      const actualMultiplier = new Decimal(String(actualMultiplierRaw));
      const rawTokens = new Decimal(String(usageRow.input ?? "0")).plus(String(usageRow.output ?? "0"));
      const delta = baselineMultiplier.minus(actualMultiplier);
      if (delta.gt(0) && rawTokens.gte(0)) {
        avoided = avoided.plus(rawTokens.mul(delta));
        avoidedDeductionCount += 1;
      }
    }
    return {
      realizedAmount: realized.toDecimalPlaces(8).toFixed(8),
      realizedSwitchCount,
      actualSwitchCount: switchCount,
      realizedReason: realizedSwitchCount > 0 ? null
        : switchCount === 0 ? "本月无可计算的实际切换" : "实际切换缺少双端不可变价格快照",
      // 现有事实没有“同一任务的峰/谷等价执行关联”，因此保持未知，不把拒绝冒充潜在金额。
      potentialPeakSavingAmount: null,
      potentialReason: "缺少同一任务的峰值/低谷等价执行关联，暂不估算金额",
      avoidedPeakDeduction: avoided.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0),
      avoidedDeductionCount,
      avoidedReason: avoidedDeductionCount > 0 ? null : "本月无具备双端倍率快照的已执行切换",
      rejectedRequestCount,
    };
  }

}
