import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export type ApiSpendStatus =
  | "CALCULABLE"
  | "NOT_APPLICABLE"
  | "OPENING_BALANCE_MISSING"
  | "ENDING_BALANCE_MISSING"
  | "CURRENCY_MISMATCH"
  | "NEGATIVE_BALANCE_BRIDGE";

export interface MonthlyOperatingCostResource {
  resourceId: string;
  providerCode: string;
  providerName: string;
  resourceName: string;
  mode: "API" | "CODING_PLAN";
  currency: string | null;
  openingSnapshotId: string | null;
  openingSnapshotVersion: number | null;
  openingSnapshotAt: string | null;
  endingSnapshotId: string | null;
  endingSnapshotVersion: number | null;
  endingSnapshotAt: string | null;
  openingBalance: string | null;
  rechargeAmount: string | null;
  endingBalance: string | null;
  apiSpend: string | null;
  ledgerApiCost: string | null;
  apiSpendStatus: ApiSpendStatus;
  apiSpendReason: string | null;
  packageCost: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
}

export interface MonthlyOperatingCostSummary {
  apiSpend: string | null;
  ledgerApiCost: string | null;
  packageCost: string | null;
  totalSpend: string | null;
  openingBalance: string | null;
  rechargeAmount: string | null;
  endingBalance: string | null;
  currency: string | null;
  apiSpendStatus: ApiSpendStatus;
  apiSpendReason: string | null;
}

export interface MonthlyOperatingCosts {
  resources: MonthlyOperatingCostResource[];
  summary: MonthlyOperatingCostSummary;
}

export interface MonthlyOperatingCostResourceRow {
  resource_id: string;
  provider_code: string;
  provider_name: string;
  resource_name: string;
  mode: "API" | "CODING_PLAN";
  opening_snapshot_id: string | null;
  opening_snapshot_version: number | null;
  opening_balance: string | null;
  opening_currency: string | null;
  opening_at: Date | null;
  ending_snapshot_id: string | null;
  ending_snapshot_version: number | null;
  ending_balance: string | null;
  ending_currency: string | null;
  ending_at: Date | null;
  package_cost: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
}

interface RechargeRow {
  provider_resource_id: string;
  currency: string;
  amount: string;
}

interface LedgerRow {
  provider_resource_id: string;
  amount: string | null;
}

function money(value: Decimal.Value): string {
  return new MoneyDecimal(value).toDecimalPlaces(8).toFixed(8);
}

function reasonFor(status: ApiSpendStatus): string | null {
  if (status === "OPENING_BALANCE_MISSING") return "待补期初余额";
  if (status === "ENDING_BALANCE_MISSING") return "待补期末余额";
  if (status === "CURRENCY_MISMATCH") return "余额、充值与套餐币种不一致";
  if (status === "NEGATIVE_BALANCE_BRIDGE") return "余额桥接结果为负，请核对快照与充值记录";
  return null;
}

export function calculateMonthlyOperatingCostResource(input: {
  row: MonthlyOperatingCostResourceRow;
  recharges: RechargeRow[];
  ledgerApiCost: string | null;
  periodStart: Date;
}): MonthlyOperatingCostResource {
  const { row, recharges } = input;
  const base = {
    resourceId: row.resource_id,
    providerCode: row.provider_code,
    providerName: row.provider_name,
    resourceName: row.resource_name,
    mode: row.mode,
    ledgerApiCost: input.ledgerApiCost === null ? null : money(input.ledgerApiCost),
    packageCost: row.mode === "CODING_PLAN" ? row.package_cost : "0.00000000",
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    openingSnapshotId: row.opening_snapshot_id,
    openingSnapshotVersion: row.opening_snapshot_version,
    openingSnapshotAt: row.opening_at?.toISOString() ?? null,
    endingSnapshotId: row.ending_snapshot_id,
    endingSnapshotVersion: row.ending_snapshot_version,
    endingSnapshotAt: row.ending_at?.toISOString() ?? null,
  } as const;
  if (row.mode !== "API") {
    return {
      ...base,
      currency: row.ending_currency,
      openingBalance: null,
      rechargeAmount: "0.00000000",
      endingBalance: null,
      apiSpend: "0.00000000",
      apiSpendStatus: "NOT_APPLICABLE",
      apiSpendReason: null,
    };
  }

  const summedRechargeAmount = money(recharges.reduce(
    (sum, item) => sum.plus(item.amount),
    new MoneyDecimal(0),
  ));
  const rechargeCurrencies = new Set(recharges.map((item) => item.currency));
  let status: ApiSpendStatus = "CALCULABLE";
  if (row.opening_balance === null || row.opening_currency === null || row.opening_at === null) {
    status = "OPENING_BALANCE_MISSING";
  } else if (
    row.ending_balance === null
    || row.ending_currency === null
    || row.ending_at === null
    || row.ending_at <= input.periodStart
  ) {
    status = "ENDING_BALANCE_MISSING";
  } else if (
    row.opening_currency !== row.ending_currency
    || rechargeCurrencies.size > 1
    || (rechargeCurrencies.size === 1 && !rechargeCurrencies.has(row.ending_currency))
  ) {
    status = "CURRENCY_MISMATCH";
  }
  let apiSpend: string | null = null;
  if (status === "CALCULABLE") {
    const bridged = new MoneyDecimal(row.opening_balance!).plus(summedRechargeAmount).minus(row.ending_balance!);
    if (bridged.isNegative()) status = "NEGATIVE_BALANCE_BRIDGE";
    else apiSpend = money(bridged);
  }
  return {
    ...base,
    currency: row.ending_currency ?? row.opening_currency,
    openingBalance: row.opening_balance,
    rechargeAmount: status === "CURRENCY_MISMATCH" ? null : summedRechargeAmount,
    endingBalance: row.ending_balance,
    apiSpend,
    apiSpendStatus: status,
    apiSpendReason: reasonFor(status),
  };
}

