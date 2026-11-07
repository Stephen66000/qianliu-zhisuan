import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { sumDecimalTexts } from "./dashboard-helpers.js";
import { loadApiCostEstimation } from "./api-cost-estimation.js";
import { apiEstimationGapText } from "./dashboard-monthly-spend.js";
import { loadDashboardResourceUsage } from "./dashboard-resource-usage.js";
import type { ResourceBreakdownItem, ResourceMode } from "./dashboard-types.js";
import type { MonthlyOperatingCostResource } from "./monthly-operating-cost.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";
import { latestProviderForecast, sumAllocatedQuota } from "./dashboard-breakdown-forecast.js";
import { sumProviderOperatingSnapshot } from "./dashboard-breakdown-snapshot.js";

// sumAllocatedQuota 的公共导出面保持在本模块（packages/database/src/exports/delivery-ledger.ts 转出口）。
export { sumAllocatedQuota } from "./dashboard-breakdown-forecast.js";



/**
 * S3a（ACE-03/04/06/07）：由同源估算推导 API 汇总行费用三元组。
 * 已知部分保留：有缺口但金额可知时照常透出金额，缺口进 reason；混币不合并（明确不一致）；
 * ZERO_CONFIRMED/无 API 行为明确零，不冒充未知。
 * S2B（R7 裁定）：追加兄弟布尔 priceBasisUnverified——期间计价行涉及的任一规则现值
 * sourceStatus='UNVERIFIED' 时为 true（判定源＝loadApiCostEstimation().priceBasis）；
 * 仅透出信息项，不改金额与 apiCostStatus 聚合语义。
 */
function apiCostFromEstimation(
  estimation: NonNullable<Awaited<ReturnType<typeof loadApiCostEstimation>>>,
  fallbackCurrency: string | null,
): {
  monthlyCost: string | null;
  monthlyCostReason: string | null;
  currency: string | null;
  priceBasisUnverified: boolean;
} {
  const gapText = apiEstimationGapText(estimation.gaps);
  const priceBasisUnverified = estimation.priceBasis
    .some((basis) => basis.sourceStatus === "UNVERIFIED");
  if (estimation.amounts.length === 1) {
    return {
      monthlyCost: estimation.amounts[0]!.amount,
      monthlyCostReason: gapText,
      currency: estimation.amounts[0]!.currency,
      priceBasisUnverified,
    };
  }
  if (estimation.amounts.length === 0 && estimation.completeness !== "KNOWN_PARTIAL") {
    return {
      monthlyCost: "0.00000000",
      monthlyCostReason: null,
      currency: fallbackCurrency,
      priceBasisUnverified,
    };
  }
  if (estimation.amounts.length === 0) {
    return {
      monthlyCost: null,
      monthlyCostReason: gapText ?? "API 费用估算不完整",
      currency: fallbackCurrency,
      priceBasisUnverified,
    };
  }
  return {
    monthlyCost: null,
    monthlyCostReason: `币种不一致：${estimation.amounts.map((entry) => entry.currency).join("、")}`,
    currency: fallbackCurrency,
    priceBasisUnverified,
  };
}

/** S2B（R7）：仅 API 汇总行透出聚合级价格依据待核实；套餐行字段缺省（不参与 JSON）。 */
function resourceGroupPriceBasisField(
  mode: ResourceMode,
  apiCost: { priceBasisUnverified: boolean },
): { priceBasisUnverified?: boolean } {
  return mode === "API" ? { priceBasisUnverified: apiCost.priceBasisUnverified } : {};
}

