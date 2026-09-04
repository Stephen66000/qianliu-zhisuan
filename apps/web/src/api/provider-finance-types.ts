export type FinanceCurrency = "CNY" | "USD";

export type FinanceEventType =
  | "API_OPENING_BALANCE" | "API_OPENING_BALANCE_CORRECTION" | "API_RECHARGE"
  | "API_BALANCE_RECONCILIATION" | "API_LEGACY_COST_ADJUSTMENT"
  | "CODING_PLAN_PURCHASE" | "CODING_PLAN_RENEWAL" | "REVERSAL";

export interface ProviderFinanceBalance {
  providerResourceId: string;
  currency: FinanceCurrency;
  asOf: string;
  state: "NORMAL" | "MISSING_OPENING_BALANCE" | "INCOMPLETE_USAGE_COST"
    | "NEGATIVE_RECONCILIATION_REQUIRED" | "LEGACY_ARCHIVED";
  balance: string | null;
  components: {
    openingBalance: string; openingCorrections: string; recharges: string;
    usageDebits: string; balanceReconciliations: string;
    legacyCostAdjustments: string; reversals: string;
  };
  gaps: Array<{ code: string; requestId?: string; ledgerLineId?: string }>;
}

export interface ProviderFinanceEvent {
  id: string; providerResourceId: string; eventType: FinanceEventType;
  accountAmount: string; accountCurrency: FinanceCurrency; cashPaidCny: string | null;
  occurredAt: string; externalReference: string | null; description: string | null;
  source: string; createdAt: string; replayed?: boolean;
}

export interface ProviderFinanceSummary {
  month: string; timezone: "Asia/Shanghai"; cashOutflowCny: string;
  apiRecharges: Array<{ currency: FinanceCurrency; amount: string }>;
  apiOperatingCosts: Array<{ currency: FinanceCurrency; amount: string }>;
  codingPlanOrders: Array<{ currency: FinanceCurrency; amount: string }>;
  codingPlanFixedCostCny: string; operatingCostCny: string;
  operatingCostByCurrency: Array<{ currency: FinanceCurrency; amount: string }>;
  currentApiBalances: Array<{ currency: FinanceCurrency; amount: string }>;
  currentApiBalancesComplete: boolean;
  complete: boolean; gaps: Array<{ code: string; count: number }>;
}

export interface ProviderSubscriptionPeriod {
  id: string; provider_resource_id: string; product_name: string;
  period_start: string; period_end_exclusive: string; source: string;
  current_status: "ACTIVE" | "UPCOMING" | "EXPIRED" | "REVERSED";
  fixed_fee_amount: string | null; fixed_fee_currency: FinanceCurrency | null;
  fixed_cash_paid_cny: string | null;
  token_usage: { request_count: string; input_tokens: string; output_tokens: string;
    cache_tokens: string; reasoning_tokens: string; true_tokens: string };
}

export interface ResourceFinanceView {
  resourceId: string; providerCode: string; mode: "API" | "CODING_PLAN";
  accounts: Array<{ currency: FinanceCurrency; balanceState: ProviderFinanceBalance["state"];
    balance: string | null; monthOpeningState: ProviderFinanceBalance["state"];
    monthOpeningBalance: string | null; monthlyRecharge: string; monthlyApiCost: string }>;
  monthlyPlanCashCny: string;
  currentPeriod: null | { id: string; productName: string; periodStart: string;
    periodEndExclusive: string; fixedFeeAmount: string | null;
    fixedFeeCurrency: FinanceCurrency | null; fixedCashPaidCny: string | null;
    totalQuota: string | null; quotaUnit: string | null;
    trueTokens: string; deductedQuota: string | null;
    deductedQuotaComplete: boolean; requestCount: string };
}
