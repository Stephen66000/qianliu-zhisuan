export const PROVIDER_FINANCE_CUTOVER = new Date("2026-08-31T16:00:00.000Z");
/**
 * 0060 只用于封住切换日至暗部署完成之间的 DeepSeek 历史动态费用。
 * 该时点来自生产厂商余额证据，之后的新未知费用必须保持失败关闭。
 */
export const PROVIDER_FINANCE_LEGACY_COST_CUTOFF = new Date("2026-09-03T06:56:18.540Z");

export type FinanceCurrency = "CNY" | "USD";
export type FinanceEventType =
  | "API_OPENING_BALANCE" | "API_OPENING_BALANCE_CORRECTION" | "API_RECHARGE"
  | "API_BALANCE_RECONCILIATION" | "API_LEGACY_COST_ADJUSTMENT" | "CODING_PLAN_PURCHASE"
  | "CODING_PLAN_RENEWAL" | "REVERSAL";
export type FinanceBalanceState =
  | "NORMAL" | "MISSING_OPENING_BALANCE" | "INCOMPLETE_USAGE_COST"
  | "NEGATIVE_RECONCILIATION_REQUIRED" | "LEGACY_ARCHIVED";

export interface FinanceEventView {
  id: string;
  providerResourceId: string;
  eventType: FinanceEventType;
  accountAmount: string;
  accountCurrency: FinanceCurrency;
  cashPaidCny: string | null;
  occurredAt: string;
  externalReference: string | null;
  reversalOfEventId: string | null;
  correctionOfEventId: string | null;
  reconciliationCaseId: string | null;
  legacyCostResolutionId: string | null;
  description: string | null;
  evidenceRef: string | null;
  source: string;
  createdAt: string;
  replayed?: boolean;
}

export interface FinanceBalanceView {
  providerResourceId: string;
  currency: FinanceCurrency;
  asOf: string;
  state: FinanceBalanceState;
  balance: string | null;
  components: {
    openingBalance: string;
    openingCorrections: string;
    recharges: string;
    usageDebits: string;
    balanceReconciliations: string;
    legacyCostAdjustments: string;
    reversals: string;
  };
  factWatermark: {
    latestFinanceEventId: string | null;
    latestFinanceOccurredAt: string | null;
    latestLedgerLineId: string | null;
    latestSettledAt: string | null;
  };
  reconciliationCaseId: string | null;
  gaps: Array<{ code: string; requestId?: string; ledgerLineId?: string }>;
}

export interface FinanceEventInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  accountAmount: string;
  accountCurrency: FinanceCurrency;
  cashPaidCny?: string | null;
  occurredAt: Date;
  externalReference?: string | null;
  description?: string | null;
  evidenceRef?: string | null;
  idempotencyKey: string;
  duplicateCandidateId?: string | null;
  duplicateConfirmationToken?: string | null;
}

export interface SubscriptionInput extends FinanceEventInput {
  autoRenew?: boolean;
  kind: "PURCHASE" | "RENEWAL";
  productName: string;
  periodStart: Date;
  periodEndExclusive: Date;
}

export interface OpeningCorrectionInput extends FinanceEventInput {
  openingEventId: string;
}

export interface ReverseFinanceEventInput {
  enterpriseId: string;
  eventId: string;
  adminId: string;
  reason: string;
  evidenceRef: string;
  idempotencyKey: string;
}

export interface ReconciliationCaseInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  accountCurrency: FinanceCurrency;
  providerConfirmedBalance: string;
  balanceAsOf: Date;
  evidenceRef: string;
}

export interface DuplicateConfirmationInput {
  enterpriseId: string;
  candidateId: string;
  adminId: string;
  confirmationToken: string;
  requestHash: string;
  idempotencyKey: string;
}

export interface MonthlyFinanceSummary {
  month: string;
  timezone: "Asia/Shanghai";
  cashOutflowCny: string;
  apiRecharges: Array<{ currency: FinanceCurrency; amount: string }>;
  apiOperatingCosts: Array<{ currency: FinanceCurrency; amount: string }>;
  codingPlanOrders: Array<{ currency: FinanceCurrency; amount: string }>;
  codingPlanFixedCostCny: string;
  operatingCostCny: string;
  operatingCostByCurrency: Array<{ currency: FinanceCurrency; amount: string }>;
  currentApiBalances: Array<{ currency: FinanceCurrency; amount: string }>;
  currentApiBalancesComplete: boolean;
  complete: boolean;
  gaps: Array<{ code: string; count: number }>;
}

export interface ResourceFinanceView {
  resourceId: string;
  providerCode: string;
  mode: "API" | "CODING_PLAN";
  accounts: Array<{
    currency: FinanceCurrency;
    balanceState: FinanceBalanceState;
    balance: string | null;
    monthOpeningState: FinanceBalanceState;
    monthOpeningBalance: string | null;
    monthlyRecharge: string;
    monthlyApiCost: string;
  }>;
  monthlyPlanCashCny: string;
  currentPeriod: null | {
    id: string;
    productName: string;
    periodStart: string;
    periodEndExclusive: string;
    fixedFeeAmount: string | null;
    fixedFeeCurrency: FinanceCurrency | null;
    fixedCashPaidCny: string | null;
    totalQuota: string | null;
    quotaUnit: string | null;
    trueTokens: string;
    deductedQuota: string | null;
    deductedQuotaComplete: boolean;
    requestCount: string;
  };
}

export class ProviderFinanceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_MODE" | "INVALID_REQUEST" | "CONFLICT" | "IDEMPOTENCY_CONFLICT" | "DUPLICATE_CONFIRMATION_REQUIRED",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ProviderFinanceError";
  }
}
