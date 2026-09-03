import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import { decimalTextsEqual, sumDecimalTexts } from "./dashboard-helpers.js";
import { loadDashboardResourceUsage } from "./dashboard-resource-usage.js";
import type { ResourceBreakdownItem } from "./dashboard-types.js";
import type { MonthlyOperatingCostResource } from "./monthly-operating-cost.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";

type ResourceMode = "API" | "CODING_PLAN";

function hasCompleteSnapshots(resourceCount: number, snapshotCount: number): boolean {
  return resourceCount > 0 && snapshotCount === resourceCount;
}

async function sumAllocatedQuota(
  db: Kysely<Database>,
  enterpriseId: string,
  providerCode: string,
  mode: ResourceMode,
): Promise<string> {
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
  `.execute(db);
  return row.rows[0]?.total ?? "0";
}

async function sumProviderOperatingSnapshot(
  db: Kysely<Database>,
  enterpriseId: string,
  providerCode: string,
  mode: ResourceMode,
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
  const resources = await db
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
  const complete = hasCompleteSnapshots(resourceIds.size, snapshots.length);
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
    periodCost: amountMode && sameCurrency && allHave("current_period_cost")
      ? sumDecimalTexts(values("current_period_cost")) : null,
    snapshotAt: latestCalculatedAt?.toISOString() ?? null,
  };
}

async function latestProviderForecast(
  db: Kysely<Database>,
  enterpriseId: string,
  providerCode: string,
  mode: ResourceMode,
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
  `.execute(db);
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
    const [operating, allocatedQuota, forecast] = await Promise.all([
      sumProviderOperatingSnapshot(db, enterpriseId, providerCode, mode, currentOperatingSnapshots),
      sumAllocatedQuota(db, enterpriseId, providerCode, mode),
      latestProviderForecast(db, enterpriseId, providerCode, mode, currentOperatingSnapshots),
    ]);
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
    const monthlyCost = costValuesComplete && costCurrenciesComplete
      ? sumDecimalTexts(costValues as string[])
      : null;
    const incompleteCost = costRows.find((cost, index) => costValues[index] === null);
    const monthlyCostReason = incompleteCost
      ? incompleteCost.apiSpendReason ?? `${incompleteCost.resourceName} 套餐费用待补`
      : !costCurrenciesComplete
        ? `币种不一致：${costRows.map((cost) => `${cost.resourceName} ${cost.currency ?? "缺币种"}`).join("、")}`
        : null;
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