export async function buildResourceBreakdown(
  db: Kysely<Database>,
  enterpriseId: string,
  monthStart: Date,
  monthEnd: Date,
  now: Date,
  currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  monthlyOperatingCosts: MonthlyOperatingCostResource[],
): Promise<ResourceBreakdownItem[]> {
  const usageFor = await loadDashboardResourceUsage(db, enterpriseId, monthStart, monthEnd, now);
  const rows = await db
    .selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .where("provider_resource.enterprise_id", "=", enterpriseId)
    .where("provider_resource.status", "<>", "DELETED")
    .groupBy(["provider.code", "provider.name", "provider_resource.mode"])
    .select([
      "provider.code as provider_code",
      "provider.name as provider_name",
      "provider_resource.mode",
      (eb) => eb.fn.countAll().as("account_count"),
    ])
    .execute();
  const statusRows = await db
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
  const breakdown: ResourceBreakdownItem[] = [];
  const operatingSnapshotByResource = new Map(
    currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
  );
  for (const row of rows) {
    const providerCode = row.provider_code;
    const mode = row.mode as ResourceMode;
    const groupStatuses = statusRows.filter((resource) =>
      resource.provider_code === providerCode && resource.mode === mode
    );
    const worstStatus = worstResourceStatus(
      groupStatuses.map((resource) => resource.status as ResourceStatus),
    );
    const statusCounts = groupStatuses.reduce<Record<string, number>>((counts, resource) => {
      counts[resource.status] = (counts[resource.status] ?? 0) + 1;
      return counts;
    }, {});
    const [operating, allocatedQuota, forecast, apiEstimation] = await Promise.all([
      sumProviderOperatingSnapshot(db, enterpriseId, providerCode, mode, currentOperatingSnapshots),
      sumAllocatedQuota(db, enterpriseId, providerCode, mode, now),
      latestProviderForecast(db, enterpriseId, providerCode, mode, currentOperatingSnapshots),
      // S3a（ACE-03/06）：API 汇总行的费用改由同源估算供给（该 providerCode+mode 的
      // 资源集合范围、企业时区当月期间），资金开/关两条路径读到同一数值；
      // CODING_PLAN 套餐口径不变。
      mode === "API"
        ? loadApiCostEstimation(db, enterpriseId, {
          start: monthStart,
          end: monthEnd,
          resourceIds: groupStatuses.map((resource) => resource.resource_id),
        })
        : Promise.resolve(null),
    ]);
    const apiCost = apiEstimation
      ? apiCostFromEstimation(apiEstimation, operating.currency)
      : { monthlyCost: null, monthlyCostReason: null, currency: null, priceBasisUnverified: false };
    const apiMonthlyCost = apiCost.monthlyCost;
    const apiMonthlyCostReason = apiCost.monthlyCostReason;
    const apiCurrency = apiCost.currency;
    const usage = usageFor(providerCode, mode, groupStatuses.map((resource) => {
      const snapshot = operatingSnapshotByResource.get(resource.resource_id);
      return {
        resourceId: resource.resource_id,
        currentBalance: snapshot?.current_balance ?? null,
        currency: snapshot?.currency ?? null,
      };
    }));
    const costRows = monthlyOperatingCosts.filter((cost) =>
      cost.providerCode === providerCode && cost.mode === mode
    );
    const costValues = costRows.map((cost) => mode === "API" ? cost.apiSpend : cost.packageCost);
    const serviceStarts = new Set(costRows.map((cost) => cost.servicePeriodStart));
    const serviceEnds = new Set(costRows.map((cost) => cost.servicePeriodEnd));
    const costCurrencies = new Set(
      costRows.map((cost) => cost.currency).filter((value): value is string => value !== null),
    );
    const costValuesComplete = costValues.every((value) => value !== null);
    const costCurrenciesComplete = costRows.length > 0 && costCurrencies.size === 1 &&
      costRows.every((cost) => cost.currency !== null);
    const monthlyCost = mode === "API"
      ? apiMonthlyCost
      : costValuesComplete && costCurrenciesComplete
        ? sumDecimalTexts(costValues as string[])
        : null;
    const monthlyCostReason = mode === "API"
      ? apiMonthlyCostReason
      : (() => {
        const incompleteCost = costRows.find((cost, index) => costValues[index] === null);
        return incompleteCost
          ? incompleteCost.apiSpendReason ?? `${incompleteCost.resourceName} 套餐费用待补`
          : !costCurrenciesComplete
            ? `币种不一致：${costRows.map((cost) => `${cost.resourceName} ${cost.currency ?? "缺币种"}`).join("、")}`
            : null;
      })();
    breakdown.push({
      providerCode,
      providerName: row.provider_name,
      mode,
      accountCount: Number((row as { account_count: bigint | number }).account_count),
      totalQuota: operating.total,
      usedQuota: operating.used,
      remainingQuota: operating.remaining,
      quotaUnit: operating.quotaUnit,
      allocatedQuota,
      currency: mode === "API"
        ? apiCurrency
        : costCurrencies.size === 1 ? [...costCurrencies][0]! : operating.currency,
      rechargeAmount: operating.recharge,
      currentBalance: operating.balance,
      currentPeriodCost: operating.periodCost,
      packageCost: mode === "CODING_PLAN" ? monthlyCost : null,
      subscriptionPeriodStart: serviceStarts.size === 1 ? [...serviceStarts][0] ?? null : null,
      subscriptionPeriodEnd: serviceEnds.size === 1 ? [...serviceEnds][0] ?? null : null,
      snapshotAt: operating.snapshotAt,
      monthlyCost,
      monthlyCostReason,
      ...resourceGroupPriceBasisField(mode, apiCost),
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
        .filter((resource) => resource.status !== "ACTIVE")
        .map((resource) => ({
          resourceId: resource.resource_id,
          resourceName: resource.resource_name,
          status: resource.status,
        })),
    });
  }
  return breakdown;
}