export function summarizeMonthlyOperatingCosts(resources: MonthlyOperatingCostResource[]): MonthlyOperatingCostSummary {
  const apiResources = resources.filter((row) => row.mode === "API");
  const planResources = resources.filter((row) => row.mode === "CODING_PLAN");
  const firstIncomplete = apiResources.find((row) => row.apiSpendStatus !== "CALCULABLE");
  const apiCurrencies = new Set(apiResources.map((row) => row.currency).filter((value): value is string => value !== null));
  const packageResourcesWithCost = planResources.filter((row) => row.packageCost !== null);
  const costCurrencies = new Set([
    ...apiResources.filter((row) => row.apiSpend !== null).map((row) => row.currency),
    ...packageResourcesWithCost.map((row) => row.currency),
  ].filter((value): value is string => value !== null));
  const missingCostCurrency = [
    ...apiResources.filter((row) => row.apiSpend !== null),
    ...packageResourcesWithCost,
  ].some((row) => row.currency === null);
  const currencyMismatch = apiResources.some((row) => row.apiSpendStatus === "CURRENCY_MISMATCH")
    || apiCurrencies.size > 1 || costCurrencies.size > 1 || missingCostCurrency;
  const apiSpendStatus: ApiSpendStatus = apiResources.length === 0
    ? "NOT_APPLICABLE"
    : currencyMismatch
      ? "CURRENCY_MISMATCH"
      : firstIncomplete?.apiSpendStatus ?? "CALCULABLE";
  const sum = (values: string[]) => money(values.reduce(
    (total, value) => total.plus(value),
    new MoneyDecimal(0),
  ));
  const apiSpend = apiSpendStatus === "CALCULABLE"
    ? sum(apiResources.map((row) => row.apiSpend!))
    : apiResources.length === 0 ? "0.00000000" : null;
  const packageComplete = planResources.every((row) => row.packageCost !== null);
  const ledgerComplete = apiResources.every((row) => row.ledgerApiCost !== null);
  const packageCost = currencyMismatch
    ? null
    : planResources.length === 0
      ? resources.length === 0 ? null : "0.00000000"
      : packageComplete
        ? sum(planResources.map((row) => row.packageCost!))
        : null;
  return {
    apiSpend,
    ledgerApiCost: ledgerComplete
      ? sum(apiResources.map((row) => row.ledgerApiCost!))
      : null,
    packageCost,
    totalSpend: apiSpend !== null && packageCost !== null
      ? money(new MoneyDecimal(apiSpend).plus(packageCost))
      : null,
    openingBalance: apiSpendStatus === "CALCULABLE"
      ? sum(apiResources.map((row) => row.openingBalance!))
      : apiResources.length === 0 ? "0.00000000" : null,
    rechargeAmount: apiResources.length === 0
      ? null
      : currencyMismatch
      ? null
      : sum(apiResources.map((row) => row.rechargeAmount!)),
    endingBalance: apiSpendStatus === "CALCULABLE"
      ? sum(apiResources.map((row) => row.endingBalance!))
      : apiResources.length === 0 ? "0.00000000" : null,
    currency: costCurrencies.size === 1 ? [...costCurrencies][0]! : null,
    apiSpendStatus,
    apiSpendReason: currencyMismatch ? reasonFor("CURRENCY_MISMATCH") : firstIncomplete?.apiSpendReason ?? null,
  };
}

/**
 * POOL20-043 月度经营唯一口径：API 花费 = 期初余额 + 本月充值 - 期末余额。
 * ledger_line.api_cost 只作为核对证据返回，不代替缺失的期初余额。
 */
