import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  loadMonthlyOperatingCosts,
  operatingBillMonthRange,
  type Database,
} from "@qianliu/database";
import { applyApiBudgetFacts } from "./projection.js";

export interface ResourceUtilizationRow {
  resourceId: string;
  providerId: string;
  providerName: string;
  providerCode?: string;
  allocatedQuota?: string | null;
  resourceName: string;
  mode: "API" | "CODING_PLAN";
  resourceStatus: string;
  requestCount: number;
  realTokens: string;
  apiCost: string | null;
  deductedQuota: string;
  purchaseCashAmount: string;
  currency: string | null;
  budgetAmount: string | null;
  budgetCurrency: string | null;
  budgetVersion: number;
  budgetStatus: "ACTIVE" | "CLEARED" | "NOT_CONFIGURED";
  budgetUpdatedAt: string | null;
  budgetDifference: string | null;
  currentBalance: string | null;
  packageCost: string | null;
  totalQuota: string | null;
  usedQuota: string | null;
  remainingQuota: string | null;
  quotaUnit: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  utilizationRate: string | null;
  idleEntitlementCost: string | null;
  rate1h: string | null;
  rate24h: string | null;
  rate7d: string | null;
  forecastExhaustAt: string | null;
  nextRecoverAt: string | null;
  coverageHours: string | null;
  forecastConfidence: string | null;
  forecastStatus: "CURRENT" | "STALE" | "NOT_CALCULABLE" | "NOT_AVAILABLE";
  forecastNotCalculableReason: string | null;
  forecastDataAt: string | null;
  lastSettledRequestAt: string | null;
  continuousNoCallDays: number | null;
  idleStatus: "UNASSESSED";
  utilizationBasis: "API_MONTHLY_BUDGET" | "CODING_PLAN_SUBSCRIPTION_PERIOD" | null;
  utilizationStatus: string;
  notCalculableReason: string | null;
  dataAt: string | null;
  quotaWindows: QuotaWindowFact[];
}

export interface QuotaWindowFact {
  type: "FIVE_HOUR" | "WEEKLY";
  limitValue: string | null; usedValue: string | null; remainingValue: string | null;
  ratio: string | null;
  unit: "PERCENT" | "POINT" | null;
  resetAt: string | null; providerDataAt: string | null;
  collectedAt: string;
  syncStatus: "SUCCESS" | "STALE" | "FAILED" | "UNSUPPORTED";
  syncErrorCode: string | null;
}

interface RawUtilizationRow {
  resource_id: string;
  provider_id: string; provider_name: string; provider_code: string; resource_name: string;
  mode: "API" | "CODING_PLAN";
  resource_status: string;
  request_count: string | number; real_tokens: string;
  api_cost: string | null;
  deducted_quota: string;
  purchase_cash_amount: string;
  currency: string | null;
  budget_amount: string | null;
  budget_currency: string | null;
  budget_version: number | null;
  budget_status: "ACTIVE" | "CLEARED" | null;
  budget_updated_at: Date | null;
  current_balance: string | null;
  package_cost: string | null;
  total_quota: string | null;
  used_quota: string | null;
  remaining_quota: string | null;
  quota_unit: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  utilization_rate: string | null;
  idle_entitlement_cost: string | null;
  rate_1h: string | null;
  rate_24h: string | null;
  rate_7d: string | null;
  forecast_exhaust_at: Date | null;
  next_recover_at: Date | null;
  coverage_hours: string | null;
  forecast_confidence: string | null;
  forecast_status: "CURRENT" | "STALE" | "NOT_CALCULABLE" | "NOT_AVAILABLE";
  forecast_not_calculable_reason: string | null;
  forecast_data_at: Date | null;
  last_settled_request_at: Date | null;
  continuous_no_call_days: string | number | null;
  utilization_basis: "API_MONTHLY_BUDGET" | "CODING_PLAN_SUBSCRIPTION_PERIOD" | null;
  utilization_status: string;
  not_calculable_reason: string | null;
  data_at: Date | null;
}

