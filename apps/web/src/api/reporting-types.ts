/** 首页看板与用量查询的只读 API 契约。 */
export interface EarliestExhaustion {
  resourceId: string;
  resourceName: string;
  providerCode: string;
  forecastExhaustAt: string | null;
  nextRecoverAt: string | null;
  confidence: string;
  notCalculableReason: string | null;
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
  snapshotAt: string | null;
  monthlyCost: string;
  monthlyInputTokens: string | null;
  monthlyOutputTokens: string | null;
  monthlyCacheTokens: string | null;
  monthlyReasoningTokens: string | null;
  monthlyTotalTokens: string | null;
  monthlyUsageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
  modelTokenBreakdown: Array<{
    unifiedModelId: string | null;
    modelAlias: string;
    inputTokens: string | null;
    outputTokens: string | null;
    cacheTokens: string | null;
    reasoningTokens: string | null;
    totalTokens: string | null;
    usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
  }>;
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

export interface OverageItem {
  principalId: string;
  principalName: string;
  principalType: string;
  provider: string;
  modelAlias: string;
  quotaValue: string;
  usedValue: string;
  overageValue: string;
  /** 小数文本（如 "0.0500"），展示百分比时需 ×100。 */
  overageRatio: string;
}

export interface DashboardSummary {
  resourceAccountCount: number;
  activeEmployeeCount: number;
  currentInUseCount: number;
  monthlyPackagePayment: string | null;
  monthlyApiCost: string;
  monthlyRechargeAmount: string | null;
  earliestExhaustion: EarliestExhaustion | null;
  monthlyDispatchSaving: string;
  resourceBreakdown: ResourceBreakdownItem[];
  overageList: OverageItem[];
  monthlyTokenUsage: {
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCacheTokens: string;
    totalReasoningTokens: string;
    totalTokens: string;
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

export interface UsageRecord {
  requestId: string;
  principalId: string;
  principalName: string;
  principalType: string;
  clientId: string | null;
  agentFamily: string;
  agentVersion: string | null;
  agentIdentitySource: string;
  agentIdentityConfidence: string;
  clientIdentityRuleVersion: string;
  unifiedModel: string;
  status: string;
  errorClassification: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  finalProviderId: string | null;
  finalProviderCode: string | null;
  finalProviderName: string | null;
  finalProviderResourceId: string | null;
  finalProviderResourceName: string | null;
  overage: boolean | null;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalCacheTokens: string;
  totalDeductedQuota: string;
  totalApiCost: string;
  usageQuality: string;
  attemptCount: number;
}

export interface UsageResult {
  records: UsageRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface UsageQueryParams {
  limit?: number;
  offset?: number;
  search?: string;
  principal_id?: string;
  project_id?: string;
  client_id?: string;
  agent_family?: string;
  provider_id?: string;
  provider_resource_id?: string;
  unified_model?: string;
  status?: string;
  from?: string;
  to?: string;
  overage_only?: boolean;
}

export interface AgentUsageSummary {
  agentFamily: string;
  latestVersion: string | null;
  identitySource: string;
  identityConfidence: string;
  firstUsedAt: string;
  lastUsedAt: string;
  requestCount: string;
  totalTokens: string;
  totalApiCost: string;
  models: string[];
}

export interface AgentUsageResult {
  agents: AgentUsageSummary[];
  expectedAgentFamilies: string[];
}
