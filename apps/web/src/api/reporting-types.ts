/** 首页看板与用量查询的只读 API 契约。 */
import type { UsageOverview } from "./v2-types";
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
  modelTokenBreakdown: Array<{
    unifiedModelId: string | null;
    modelAlias: string;
    inputTokens: string | null;
    outputTokens: string | null;
    cacheTokens: string | null;
    reasoningTokens: string | null;
    totalTokens: string | null;
    usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
    unknownCount?: number;
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

export interface ResourceUsageOverview {
  generatedAt: string;
  providerSummaries: ResourceBreakdownItem[];
  modelDetails: ResourceModelUsageDetail[];
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
  monthlyPackagePayments: Array<{ currency: string; amount: string }>;
  monthlyApiCost: string | null;
  monthlyApiCosts: Array<{ currency: string; amount: string }>;
  monthlyApiSpendReason: string | null;
  monthlyTotalSpend: string | null;
  monthlyTotalSpends: Array<{ currency: string; amount: string }>;
  monthlyRechargeAmount: string | null;
  monthlyRechargeAmounts: Array<{ currency: string; amount: string }>;
  earliestExhaustion: EarliestExhaustion | null;
  monthlyDispatchSaving: string;
  dispatchSavingBreakdown: {
    realizedAmount: string; realizedSwitchCount: number; actualSwitchCount: number; realizedReason: string | null;
    potentialPeakSavingAmount: string | null; potentialReason: string | null;
    avoidedPeakDeduction: string; avoidedDeductionCount: number; avoidedReason: string | null;
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
  employeeUsageOverview?: UsageOverview;
}

/** 标准版首页两分区聚合（GET /dashboard/home，HOME-STANDARD-20260910）。镜像 database 包 dashboard-home.ts。 */
export interface StandardHomeWindow {
  rangeStart: string;
  rangeEndExclusive: string;
  truncated: boolean;
}

export type ProviderStatusCategory = "NORMAL" | "PARTIAL_ABNORMAL" | "ABNORMAL" | "PENDING_CONFIRM";

export interface StandardHomeProviderRow {
  providerCode: string;
  providerName: string;
  resourceCount: number;
  modes: Array<{ mode: "API" | "CODING_PLAN"; count: number }>;
  worstStatus: string;
  statusLabel: string;
  statusCategory: ProviderStatusCategory;
  abnormalResourceCount: number;
  attention: string | null;
  syncFailed: boolean;
  syncStale: boolean;
  lastSyncAt: string | null;
}

export interface StandardHomeSummary {
  asOf: string;
  month: string;
  tokenUsage: {
    rangeStart: string;
    rangeEndExclusive: string;
    current: {
      totalTokens: string;
      inputTokens: string;
      outputTokens: string;
      usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
      unknownCount: number;
    };
    /** 同期也携带质量/完整性（R01-F02）：分母不完整时禁止正常百分比。 */
    previous: {
      totalTokens: string;
      usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
      unknownCount: number;
      window: StandardHomeWindow;
    };
  };
  monthlyCost: {
    month: string;
    billStatus: "DRAFT" | "CLOSED";
    current: {
      totalSpends: Array<{ currency: string; amount: string }>;
      apiSpends: Array<{ currency: string; amount: string }>;
      packageCosts: Array<{ currency: string; amount: string }>;
      incompleteReason: string | null;
    };
    previous: {
      totalSpends: Array<{ currency: string; amount: string }>;
      incompleteReason: string | null;
      basis: "FINANCE_READ_MODEL" | "BALANCE_BRIDGE";
      window: StandardHomeWindow;
    } | null;
  };
  activeEmployees: {
    timezone: string;
    rangeStart: string;
    rangeEndExclusive: string;
    current: number;
    previous: { count: number; window: StandardHomeWindow };
  };
  activeProjects: {
    rangeStart: string;
    rangeEndExclusive: string;
    current: number;
    previous: { count: number; window: StandardHomeWindow };
  };
  resources: {
    providerCount: number;
    resourceCount: number;
    attentionProviderCount: number;
    updatedAt: string | null;
    providers: StandardHomeProviderRow[];
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
  totalReasoningTokens: string;
  totalDeductedQuota: string;
  totalApiCost: string;
  costCurrency?: string | null;
  usageQuality: string;
  attemptCount: number;
  hasSettlement: boolean;
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
  subject_type?: "EMPLOYEE" | "PROJECT";
  client_id?: string;
  agent_family?: string;
  provider_id?: string;
  provider_resource_id?: string;
  unified_model?: string;
  status?: string;
  from?: string;
  to?: string;
  to_exclusive?: string;
  overage_only?: boolean;
  settled_only?: boolean;
}

export interface AgentUsageSummary {
  agentFamily: string;
  latestVersion: string | null;
  identitySource: string;
  identitySources: string[];
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
