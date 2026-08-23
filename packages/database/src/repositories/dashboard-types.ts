export interface DashboardSummary {
  resourceAccountCount: number;
  activeEmployeeCount: number;
  currentInUseCount: number;
  monthlyPackagePayment: string | null;
  monthlyPackagePayments: Array<{ currency: string; amount: string }>;
  monthlyApiCost: string | null;
  monthlyApiCosts: Array<{ currency: string; amount: string }>;
  monthlyApiSpendReason: string | null;
  /** 套餐支出与余额桥接 API 花费的后端精确合计；任一经营事实不完整时不可计算。 */
  monthlyTotalSpend: string | null;
  monthlyTotalSpends: Array<{ currency: string; amount: string }>;
  monthlyRechargeAmount: string | null;
  monthlyRechargeAmounts: Array<{ currency: string; amount: string }>;
  earliestExhaustion: {
    resourceId: string;
    resourceName: string;
    providerCode: string;
    forecastExhaustAt: string | null;
    nextRecoverAt: string | null;
    confidence: string;
    notCalculableReason: string | null;
  } | null;
  monthlyDispatchSaving: string;
  dispatchSavingBreakdown: {
    realizedAmount: string;
    realizedSwitchCount: number;
    actualSwitchCount: number;
    realizedReason: string | null;
    potentialPeakSavingAmount: string | null;
    potentialReason: string | null;
    avoidedPeakDeduction: string;
    avoidedDeductionCount: number;
    avoidedReason: string | null;
    rejectedRequestCount: number;
  };
  resourceStatus: ResourceStatusSummary;
  overageList: OverageItem[];
  monthlyTokenUsage: {
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCacheTokens: string;
    totalReasoningTokens: string;
    totalTokens: string;
    usageQuality: "NO_DATA" | "PROVIDER_REPORTED" | "ESTIMATED" | "ACCOUNT_AGGREGATED" | "MIXED" | "UNKNOWN";
    settledTransactionCount: number;
    providerReportedTransactionCount: number;
    estimatedTransactionCount: number;
    accountAggregatedTransactionCount: number;
    mixedTransactionCount: number;
    unknownTransactionCount: number;
    attributionBasis: "LEDGER_TRANSACTION_SETTLED_AT";
    rangeStart: string;
    rangeEndExclusive: string;
    employeeRanking: Array<{
      principalId: string;
      principalName: string;
      inputTokens: string;
      outputTokens: string;
      cacheTokens: string;
      reasoningTokens: string;
      totalTokens: string;
      share: string;
    }>;
  };
}

export interface ResourceStatusSummary {
  total: number;
  status: string;
  statusCounts: Record<string, number>;
  abnormalResources: Array<{
    resourceId: string;
    resourceName: string;
    providerName: string;
    mode: "API" | "CODING_PLAN";
    status: string;
  }>;
}

export interface ResourceUsageOverview {
  generatedAt: string;
  providerSummaries: ResourceBreakdownItem[];
  modelDetails: ResourceModelUsageDetail[];
}

export interface ResourceModelUsageDetail {
  resourceId: string;
  resourceName: string;
  providerCode: string;
  providerName: string;
  mode: "API" | "CODING_PLAN";
  unifiedModelId: string | null;
  modelAlias: string;
  usedQuota: string | null;
  remainingQuota: string | null;
  quotaUnit: string | null;
  currency: string | null;
  monthlyCost: string | null;
  monthlyCostReason: string | null;
  monthlyTotalTokens: string | null;
  usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
  unknownCount?: number;
  historicalUnattributed?: boolean;
  consumptionRate24h: string | null;
  consumptionRateUnit: "TOKEN_PER_HOUR" | "QUOTA_PER_HOUR" | null;
  consumptionRateReason: string | null;
  forecastExhaustAt: string | null;
  forecastNotCalculableReason: string | null;
  forecastConfidence: string | null;
  status: string;
}

export interface ResourceBreakdownItem {
  providerCode: string;
  providerName: string;
  mode: "API" | "CODING_PLAN";
  accountCount: number;
  totalQuota: string | null;
  usedQuota: string | null;
  remainingQuota: string | null;
  quotaUnit: string | null;
  allocatedQuota: string | null;
  currency: string | null;
  rechargeAmount: string | null;
  currentBalance: string | null;
  currentPeriodCost: string | null;
  packageCost: string | null;
  subscriptionPeriodStart: string | null;
  subscriptionPeriodEnd: string | null;
  snapshotAt: string | null;
  monthlyCost: string | null;
  monthlyCostReason: string | null;
  monthlyInputTokens: string | null;
  monthlyOutputTokens: string | null;
  monthlyCacheTokens: string | null;
  monthlyReasoningTokens: string | null;
  monthlyTotalTokens: string | null;
  monthlyUsageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
  monthlyUnknownCount?: number;
  modelTokenBreakdown: ResourceModelTokenBreakdown[];
  tokenRate24h: string | null;
  costRate24h: string | null;
  estimatedBalanceTokens: string | null;
  balanceTokenEstimateConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
  balanceTokenEstimateReason: string | null;
  balanceTokenEstimateBasis: string | null;
  currentRate24h: string | null;
  currentRateUnit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
  forecastConfidence: string | null;
  forecastNotCalculableReason: string | null;
  forecastDataPoints: number | null;
  forecastExhaustAt: string | null;
  status: string;
  statusCounts: Record<string, number>;
  abnormalResources: Array<{ resourceId: string; resourceName: string; status: string }>;
}

export interface ResourceModelTokenBreakdown {
  unifiedModelId: string | null;
  modelAlias: string;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheTokens: string | null;
  reasoningTokens: string | null;
  totalTokens: string | null;
  usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
  unknownCount?: number;
}

export interface OverageItem {
  principalId: string;
  principalName: string;
  principalType: string;
  provider: string;
  modelAlias: string;
  quotaValue: string;
  usedValue: string;
  overageValue: string;
  overageRatio: string;
}
