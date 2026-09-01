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
import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import {
  decimalTextsEqual,
  getMonthlyTokenUsage,
  shanghaiNaturalMonth,
  sumDecimalTexts,
} from "./dashboard-helpers.js";
import { listDashboardOverages } from "./dashboard-overages.js";
import type {
  DashboardSummary,
  ResourceBreakdownItem,
  ResourceUsageOverview,
} from "./dashboard-types.js";
import {
  loadDashboardResourceUsage,
} from "./dashboard-resource-usage.js";
import { loadResourceModelUsageDetails } from "./resource-model-usage.js";
import { loadDashboardResourceStatus } from "./dashboard-resource-status.js";
import {
  loadMonthlyOperatingCosts,
  type MonthlyOperatingCostResource,
} from "./monthly-operating-cost.js";
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
      this.buildResourceBreakdown(
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

  /** 资源摘要按厂商+模式分组（PRD §10.2 行 406-415）。 */
  private async buildResourceBreakdown(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
    now: Date,
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
    monthlyOperatingCosts: MonthlyOperatingCostResource[],
  ): Promise<ResourceBreakdownItem[]> {
    const usageFor = await loadDashboardResourceUsage(
      this.db, enterpriseId, monthStart, monthEnd, now,
    );
    // 厂商+模式维度的账号数 + 共享月度经营花费 + 最新预测
    const rows = await this.db
      .selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider_resource.status", "<>", "DELETED")
      .groupBy([
        "provider.code",
        "provider.name",
        "provider_resource.mode",
      ])
      .select([
        "provider.code as provider_code",
        "provider.name as provider_name",
        "provider_resource.mode",
        (eb) => eb.fn.countAll().as("account_count"),
      ])
      .execute();
    const statusRows = await this.db
      .selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider_resource.name as resource_name",
        "provider_resource.mode",
        "provider_resource.status",
        "provider.code as provider_code",
      ])
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.enterprise_id", "=", enterpriseId)
      .where("provider_resource.status", "<>", "DELETED")
      .execute();

    // 批量取每个厂商+模式的额度聚合 + 本月费用 + 最新预测（避免 N+1）
    const breakdown: ResourceBreakdownItem[] = [];
    const operatingSnapshotByResource = new Map(
      currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    for (const r of rows) {
      const providerCode = r.provider_code;
      const mode = r.mode as "API" | "CODING_PLAN";
      const groupStatuses = statusRows.filter((row) =>
        row.provider_code === providerCode && row.mode === mode
      );
      const worstStatus = worstResourceStatus(
        groupStatuses.map((row) => row.status as ResourceStatus),
      );
      const statusCounts = groupStatuses.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {});
      const [operating, allocatedQuota, forecast] = await Promise.all([
        this.sumProviderOperatingSnapshot(
          enterpriseId,
          providerCode,
          mode,
          currentOperatingSnapshots,
        ),
        this.sumAllocatedQuota(enterpriseId, providerCode, mode),
        this.latestProviderForecast(
          enterpriseId,
          providerCode,
          mode,
          currentOperatingSnapshots,
        ),
      ]);
      const usage = usageFor(providerCode, mode, groupStatuses.map((resource) => {
        const snapshot = operatingSnapshotByResource.get(resource.resource_id);
        return {
          resourceId: resource.resource_id,
          currentBalance: snapshot?.current_balance ?? null,
          currency: snapshot?.currency ?? null,
        };
      }));
      const costRows = monthlyOperatingCosts.filter((row) =>
        row.providerCode === providerCode && row.mode === mode
      );
      const costValues = costRows.map((row) => mode === "API" ? row.apiSpend : row.packageCost);
      const serviceStarts = new Set(costRows.map((row) => row.servicePeriodStart));
      const serviceEnds = new Set(costRows.map((row) => row.servicePeriodEnd));
      const costCurrencies = new Set(
        costRows.map((row) => row.currency).filter((value): value is string => value !== null),
      );
      const costValuesComplete = costValues.every((value) => value !== null);
      const costCurrenciesComplete = costRows.length > 0
        && costCurrencies.size === 1
        && costRows.every((row) => row.currency !== null);
      const monthlyCost = costValuesComplete && costCurrenciesComplete
        ? sumDecimalTexts(costValues as string[])
        : null;
      const incompleteCost = costRows.find((row, index) => costValues[index] === null);
      const monthlyCostReason = incompleteCost
        ? incompleteCost.apiSpendReason ?? `${incompleteCost.resourceName} 套餐费用待补`
        : !costCurrenciesComplete
          ? `币种不一致：${costRows.map((row) => `${row.resourceName} ${row.currency ?? "缺币种"}`).join("、")}`
          : null;
      breakdown.push({
        providerCode,
        providerName: r.provider_name,
        mode,
        accountCount: Number((r as { account_count: bigint | number }).account_count),
        totalQuota: operating.total,
        usedQuota: operating.used,
        remainingQuota: operating.remaining,
        quotaUnit: operating.quotaUnit,
        allocatedQuota,
        currency: costCurrencies.size === 1 ? [...costCurrencies][0]! : operating.currency,
        rechargeAmount: operating.recharge,
        currentBalance: operating.balance,
        currentPeriodCost: operating.periodCost,
        packageCost: mode === "CODING_PLAN" ? monthlyCost : null,
        subscriptionPeriodStart: serviceStarts.size === 1 ? [...serviceStarts][0] ?? null : null,
        subscriptionPeriodEnd: serviceEnds.size === 1 ? [...serviceEnds][0] ?? null : null,
        snapshotAt: operating.snapshotAt,
        monthlyCost,
        monthlyCostReason,
        ...usage,
        currentRate24h: forecast?.rate24h ?? null,
        currentRateUnit: forecast?.unit ?? null,
        forecastConfidence: forecast?.confidence ?? null,
        forecastNotCalculableReason: forecast?.reason ?? null,
        forecastDataPoints: forecast?.dataPoints ?? null,
        forecastExhaustAt: forecast?.exhaustAt ?? null,
        status: worstStatus === "ACTIVE" ? "HEALTHY" : worstStatus,
        statusCounts,
        abnormalResources: groupStatuses
          .filter((row) => row.status !== "ACTIVE")
          .map((row) => ({
            resourceId: row.resource_id,
            resourceName: row.resource_name,
            status: row.status,
          })),
      });
    }
    return breakdown;
  }

  /** 主体已分配额度：仅作为独立列，不参与厂商总额/余量/预测。 */
  private async sumAllocatedQuota(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
  ): Promise<string> {
    // 当前 alias 可经 Model Route 判定 API/Coding Plan；未映射的历史 Grant 沿用
    // 旧合同归入 Coding Plan，避免同一额度在两个模式重复展示。
    const row = await sql<{ total: string }>`
      SELECT COALESCE(SUM(g.quota_value::numeric), 0)::text AS total
      FROM principal_grant g
      WHERE g.enterprise_id = ${enterpriseId}
        AND g.provider = ${providerCode}
        AND g.status = 'ACTIVE'
        AND (
          EXISTS (
            SELECT 1
              FROM unified_model um
              JOIN model_route mr
                ON mr.unified_model_id = um.id
               AND mr.enterprise_id = ${enterpriseId}
               AND mr.archived_at IS NULL
              JOIN provider_resource pr
                ON pr.id = mr.provider_resource_id
               AND pr.enterprise_id = ${enterpriseId}
               AND pr.status <> 'DELETED'
              JOIN provider p
                ON p.id = pr.provider_id
               AND p.enterprise_id = ${enterpriseId}
             WHERE um.enterprise_id = ${enterpriseId}
               AND um.alias = g.model_alias
               AND p.code = ${providerCode}
               AND pr.mode = ${mode}
          )
          OR (
            ${mode} = 'CODING_PLAN'
            AND NOT EXISTS (
              SELECT 1
                FROM unified_model um
                JOIN model_route mr
                  ON mr.unified_model_id = um.id
                 AND mr.enterprise_id = ${enterpriseId}
                 AND mr.archived_at IS NULL
                JOIN provider_resource pr
                  ON pr.id = mr.provider_resource_id
                 AND pr.enterprise_id = ${enterpriseId}
                 AND pr.status <> 'DELETED'
               WHERE um.enterprise_id = ${enterpriseId}
                 AND um.alias = g.model_alias
            )
          )
        )
    `.execute(this.db);
    return row.rows[0]?.total ?? "0";
  }

  /** 最新厂商资源快照聚合；缺值或单位不一致时相应指标返回 null。 */
  private async sumProviderOperatingSnapshot(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<{
    total: string | null;
    used: string | null;
    remaining: string | null;
    quotaUnit: string | null;
    currency: string | null;
    recharge: string | null;
    balance: string | null;
    periodCost: string | null;
    snapshotAt: string | null;
  }> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select("provider_resource.id")
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.code", "=", providerCode)
      .where("provider_resource.mode", "=", mode)
      .where("provider_resource.status", "<>", "DELETED")
      .execute();
    const resourceIds = new Set(resources.map((resource) => resource.id));
    const snapshots = currentOperatingSnapshots
      .filter((snapshot) => resourceIds.has(snapshot.provider_resource_id));
    const complete = resourceIds.size > 0 && snapshots.length === resourceIds.size;
    const values = (key: "total_quota" | "used_quota" | "remaining_quota" |
      "recharge_amount" | "current_balance" | "current_period_cost") =>
      snapshots.map((snapshot) => snapshot[key]).filter((value): value is string => value !== null);
    const quotaUnits = new Set(snapshots.map((snapshot) => snapshot.quota_unit).filter(Boolean));
    const currencies = new Set(snapshots.map((snapshot) => snapshot.currency).filter(Boolean));
    const allHave = (key: Parameters<typeof values>[0]) =>
      complete && values(key).length === resourceIds.size;
    const sameQuotaUnit = complete && quotaUnits.size === 1;
    const sameCurrency = complete && currencies.size === 1 &&
      snapshots.every((snapshot) => snapshot.currency !== null);
    const quotaMode = mode === "CODING_PLAN";
    const amountMode = mode === "API";
    const latestCalculatedAt = snapshots.reduce<Date | null>(
      (latest, snapshot) => !latest || snapshot.calculated_at > latest
        ? snapshot.calculated_at
        : latest,
      null,
    );
    return {
      total: quotaMode && sameQuotaUnit && allHave("total_quota")
        ? sumDecimalTexts(values("total_quota")) : null,
      used: quotaMode && sameQuotaUnit && allHave("used_quota")
        ? sumDecimalTexts(values("used_quota")) : null,
      remaining: quotaMode && sameQuotaUnit && allHave("remaining_quota")
        ? sumDecimalTexts(values("remaining_quota")) : null,
      quotaUnit: quotaMode && sameQuotaUnit ? [...quotaUnits][0] ?? null : null,
      currency: amountMode && sameCurrency ? [...currencies][0] ?? null : null,
      recharge: amountMode && sameCurrency && allHave("recharge_amount")
        ? sumDecimalTexts(values("recharge_amount")) : null,
      balance: amountMode && sameCurrency && allHave("current_balance")
        ? sumDecimalTexts(values("current_balance")) : null,
      periodCost:
        amountMode && sameCurrency && allHave("current_period_cost")
          ? sumDecimalTexts(values("current_period_cost")) : null,
      snapshotAt: latestCalculatedAt?.toISOString() ?? null,
    };
  }

  /** 某厂商最新预测快照（rate_24h + forecast_exhaust_at）。 */
  private async latestProviderForecast(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<{
    rate24h: string | null;
    exhaustAt: string | null;
    unit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
    confidence: string;
    reason: string | null;
    dataPoints: number;
  } | null> {
    const result = await sql<{
      resource_id: string;
      rate_24h: string | null;
      forecast_exhaust_at: Date | null;
      remaining_quota: string;
      snapshot_at: Date;
      consumption_unit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
      confidence: string;
      not_calculable_reason: string | null;
      data_points: number;
    }>`
      WITH latest_forecast AS (
        SELECT DISTINCT ON (provider_resource_id) *
          FROM supply_forecast
         WHERE enterprise_id = ${enterpriseId}
         ORDER BY provider_resource_id, snapshot_at DESC
      )
      SELECT f.provider_resource_id AS resource_id, f.rate_24h,
             f.forecast_exhaust_at, f.remaining_quota, f.snapshot_at,
             f.consumption_unit, f.confidence, f.not_calculable_reason, f.data_points
        FROM latest_forecast f
        JOIN provider_resource pr ON pr.id = f.provider_resource_id
        JOIN provider p ON p.id = pr.provider_id
       WHERE p.code = ${providerCode}
         AND pr.enterprise_id = ${enterpriseId}
         AND p.enterprise_id = ${enterpriseId}
         AND pr.mode = ${mode} AND pr.status <> 'DELETED'
    `.execute(this.db);
    const current = new Map(
      currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    const row = result.rows
      .filter((forecast) => {
        const snapshot = current.get(forecast.resource_id);
        const remaining = mode === "API"
          ? snapshot?.current_balance ?? null
          : snapshot?.remaining_quota ?? null;
        return snapshot !== undefined &&
          forecast.snapshot_at >= snapshot.calculated_at &&
          decimalTextsEqual(forecast.remaining_quota, remaining);
      })
      .sort((left, right) => {
        if (!left.forecast_exhaust_at) return 1;
        if (!right.forecast_exhaust_at) return -1;
        return left.forecast_exhaust_at.getTime() - right.forecast_exhaust_at.getTime();
      })[0];
    if (!row) return null;
    return {
      rate24h: row.rate_24h,
      exhaustAt: row.forecast_exhaust_at ? row.forecast_exhaust_at.toISOString() : null,
      unit: row.consumption_unit,
      confidence: row.confidence,
      reason: row.not_calculable_reason,
      dataPoints: row.data_points,
    };
  }

}