export async function listResourceUtilization(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string, asOf?: Date,
): Promise<ResourceUtilizationRow[]> {
  const monthStart = `${month}-01`;
  const result = await sql<RawUtilizationRow>`
    WITH tenant AS (
      SELECT timezone, default_currency
        FROM enterprise
       WHERE id = ${enterpriseId}::uuid
    ), bounds AS (
      SELECT (${monthStart}::timestamp AT TIME ZONE timezone) AS started_at,
             ((${monthStart}::date + interval '1 month')::timestamp AT TIME ZONE timezone) AS ended_at
        FROM tenant
    ), ledger AS (
      SELECT ll.provider_resource_id,
             count(DISTINCT ll.ai_request_id)::bigint AS request_count,
             coalesce(sum(ll.raw_input_tokens + ll.raw_output_tokens), 0)::numeric AS real_tokens,
             CASE WHEN count(*)=count(ll.api_cost)
                  THEN coalesce(sum(ll.api_cost), 0)::numeric(24,8)
                  ELSE NULL END AS api_cost,
             coalesce(sum(ll.deducted_quota), 0)::numeric AS deducted_quota,
             max(COALESCE(ll.settled_at,ll.created_at)) AS data_at
        FROM ledger_line ll, bounds b
       WHERE ll.enterprise_id = ${enterpriseId}::uuid
         AND COALESCE(ll.settled_at,ll.created_at) >= b.started_at
         AND COALESCE(ll.settled_at,ll.created_at) < b.ended_at
         ${asOf ? sql`AND COALESCE(ll.settled_at,ll.created_at) <= ${asOf}` : sql``}
       GROUP BY ll.provider_resource_id
    ), purchases AS (
      SELECT rpr.provider_resource_id,
             coalesce(sum(rpr.amount), 0)::numeric(24,8) AS cash_amount,
             max(rpr.purchased_at) AS data_at
        FROM resource_purchase_record rpr, bounds b
       WHERE rpr.enterprise_id = ${enterpriseId}::uuid
         AND rpr.purchased_at >= b.started_at
         AND rpr.purchased_at < b.ended_at
       GROUP BY rpr.provider_resource_id
    )
    SELECT pr.id AS resource_id,
           pr.provider_id,
           p.name AS provider_name,
           p.code AS provider_code,
           pr.name AS resource_name,
           pr.mode,
           pr.status AS resource_status,
           coalesce(l.request_count, 0) AS request_count,
           coalesce(l.real_tokens, 0)::text AS real_tokens,
           CASE WHEN l.provider_resource_id IS NULL THEN '0' ELSE l.api_cost::text END AS api_cost,
           coalesce(l.deducted_quota, 0)::text AS deducted_quota,
           coalesce(pu.cash_amount, 0)::text AS purchase_cash_amount,
           coalesce(s.currency, mb.currency, tenant.default_currency) AS currency,
           mb.amount::text AS budget_amount,
           mb.currency AS budget_currency,
           mb.version AS budget_version,
           mb.status AS budget_status,
           mb.created_at AS budget_updated_at,
           s.current_balance::text,
           s.package_cost::text,
           s.total_quota::text,
           s.used_quota::text,
           s.remaining_quota::text,
           s.quota_unit,
           to_char(s.effective_from AT TIME ZONE tenant.timezone, 'YYYY-MM-DD') AS service_period_start,
           to_char(s.effective_until AT TIME ZONE tenant.timezone, 'YYYY-MM-DD') AS service_period_end,
           CASE
             WHEN pr.mode = 'API' AND mb.status = 'ACTIVE' AND mb.amount > 0
              AND mb.currency = coalesce(s.currency, tenant.default_currency)
               THEN round(coalesce(l.api_cost, 0) / mb.amount, 8)::text
             WHEN pr.mode = 'CODING_PLAN'
              AND s.effective_from IS NOT NULL AND s.effective_until IS NOT NULL
              AND s.total_quota > 0 AND s.used_quota IS NOT NULL
               THEN round(s.used_quota / s.total_quota, 8)::text
             ELSE NULL
           END AS utilization_rate,
           CASE
             WHEN pr.mode = 'CODING_PLAN'
              AND s.effective_from IS NOT NULL AND s.effective_until IS NOT NULL
              AND s.package_cost IS NOT NULL
              AND s.total_quota > 0 AND s.used_quota IS NOT NULL
               THEN round(s.package_cost * greatest(0, 1 - s.used_quota / s.total_quota), 8)::text
             ELSE NULL
           END AS idle_entitlement_cost,
           f.rate_1h::text,
           f.rate_24h::text,
           f.rate_7d::text,
           CASE WHEN f.is_current THEN f.forecast_exhaust_at ELSE NULL END AS forecast_exhaust_at,
           CASE WHEN f.is_current THEN f.next_recover_at ELSE NULL END AS next_recover_at,
           CASE WHEN f.is_current THEN f.coverage_hours::text ELSE NULL END AS coverage_hours,
           f.confidence AS forecast_confidence,
           CASE
             WHEN f.id IS NULL THEN 'NOT_AVAILABLE'
             WHEN NOT f.is_current THEN 'STALE'
             WHEN f.forecast_exhaust_at IS NULL THEN 'NOT_CALCULABLE'
             ELSE 'CURRENT'
           END AS forecast_status,
           CASE
             WHEN f.id IS NULL THEN 'FORECAST_NOT_AVAILABLE'
             WHEN f.snapshot_at < now() - interval '15 minutes' THEN 'FORECAST_STALE'
             WHEN s.id IS NULL THEN 'OPERATING_SNAPSHOT_NOT_AVAILABLE'
             WHEN f.snapshot_at < s.collected_at THEN 'FORECAST_FACT_MISMATCH'
             WHEN NOT f.balance_matches THEN 'FORECAST_FACT_MISMATCH'
             ELSE f.not_calculable_reason
           END AS forecast_not_calculable_reason,
           f.snapshot_at AS forecast_data_at,
           lu.used_at AS last_settled_request_at,
           CASE WHEN lu.used_at IS NULL THEN NULL
                ELSE greatest(0, floor(extract(epoch FROM (now() - lu.used_at)) / 86400)::integer) END
             AS continuous_no_call_days,
           CASE
             WHEN pr.mode = 'API' AND mb.status = 'ACTIVE' AND mb.amount > 0
              AND mb.currency = coalesce(s.currency, tenant.default_currency)
               THEN 'API_MONTHLY_BUDGET'
             WHEN pr.mode = 'CODING_PLAN'
              AND s.effective_from IS NOT NULL AND s.effective_until IS NOT NULL
              AND s.total_quota > 0 AND s.used_quota IS NOT NULL
               THEN 'CODING_PLAN_SUBSCRIPTION_PERIOD'
             ELSE NULL
           END AS utilization_basis,
           CASE
             WHEN pr.mode = 'API' AND coalesce(mb.status, 'CLEARED') <> 'ACTIVE' THEN 'NOT_CONFIGURED'
             WHEN pr.mode = 'API' AND mb.currency <> coalesce(s.currency, tenant.default_currency) THEN 'UNKNOWN'
             WHEN pr.mode = 'API' AND coalesce(l.api_cost, 0) >= mb.amount THEN 'OVER_BUDGET'
             WHEN pr.mode = 'API' AND coalesce(l.api_cost, 0) >= mb.amount * 0.8 THEN 'WARNING'
             WHEN pr.mode = 'API' THEN 'NORMAL'
             WHEN pr.mode = 'CODING_PLAN'
              AND (s.effective_from IS NULL OR s.effective_until IS NULL) THEN 'UNKNOWN'
             WHEN pr.status = 'EXHAUSTED' THEN 'EXHAUSTED'
             WHEN s.total_quota > 0 AND s.used_quota >= s.total_quota THEN 'EXHAUSTED'
             WHEN s.total_quota > 0 AND s.used_quota < s.total_quota THEN 'UNDERUSED'
             WHEN qw.id IS NOT NULL OR q5.id IS NOT NULL THEN 'WINDOW_FACT_ONLY'
             ELSE 'UNKNOWN'
           END AS utilization_status,
           CASE
             WHEN pr.mode = 'API' AND coalesce(mb.status, 'CLEARED') <> 'ACTIVE' THEN 'MONTHLY_BUDGET_NOT_CONFIGURED'
             WHEN pr.mode = 'API' AND mb.currency <> coalesce(s.currency, tenant.default_currency)
              THEN 'BUDGET_CURRENCY_MISMATCH'
             WHEN pr.mode = 'CODING_PLAN' AND s.effective_from IS NULL
              THEN 'SUBSCRIPTION_PERIOD_START_NOT_AVAILABLE'
             WHEN pr.mode = 'CODING_PLAN' AND s.effective_until IS NULL
              THEN 'SUBSCRIPTION_PERIOD_END_NOT_AVAILABLE'
             WHEN pr.mode = 'CODING_PLAN'
              AND (s.total_quota IS NULL OR s.total_quota <= 0)
               THEN 'SUBSCRIPTION_QUOTA_FACT_NOT_AVAILABLE'
             WHEN pr.mode = 'CODING_PLAN' AND s.used_quota IS NULL
              THEN 'SUBSCRIPTION_DEDUCTION_FACT_INCOMPLETE'
             ELSE NULL
           END AS not_calculable_reason,
             greatest(l.data_at, pu.data_at, lu.used_at, s.collected_at, f.snapshot_at,
                      qw.collected_at, q5.collected_at, mb.created_at) AS data_at
      FROM provider_resource pr
      JOIN provider p ON p.id = pr.provider_id AND p.enterprise_id = pr.enterprise_id
      CROSS JOIN tenant
      LEFT JOIN LATERAL (
        SELECT budget.*
          FROM provider_resource_monthly_budget budget
         WHERE budget.enterprise_id = pr.enterprise_id
           AND budget.provider_resource_id = pr.id
           AND budget.month = ${monthStart}::date
           AND budget.is_current = true
         LIMIT 1
      ) mb ON true
      LEFT JOIN ledger l ON l.provider_resource_id = pr.id
      LEFT JOIN purchases pu ON pu.provider_resource_id = pr.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(ll.settled_at,ll.created_at) AS used_at
          FROM ledger_line ll
         WHERE ll.enterprise_id = pr.enterprise_id
           AND ll.provider_resource_id = pr.id
         ORDER BY COALESCE(ll.settled_at,ll.created_at) DESC, ll.created_at DESC, ll.id DESC
         LIMIT 1
      ) lu ON true
      LEFT JOIN LATERAL (
        SELECT os.* FROM provider_resource_operating_snapshot os
         WHERE os.enterprise_id = pr.enterprise_id AND os.provider_resource_id = pr.id
         ORDER BY os.collected_at DESC, os.version DESC LIMIT 1
      ) s ON true
      LEFT JOIN LATERAL (
        SELECT sf.*,
               sf.snapshot_at >= now() - interval '15 minutes'
                 AND s.id IS NOT NULL
                 AND sf.snapshot_at >= s.collected_at
                 AND (sf.forecast_exhaust_at IS NULL OR sf.forecast_exhaust_at>=sf.snapshot_at OR COALESCE(sf.remaining_quota,0)=0)
                 AND (
                   (pr.mode = 'API' AND sf.remaining_quota IS NOT DISTINCT FROM s.current_balance)
                   OR (pr.mode = 'CODING_PLAN' AND sf.remaining_quota IS NOT DISTINCT FROM s.remaining_quota)
                 ) AS is_current,
               (
                 (pr.mode = 'API' AND sf.remaining_quota IS NOT DISTINCT FROM s.current_balance)
                 OR (pr.mode = 'CODING_PLAN' AND sf.remaining_quota IS NOT DISTINCT FROM s.remaining_quota)
               ) AS balance_matches
          FROM supply_forecast sf
         WHERE sf.enterprise_id = pr.enterprise_id AND sf.provider_resource_id = pr.id
         ORDER BY sf.snapshot_at DESC LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT w.* FROM provider_quota_window w
         WHERE w.enterprise_id = pr.enterprise_id AND w.provider_resource_id = pr.id
           AND w.window_type = 'WEEKLY'
           AND w.is_current = true
         ORDER BY w.collected_at DESC LIMIT 1
      ) qw ON true
      LEFT JOIN LATERAL (
        SELECT w.* FROM provider_quota_window w
         WHERE w.enterprise_id = pr.enterprise_id AND w.provider_resource_id = pr.id
           AND w.window_type = 'FIVE_HOUR'
           AND w.is_current = true
         ORDER BY w.collected_at DESC LIMIT 1
      ) q5 ON true
     WHERE pr.enterprise_id = ${enterpriseId}::uuid
     ORDER BY p.name, pr.name, pr.id
  `.execute(db);
  const range = operatingBillMonthRange(month);
  const ledgerCosts = new Map(result.rows.filter((row) => row.mode === "API")
    .map((row) => [row.resource_id, row.api_cost]));
  const [windows, monthlyOperating] = await Promise.all([sql<{
    provider_resource_id: string; window_type: "FIVE_HOUR" | "WEEKLY";
    limit_value: string | null; used_value: string | null; remaining_value: string | null;
    ratio: string | null; unit: "PERCENT" | "POINT" | null; reset_at: Date | null;
    provider_data_at: Date | null; collected_at: Date;
    sync_status: "SUCCESS" | "STALE" | "FAILED" | "UNSUPPORTED"; sync_error_code: string | null;
  }>`
    SELECT provider_resource_id, window_type, limit_value::text, used_value::text,
           remaining_value::text, ratio::text, unit, reset_at, provider_data_at,
           collected_at, sync_status, sync_error_code
      FROM provider_quota_window
     WHERE enterprise_id = ${enterpriseId}::uuid AND is_current
     ORDER BY provider_resource_id, window_type
  `.execute(db), loadMonthlyOperatingCosts(db, enterpriseId, range.start, range.end, ledgerCosts)]);
  const byResource = new Map<string, QuotaWindowFact[]>();
  for (const window of windows.rows) {
    const list = byResource.get(window.provider_resource_id) ?? [];
    list.push({
      type: window.window_type,
      limitValue: window.limit_value, usedValue: window.used_value,
      remainingValue: window.remaining_value, ratio: window.ratio, unit: window.unit,
      resetAt: window.reset_at?.toISOString() ?? null,
      providerDataAt: window.provider_data_at?.toISOString() ?? null,
      collectedAt: window.collected_at.toISOString(), syncStatus: window.sync_status,
      syncErrorCode: window.sync_error_code,
    });
    byResource.set(window.provider_resource_id, list);
  }
  const operatingByResource = new Map(
    monthlyOperating.resources.map((resource) => [resource.resourceId, resource]),
  );
  return result.rows.map((row) => ({
    ...applyApiBudgetFacts(mapRow(row), operatingByResource.get(row.resource_id)),
    quotaWindows: byResource.get(row.resource_id) ?? [],
  }));
}

