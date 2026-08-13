import { Decimal } from "decimal.js";

export type DepartmentBudgetStatus = "NOT_SET" | "NORMAL" | "WARNING" | "OVER_BUDGET";

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
  budgetStatus: DepartmentBudgetStatus;
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

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export function departmentMoney(value: Decimal.Value): string {
  return new Money(value).toDecimalPlaces(8).toFixed(8);
}

export function departmentBudgetState(
  cost: string | null,
  amount: string | null,
  threshold: string | null,
): { rate: string | null; status: DepartmentBudgetStatus } {
  if (cost === null || amount === null || threshold === null || new Money(amount).lte(0)) {
    return { rate: null, status: "NOT_SET" };
  }
  const rate = new Money(cost).div(amount);
  return {
    rate: rate.toDecimalPlaces(8).toFixed(8),
    status: rate.gte(1) ? "OVER_BUDGET" : rate.gte(threshold) ? "WARNING" : "NORMAL",
  };
}

export function departmentMonthDate(month: string): string {
  return `${month}-01`;
}