export async function loadMonthlyOperatingCosts(
  db: Kysely<Database>,
  enterpriseId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<MonthlyOperatingCosts> {
  const [resourceResult, rechargeResult, ledgerResult] = await Promise.all([
    sql<MonthlyOperatingCostResourceRow>`
      SELECT pr.id AS resource_id, p.code AS provider_code, p.name AS provider_name,
             pr.name AS resource_name, pr.mode,
             opening.id AS opening_snapshot_id, opening.version AS opening_snapshot_version,
             opening.current_balance::text AS opening_balance,
             opening.currency AS opening_currency, opening.collected_at AS opening_at,
             ending.id AS ending_snapshot_id, ending.version AS ending_snapshot_version,
             ending.current_balance::text AS ending_balance,
             ending.currency AS ending_currency, ending.collected_at AS ending_at,
             CASE WHEN pr.mode = 'CODING_PLAN'
                        AND ending.package_cost IS NOT NULL
                        AND (ending.effective_from IS NULL OR ending.effective_from < ${periodEnd})
                        AND (ending.effective_until IS NULL OR ending.effective_until > ${periodStart})
                  THEN ending.package_cost::text ELSE NULL END AS package_cost,
             to_char(ending.effective_from AT TIME ZONE e.timezone, 'YYYY-MM-DD') AS service_period_start,
             to_char(ending.effective_until AT TIME ZONE e.timezone, 'YYYY-MM-DD') AS service_period_end
        FROM provider_resource pr
        JOIN provider p ON p.id = pr.provider_id AND p.enterprise_id = pr.enterprise_id
        JOIN enterprise e ON e.id = pr.enterprise_id
        LEFT JOIN LATERAL (
          SELECT s.id, s.version, s.current_balance, s.currency, s.collected_at
            FROM provider_resource_operating_snapshot s
           WHERE s.enterprise_id = pr.enterprise_id
             AND s.provider_resource_id = pr.id
             AND s.collected_at <= ${periodStart}
             AND (pr.mode <> 'API' OR (s.current_balance IS NOT NULL AND s.currency IS NOT NULL))
           ORDER BY s.collected_at DESC, s.version DESC LIMIT 1
        ) opening ON true
        LEFT JOIN LATERAL (
          SELECT s.id, s.version, s.current_balance, s.currency, s.collected_at, s.package_cost,
                 s.effective_from, s.effective_until
            FROM provider_resource_operating_snapshot s
           WHERE s.enterprise_id = pr.enterprise_id
             AND s.provider_resource_id = pr.id
             AND s.collected_at < ${periodEnd}
             AND (pr.mode <> 'API' OR (s.current_balance IS NOT NULL AND s.currency IS NOT NULL))
           ORDER BY s.collected_at DESC, s.version DESC LIMIT 1
        ) ending ON true
       WHERE pr.enterprise_id = ${enterpriseId}::uuid AND pr.status <> 'DELETED'
       ORDER BY p.code, pr.name, pr.id
    `.execute(db),
    sql<RechargeRow>`
      SELECT provider_resource_id, currency, SUM(amount)::text AS amount
        FROM resource_purchase_record
       WHERE enterprise_id = ${enterpriseId}::uuid
         AND purchase_type = 'API_RECHARGE'
         AND purchased_at >= ${periodStart} AND purchased_at < ${periodEnd}
       GROUP BY provider_resource_id, currency
    `.execute(db),
    sql<LedgerRow>`
      SELECT provider_resource_id,
             CASE WHEN COUNT(*) = COUNT(api_cost)
                  THEN COALESCE(SUM(api_cost), 0)::text ELSE NULL END AS amount
        FROM ledger_line
       WHERE enterprise_id = ${enterpriseId}::uuid AND resource_mode = 'API'
         AND created_at >= ${periodStart} AND created_at < ${periodEnd}
       GROUP BY provider_resource_id
    `.execute(db),
  ]);
  const recharges = new Map<string, RechargeRow[]>();
  for (const row of rechargeResult.rows) {
    const list = recharges.get(row.provider_resource_id) ?? [];
    list.push(row);
    recharges.set(row.provider_resource_id, list);
  }
  const ledger = new Map(ledgerResult.rows.map((row) => [row.provider_resource_id, row.amount]));
  const resources = resourceResult.rows.map((row) => calculateMonthlyOperatingCostResource({
    row,
    recharges: recharges.get(row.resource_id) ?? [],
    ledgerApiCost: ledger.has(row.resource_id) ? ledger.get(row.resource_id)! : "0",
    periodStart,
  }));
  return { resources, summary: summarizeMonthlyOperatingCosts(resources) };
}
