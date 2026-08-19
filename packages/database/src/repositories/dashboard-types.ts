export interface DashboardSummary {
  resourceAccountCount: number;
  activeEmployeeCount: number;
  currentInUseCount: number;
  monthlyPackagePayment: string | null;
  monthlyApiCost: string | null;
  monthlyApiSpendReason: string | null;
  /** 套餐支出与余额桥接 API 花费的后端精确合计；任一经营事实不完整时不可计算。 */
  monthlyTotalSpend: string | null;
  monthlyRechargeAmount: string | null;
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
  resourceBreakdown: ResourceBreakdownItem[];
  overageList: OverageItem[];
  monthlyTokenUsage: {
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCacheTokens: string;
    totalReasoningTokens: string;
    totalTokens: string;
    usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
    settledTransactionCount: number;
    estimatedTransactionCount: number;
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
