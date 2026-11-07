/**
 * 资源利用率行契约与映射：对外行结构（ResourceUtilizationRow/QuotaWindowFact）、
 * 原生 SQL 行结构（RawUtilizationRow）与行映射 mapRow。
 * query.ts 负责查询编排；本文件只承载行类型与逐字段映射（零行为拆分）。
 */

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
  /** API 行经 projectFinanceUtilization 收口后恒 null（WP2 遗留②；充值/余额退出展示投影）。 */
  purchaseCashAmount: string | null;
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

export interface RawUtilizationRow {
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

export function mapRow(row: RawUtilizationRow): Omit<ResourceUtilizationRow, "quotaWindows"> {
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
