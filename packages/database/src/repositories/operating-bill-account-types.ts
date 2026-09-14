export type OperatingBillUsageQuality =
  | "EXACT"
  | "ESTIMATED"
  | "ACCOUNT_AGGREGATED"
  | "MIXED"
  | "UNKNOWN";

export interface OperatingBillAccountTotals {
  inputTokens: string | null;
  outputTokens: string | null;
  cacheTokens: string | null;
  reasoningTokens: string | null;
  /** 总 Token = 输入 + 输出；缓存与推理 Token 是子集，不重复相加。 */
  totalTokens: string | null;
  allocatedQuota?: string | null;
  deductedQuota: string | null;
  apiCost: string | null;
  knownApiCost?: string | null;
  packageAllocatedCost: string | null;
  totalAllocatedCost: string | null;
  activeDays: number | null;
  requestCount: number;
  lastUsedAt: string | null;
  usageQuality: OperatingBillUsageQuality;
}

export interface OperatingBillAccountProviderRef {
  providerCode: string;
  providerName: string;
  totals?: OperatingBillAccountTotals;
}

export interface OperatingBillProjectDepartmentRef {
  departmentId: string;
  departmentName: string;
}

export interface OperatingBillProjectOwnerRef {
  personId: string | null;
  personName: string;
}

export interface OperatingBillAccountSubjectRow {
  subjectId: string | null;
  subjectName: string;
  isUnassigned: boolean;
  allocatedQuota?: string | null;
  /** 项目维度才有值；CLOSED 月份来自结账时冻结的账户事实。 */
  projectOwner: OperatingBillProjectOwnerRef | null;
  /** 请求发生时点的项目部门集合；不从当前负责人部门反推。 */
  projectDepartments: OperatingBillProjectDepartmentRef[];
  providers: OperatingBillAccountProviderRef[];
  totals: OperatingBillAccountTotals;
}

export interface OperatingBillAccountListView {
  month: string;
  status: "DRAFT" | "CLOSED";
  dimension: "EMPLOYEE" | "PROJECT";
  totals: OperatingBillAccountTotals;
  rows: OperatingBillAccountSubjectRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface OperatingBillModelRow {
  unifiedModelId: string | null;
  identityStatus: "RESOLVED" | "UNRESOLVED";
  currentAlias: string | null;
  historicalAliases: string[];
  totals: OperatingBillAccountTotals;
  usageShare: string | null;
}

export interface OperatingBillProviderModelsRow {
  providerCode: string;
  providerName: string;
  totals: OperatingBillAccountTotals;
  models: OperatingBillModelRow[];
}

export interface OperatingBillEmployeeDetailView {
  month: string;
  status: "DRAFT" | "CLOSED";
  employee: { principalId: string; principalName: string };
  totals: OperatingBillAccountTotals;
  providers: OperatingBillProviderModelsRow[];
  gaps: Array<{ code: "MODEL_ID_UNRESOLVED"; historicalAlias: string }>;
}

export interface OperatingBillRequestRow {
  requestId: string;
  modelAliasAtRequest: string;
  currentAlias: string | null;
  tokens: Pick<OperatingBillAccountTotals,
    "inputTokens" | "outputTokens" | "cacheTokens" | "reasoningTokens" | "totalTokens">;
  costs: Pick<OperatingBillAccountTotals,
    "deductedQuota" | "apiCost" | "packageAllocatedCost" | "totalAllocatedCost">;
  usageQuality: OperatingBillUsageQuality;
  status: string;
  usedAt: string;
}

export interface OperatingBillRequestListView {
  month: string;
  status: "DRAFT" | "CLOSED";
  employee: { principalId: string; principalName: string };
  model: { unifiedModelId: string; currentAlias: string | null };
  items: OperatingBillRequestRow[];
  total: number;
  limit: number;
  offset: number;
}
