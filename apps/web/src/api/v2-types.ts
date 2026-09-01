export interface EnterpriseSettings {
  id: string;
  name: string;
  timezone: string;
  default_currency: string;
  version: number;
  updated_at: string;
}

export type DirectorySourceType = "WECOM" | "FEISHU";
export interface DirectorySource {
  id: string;
  type: DirectorySourceType;
  config_fingerprint: string;
  status: "ACTIVE" | "DISABLED" | "ERROR";
  cursor: string | null;
  version: number;
  updated_at: string;
}
export interface OrganizationUnit {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  status: string;
  version: number;
}
export interface ProjectDepartmentAssignment {
  id: string;
  organization_unit_id: string;
  department_name: string;
  version: number;
  source: "EXPLICIT" | "OWNER_DEPARTMENT_DEFAULT";
  valid_from: string;
  valid_until?: string | null;
  reason: string | null;
}
export interface DirectoryMember {
  person_id: string;
  principal_id: string | null;
  name: string;
  employee_number: string | null;
  department_id: string | null;
  department_name: string | null;
  source_type: DirectorySourceType | "EXCEL" | null;
  external_member_id: string | null;
  person_status: string;
  principal_status: string | null;
  access_config_status: "CONFIGURED" | "PENDING" | "MISSING";
}
export interface DirectoryImportRun {
  id: string;
  source_type: DirectorySourceType | "EXCEL";
  import_type: "SYNC" | "EXCEL";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
  total_count: number;
  success_count: number;
  conflict_count: number;
  failed_count: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface DirectoryImportItem {
  id: string;
  row_number: number | null;
  normalized_name: string;
  normalized_department: string | null;
  status: "STAGED" | "PROCESSING" | "MATCHED" | "CREATED" | "UPDATED" | "CONFLICT" | "SKIPPED" | "FAILED";
  reason_code: string | null;
  person_id: string | null;
  principal_id: string | null;
}

export interface UsageOverview {
  subjectType: "EMPLOYEE" | "PROJECT";
  subjectId: string | null;
  period: "TODAY" | "WEEK" | "MONTH";
  anchor: string;
  timezone: string;
  range: { from: string; to: string };
  metrics: {
    activeSubjects: number; requestCount: string; inputTokens: string; outputTokens: string;
    realTokens: string; cacheTokens: string; reasoningTokens: string;
    apiCost: string; deductedQuota: string;
    usageQuality: "NO_DATA" | "PROVIDER_REPORTED" | "ESTIMATED" | "ACCOUNT_AGGREGATED" | "MIXED" | "UNKNOWN";
    providerReportedCount: number; estimatedCount: number; accountAggregatedCount: number;
    mixedCount: number; unknownCount: number;
  };
  trend: Array<{ bucketStart: string; bucketEnd: string; label: string; collectionStatus: "COMPLETE" | "MISSING"; requestCount: string; inputTokens: string; outputTokens: string; cacheTokens: string; reasoningTokens: string; realTokens: string; apiCost: string; deductedQuota: string; usageQuality?: UsageOverview["metrics"]["usageQuality"]; providerReportedCount?: number; estimatedCount?: number; accountAggregatedCount?: number; mixedCount?: number; unknownCount?: number }>;
  ranking: Array<{ subjectId: string; subjectName: string; departmentLabel: string | null; requestCount: string; inputTokens: string; outputTokens: string; cacheTokens: string; reasoningTokens: string; realTokens: string; apiCost: string; deductedQuota: string; usageQuality?: UsageOverview["metrics"]["usageQuality"]; providerReportedCount?: number; estimatedCount?: number; accountAggregatedCount?: number; mixedCount?: number; unknownCount?: number; share: string }>;
  factWatermark: string | null;
  generatedAt: string;
  detailQuery: {
    principalId: string | null;
    projectId: string | null;
    subjectType: "EMPLOYEE" | "PROJECT";
    settledOnly: true;
    from: string;
    toExclusive: string;
  };
  stale: boolean;
  source: "LIVE_LEDGER" | "BUCKET_AGGREGATE";
}

export interface ResourceUtilization {
  resourceId: string; providerId: string; providerName: string; resourceName: string;
  mode: "API" | "CODING_PLAN"; resourceStatus: string; requestCount: number;
  realTokens: string; apiCost: string | null; deductedQuota: string; purchaseCashAmount: string | null;
  ledgerApiCost?: string | null; apiSpendReason?: string | null;
  purchaseCashAmounts?: Array<{ currency: string; amount: string }>;
  currency: string | null; budgetAmount: string | null; budgetCurrency: string | null;
  budgetVersion: number; budgetStatus: "ACTIVE" | "CLEARED" | "NOT_CONFIGURED";
  budgetUpdatedAt: string | null; budgetDifference: string | null; currentBalance: string | null;
  packageCost: string | null; totalQuota: string | null; usedQuota: string | null;
  remainingQuota: string | null; quotaUnit: string | null;
  servicePeriodStart?: string | null; servicePeriodEnd?: string | null;
  utilizationRate: string | null;
  idleEntitlementCost: string | null; rate1h: string | null; rate24h: string | null;
  rate7d: string | null; forecastExhaustAt: string | null;
  nextRecoverAt: string | null; coverageHours: string | null;
  forecastStatus: "CURRENT" | "STALE" | "NOT_CALCULABLE" | "NOT_AVAILABLE";
  utilizationStatus: string;
  forecastConfidence: string | null; forecastNotCalculableReason: string | null;
  forecastDataAt: string | null; lastSettledRequestAt: string | null;
  continuousNoCallDays: number | null; idleStatus: "UNASSESSED";
  utilizationBasis: "API_MONTHLY_BUDGET" | "CODING_PLAN_SUBSCRIPTION_PERIOD" | null;
  notCalculableReason: string | null; dataAt: string | null;
  quotaWindows: Array<{
    type: "FIVE_HOUR" | "WEEKLY"; limitValue: string | null; usedValue: string | null;
    remainingValue: string | null; ratio: string | null; unit: "PERCENT" | "POINT" | null;
    resetAt: string | null; providerDataAt: string | null; collectedAt: string;
    syncStatus: "SUCCESS" | "STALE" | "FAILED" | "UNSUPPORTED"; syncErrorCode: string | null;
  }>;
}

export interface ResourceMonthlyBudgetVersion {
  id: string;
  resourceId: string;
  month: string;
  version: number;
  status: "ACTIVE" | "CLEARED";
  amount: string | null;
  currency: string | null;
  createdAt: string;
  createdBy: string;
}

export interface ResourceMonthlyBudgetHistory {
  resource: { id: string; name: string; mode: "API" | "CODING_PLAN" };
  month: string;
  current: ResourceMonthlyBudgetVersion | null;
  history: ResourceMonthlyBudgetVersion[];
}

export interface ProcurementReview {
  month: string;
  summary: {
    purchaseCashAmounts: Array<{ currency: string; amount: string }>;
    apiSpends: Array<{ currency: string; amount: string }>;
    packageCosts: Array<{ currency: string; amount: string }>;
    planUtilization: string | null;
  };
  resources: Array<ResourceUtilization & { reviewLabel: string; reviewReason: string }>;
  note: { text: string; version: number; updatedAt: string | null; updatedBy: string | null };
}

export interface DepartmentCostRow {
  departmentId: string | null; departmentName: string; attributionStatus: "ASSIGNED" | "UNASSIGNED";
  employeeDirect: CostTotals; project: CostTotals; totals: CostTotals;
  budget: null | { amount: string; currency: string; warningThreshold: string; version: number };
  budgetUsageRate: string | null; budgetStatus: "NOT_SET" | "NORMAL" | "WARNING" | "OVER_BUDGET";
  reasonCodes: string[];
}
export interface CostTotals { requestCount: number; realTokens: string; apiCost: string; packageCost: string | null; totalCost: string | null }
export interface DepartmentBill {
  month: string; timezone: string; status: "DRAFT" | "CLOSED"; version: number;
  rows: Array<{
    departmentId: string | null; departmentName: string; isUnassigned: boolean;
    employeeDirectCost: string | null; projectCost: string | null; apiCost: string | null;
    packageAllocatedCost: string | null; totalCost: string | null; inputTokens: string;
    outputTokens: string; actualTokens: string; requestCount: number;
    attributionSnapshotMissingCount: number;
    budget: null | { id: string; departmentId: string; departmentName: string; month: string; currency: string; amount: string; warningThreshold: string; version: number; updatedAt: string };
    budgetUsageRate: string | null; budgetStatus: "NOT_SET" | "NORMAL" | "WARNING" | "OVER_BUDGET";
    reasonCodes: string[];
  }>;
  totals: { inputTokens: string; outputTokens: string; actualTokens: string; apiCost: string | null; packageCost: string | null; totalCost: string | null; requestCount: number };
  conservation: { status: "BALANCED" | "UNKNOWN" | "MISMATCH"; tokenDifference: string; apiCostDifference: string | null; packageCostDifference: string | null; totalCostDifference: string | null };
  reasonCodes: string[]; generatedAt: string;
}
