export type BudgetStatus = "NOT_SET" | "NORMAL" | "WARNING" | "OVER_BUDGET";

export interface DepartmentBudgetView {
  id: string;
  departmentId: string;
  departmentName: string;
  month: string;
  currency: string;
  amount: string;
  warningThreshold: string;
  version: number;
  updatedAt: string;
}

export interface DepartmentCostRow {
  departmentId: string | null;
  departmentName: string;
  isUnassigned: boolean;
  employeeDirectCost: string | null;
  projectCost: string | null;
  apiCost: string | null;
  packageAllocatedCost: string | null;
  totalCost: string | null;
  inputTokens: string;
  outputTokens: string;
  actualTokens: string;
  requestCount: number;
  attributionSnapshotMissingCount: number;
  budget: DepartmentBudgetView | null;
  budgetUsageRate: string | null;
  budgetStatus: BudgetStatus;
  reasonCodes: string[];
}

export interface DepartmentBillView {
  month: string;
  timezone: string;
  status: "DRAFT" | "CLOSED";
  version: number;
  rows: DepartmentCostRow[];
  totals: {
    inputTokens: string;
    outputTokens: string;
    actualTokens: string;
    apiCost: string | null;
    packageCost: string | null;
    totalCost: string | null;
    requestCount: number;
  };
  conservation: {
    status: "BALANCED" | "UNKNOWN" | "MISMATCH";
    tokenDifference: string;
    apiCostDifference: string | null;
    packageCostDifference: string | null;
    totalCostDifference: string | null;
  };
  reasonCodes: string[];
  generatedAt: string;
}

export interface PurchaseView {
  id: string;
  providerResourceId: string;
  purchaseType: "API_RECHARGE" | "PACKAGE_PURCHASE";
  description: string | null;
  amount: string;
  currency: string;
  purchasedAt: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  source: "ADMIN" | "IMPORT" | "PROVIDER_SYNC";
  evidenceRef: string | null;
  createdBy: string;
  createdAt: string;
}