function mapRow(row: RawUtilizationRow): Omit<ResourceUtilizationRow, "quotaWindows"> {
  return {
    resourceId: row.resource_id, providerId: row.provider_id,
    providerName: row.provider_name, providerCode: row.provider_code, resourceName: row.resource_name,
    mode: row.mode, resourceStatus: row.resource_status,
    requestCount: Number(row.request_count), realTokens: row.real_tokens,
    apiCost: row.api_cost, deductedQuota: row.deducted_quota,
    purchaseCashAmount: row.purchase_cash_amount, currency: row.currency,
    budgetAmount: row.budget_amount,
    budgetCurrency: row.budget_currency,
    budgetVersion: row.budget_version ?? 0,
    budgetStatus: row.budget_status ?? "NOT_CONFIGURED",
    budgetUpdatedAt: row.budget_updated_at?.toISOString() ?? null,
    budgetDifference: null,
    currentBalance: row.current_balance,
    packageCost: row.package_cost, totalQuota: row.total_quota,
    usedQuota: row.used_quota, remainingQuota: row.remaining_quota,
    quotaUnit: row.quota_unit,
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    utilizationRate: row.utilization_rate,
    idleEntitlementCost: row.idle_entitlement_cost,
    rate1h: row.rate_1h,
    rate24h: row.rate_24h,
    rate7d: row.rate_7d,
    forecastExhaustAt: row.forecast_exhaust_at?.toISOString() ?? null,
    nextRecoverAt: row.next_recover_at?.toISOString() ?? null,
    coverageHours: row.coverage_hours,
    forecastConfidence: row.forecast_confidence,
    forecastStatus: row.forecast_status,
    forecastNotCalculableReason: row.forecast_not_calculable_reason,
    forecastDataAt: row.forecast_data_at?.toISOString() ?? null,
    lastSettledRequestAt: row.last_settled_request_at?.toISOString() ?? null,
    continuousNoCallDays: row.continuous_no_call_days === null ? null : Number(row.continuous_no_call_days),
    idleStatus: "UNASSESSED",
    utilizationBasis: row.utilization_basis,
    utilizationStatus: row.utilization_status,
    notCalculableReason: row.not_calculable_reason,
    dataAt: row.data_at?.toISOString() ?? null,
  };
}
