import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { summarizeMonthlyOperatingCosts } from "./monthly-operating-summary.js";

export { summarizeMonthlyOperatingCosts } from "./monthly-operating-summary.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export type ApiSpendStatus =
  | "CALCULABLE"
  | "NOT_APPLICABLE"
  | "OPENING_BALANCE_MISSING"
  | "ENDING_BALANCE_MISSING"
  | "CURRENCY_MISMATCH"
  | "NEGATIVE_BALANCE_BRIDGE";

export interface CurrencyAmount { currency: string; amount: string }

export interface MonthlyOperatingCostResource {
  resourceId: string;
  providerCode: string;
  providerName: string;
  resourceName: string;
  mode: "API" | "CODING_PLAN";
  currency: string | null;
  openingBalanceCurrency: string | null;
  rechargeAmounts: CurrencyAmount[];
  endingBalanceCurrency: string | null;
  apiSpendCurrency: string | null;
  packageCostCurrency: string | null;
  openingSnapshotId: string | null;
  openingSnapshotVersion: number | null;
  openingSnapshotAt: string | null;
  openingBalanceFactId: string | null;
  openingBalanceFactVersion: number | null;
  openingBalanceSource: "MANUAL" | "PREVIOUS_PERIOD_CLOSING" | "OPERATING_SNAPSHOT" | null;
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
  openingBalances: CurrencyAmount[];
  rechargeAmounts: CurrencyAmount[];
  endingBalances: CurrencyAmount[];
  apiSpends: CurrencyAmount[];
  packageCosts: CurrencyAmount[];
  totalSpends: CurrencyAmount[];
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
  manual_opening_id: string | null;
  manual_opening_version: number | null;
  opening_source: "MANUAL" | "PREVIOUS_PERIOD_CLOSING" | "OPERATING_SNAPSHOT" | null;
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
  if (status === "CURRENCY_MISMATCH") return "期初余额、本月充值与期末余额币种不一致";
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
    packageCostCurrency: row.mode === "CODING_PLAN" ? row.ending_currency : null,
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    openingSnapshotId: row.opening_snapshot_id,
    openingSnapshotVersion: row.opening_snapshot_version,
    openingSnapshotAt: row.opening_at?.toISOString() ?? null,
    openingBalanceFactId: row.manual_opening_id ?? row.opening_snapshot_id,
    openingBalanceFactVersion: row.manual_opening_version ?? row.opening_snapshot_version,
    openingBalanceSource: row.opening_source,
    endingSnapshotId: row.ending_snapshot_id,
    endingSnapshotVersion: row.ending_snapshot_version,
    endingSnapshotAt: row.ending_at?.toISOString() ?? null,
  } as const;
  if (row.mode !== "API") {
    return {
      ...base,
      currency: row.ending_currency,
      openingBalanceCurrency: null,
      rechargeAmounts: [],
      endingBalanceCurrency: null,
      apiSpendCurrency: null,
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
  const rechargeAmounts = recharges.map((item) => ({
    currency: item.currency, amount: money(item.amount),
  }));
  const endingAtMs = row.ending_at?.getTime();
  let status: ApiSpendStatus = "CALCULABLE";
  if (row.opening_balance === null || row.opening_currency === null || row.opening_at === null) {
    status = "OPENING_BALANCE_MISSING";
  } else if (
    row.ending_balance === null
    || row.ending_currency === null
    || endingAtMs === undefined
    || endingAtMs <= input.periodStart.getTime()
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
    openingBalanceCurrency: row.opening_currency,
    rechargeAmounts,
    endingBalanceCurrency: row.ending_currency,
    apiSpendCurrency: apiSpend === null ? null : row.ending_currency,
    openingBalance: row.opening_balance,
    rechargeAmount: rechargeCurrencies.size <= 1 ? summedRechargeAmount : null,
    endingBalance: row.ending_balance,
    apiSpend,
    apiSpendStatus: status,
    apiSpendReason: reasonFor(status),
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
             CASE WHEN previous_closing.amount IS NOT NULL THEN previous_closing.snapshot_id
                  WHEN manual_opening.id IS NOT NULL THEN NULL ELSE opening.id END AS opening_snapshot_id,
             CASE WHEN previous_closing.amount IS NOT NULL THEN previous_closing.snapshot_version
                  WHEN manual_opening.id IS NOT NULL THEN NULL ELSE opening.version END AS opening_snapshot_version,
             COALESCE(previous_closing.amount, manual_opening.amount, opening.current_balance)::text AS opening_balance,
             COALESCE(previous_closing.currency, manual_opening.currency, opening.currency) AS opening_currency,
             CASE WHEN previous_closing.amount IS NOT NULL THEN previous_closing.snapshot_at
                  WHEN manual_opening.id IS NOT NULL THEN ${periodStart} ELSE opening.collected_at END AS opening_at,
             CASE WHEN previous_closing.amount IS NULL THEN manual_opening.id ELSE NULL END AS manual_opening_id,
             CASE WHEN previous_closing.amount IS NULL THEN manual_opening.version ELSE NULL END AS manual_opening_version,
             CASE WHEN previous_closing.amount IS NOT NULL THEN 'PREVIOUS_PERIOD_CLOSING'
                  WHEN manual_opening.id IS NOT NULL THEN 'MANUAL'
                  WHEN opening.id IS NOT NULL THEN 'OPERATING_SNAPSHOT'
                  ELSE NULL END AS opening_source,
             ending.id AS ending_snapshot_id, ending.version AS ending_snapshot_version,
             ending.current_balance::text AS ending_balance,
             ending.currency AS ending_currency, ending.collected_at AS ending_at,
             CASE WHEN pr.mode = 'CODING_PLAN'
                  THEN ending.package_cost::text ELSE NULL END AS package_cost,
             to_char(ending.effective_from AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS service_period_start,
             to_char(ending.effective_until AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS service_period_end
        FROM provider_resource pr
        JOIN provider p ON p.id = pr.provider_id AND p.enterprise_id = pr.enterprise_id
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
          SELECT b.id, b.version, b.amount, b.currency
            FROM operating_bill_opening_balance b
            JOIN operating_bill_period obp
              ON obp.id = b.period_id AND obp.enterprise_id = b.enterprise_id
           WHERE b.enterprise_id = pr.enterprise_id
             AND b.provider_resource_id = pr.id
             AND obp.period_month = (${periodStart} AT TIME ZONE 'Asia/Shanghai')::date
           ORDER BY b.version DESC, b.created_at DESC LIMIT 1
        ) manual_opening ON true
        LEFT JOIN LATERAL (
          SELECT NULLIF(item.fact->>'endingSnapshotId', '')::uuid AS snapshot_id,
                 NULLIF(item.fact->>'endingSnapshotVersion', '')::integer AS snapshot_version,
                 NULLIF(item.fact->>'endingSnapshotAt', '')::timestamptz AS snapshot_at,
                 NULLIF(item.fact->>'endingBalance', '')::numeric AS amount,
                 NULLIF(item.fact->>'currency', '') AS currency
            FROM operating_bill_period previous_period
            JOIN operating_bill_version previous_version
              ON previous_version.enterprise_id = previous_period.enterprise_id
             AND previous_version.period_id = previous_period.id
             AND previous_version.version = previous_period.current_version
            CROSS JOIN LATERAL jsonb_array_elements(
              COALESCE(previous_version.snapshot->'sourceFacts'->'balanceBridgeFacts', '[]'::jsonb)
            ) AS item(fact)
           WHERE previous_period.enterprise_id = pr.enterprise_id
             AND previous_period.status = 'CLOSED'
             AND previous_period.period_month = (
               (${periodStart} AT TIME ZONE 'Asia/Shanghai')::date - interval '1 month'
             )::date
             AND item.fact->>'providerResourceId' = pr.id::text
             AND NULLIF(item.fact->>'currency', '') = COALESCE(
               manual_opening.currency,
               (
                 SELECT current_month.currency
                   FROM provider_resource_operating_snapshot current_month
                  WHERE current_month.enterprise_id = pr.enterprise_id
                    AND current_month.provider_resource_id = pr.id
                    AND current_month.collected_at >= ${periodStart}
                    AND current_month.collected_at < ${periodEnd}
                    AND current_month.current_balance IS NOT NULL
                    AND current_month.currency IS NOT NULL
                  ORDER BY current_month.collected_at DESC, current_month.version DESC
                  LIMIT 1
               ),
               opening.currency,
               NULLIF(item.fact->>'currency', '')
             )
           LIMIT 1
        ) previous_closing ON true
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
