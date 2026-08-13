import { Decimal } from "decimal.js";
import {
  departmentBudgetState as budgetState,
  departmentMoney as money,
} from "./department-cost-types.js";
import type {
  DepartmentBillView,
  DepartmentBudgetView,
  DepartmentCostRow,
} from "./department-cost-types.js";
import type {
  RawCostRow,
  RawEnterpriseSummary,
  RawPackageSummary,
} from "./department-cost-read-model-query.js";

export interface RawDepartment {
  id: string;
  name: string;
  status: string;
  budget_id: string | null;
  currency: string | null;
  amount: string | null;
  warning_threshold: string | null;
  budget_version: number | null;
  budget_updated_at: Date | null;
}

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const ZERO = "0.00000000";
const UNASSIGNED = "__unassigned__";

export function addDepartmentMoney(left: string, right: string): string {
  return money(new Money(left).plus(right));
}

function difference(left: string, right: string): string {
  return money(new Money(left).minus(right));
}

function budgetView(row: RawDepartment, month: string): DepartmentBudgetView | null {
  if (!row.budget_id || row.currency === null || row.amount === null
    || row.warning_threshold === null || row.budget_version === null || !row.budget_updated_at) return null;
  return {
    id: row.budget_id, departmentId: row.id, departmentName: row.name, month,
    currency: row.currency, amount: money(row.amount), warningThreshold: row.warning_threshold,
    version: row.budget_version, updatedAt: row.budget_updated_at.toISOString(),
  };
}

function emptyCost(departmentId: string | null): RawCostRow {
  return {
    department_id: departmentId, employee_direct_cost: ZERO, project_cost: ZERO,
    api_cost: ZERO, package_allocated_cost: ZERO, input_tokens: "0", output_tokens: "0",
    request_count: "0", missing_snapshot_count: "0",
  };
}

function totalLineCost(cost: RawCostRow): string | null {
  return cost.api_cost === null || cost.package_allocated_cost === null
    ? null : addDepartmentMoney(cost.api_cost, cost.package_allocated_cost);
}

function applyUnallocatedPackage(
  unassigned: RawCostRow,
  packages: RawPackageSummary,
  reasons: Set<string>,
): void {
  if (Number(packages.unknown_resource_count) > 0) {
    unassigned.package_allocated_cost = null;
    reasons.add("PACKAGE_COST_UNKNOWN");
  } else if (new Money(packages.unallocated_package_cost ?? 0).gt(0)) {
    unassigned.package_allocated_cost = addDepartmentMoney(
      unassigned.package_allocated_cost ?? ZERO,
      packages.unallocated_package_cost ?? ZERO,
    );
    reasons.add("UNALLOCATED_PACKAGE_COST");
  }
}

function assignedRow(
  departmentId: string,
  meta: RawDepartment | undefined,
  cost: RawCostRow,
  month: string,
): DepartmentCostRow {
  const budget = meta ? budgetView(meta, month) : null;
  const totalCost = totalLineCost(cost);
  const state = budgetState(totalCost, budget?.amount ?? null, budget?.warningThreshold ?? null);
  const reasonCodes = [
    ...(cost.api_cost === null ? ["API_COST_UNKNOWN"] : []),
    ...(cost.package_allocated_cost === null ? ["PACKAGE_COST_UNKNOWN"] : []),
  ];
  return {
    departmentId, departmentName: meta?.name ?? "历史部门", isUnassigned: false,
    employeeDirectCost: cost.employee_direct_cost, projectCost: cost.project_cost,
    apiCost: cost.api_cost, packageAllocatedCost: cost.package_allocated_cost, totalCost,
    inputTokens: cost.input_tokens, outputTokens: cost.output_tokens,
    actualTokens: (BigInt(cost.input_tokens) + BigInt(cost.output_tokens)).toString(),
    requestCount: Number(cost.request_count),
    attributionSnapshotMissingCount: Number(cost.missing_snapshot_count),
    budget, budgetUsageRate: state.rate, budgetStatus: state.status, reasonCodes,
  };
}

export function buildDepartmentRows(
  costs: RawCostRow[],
  departments: RawDepartment[],
  packages: RawPackageSummary,
  month: string,
): { rows: DepartmentCostRow[]; reasonCodes: Set<string> } {
  const costByDepartment = new Map(costs.map((row) => [row.department_id ?? UNASSIGNED, row]));
  const unassigned = costByDepartment.get(UNASSIGNED) ?? emptyCost(null);
  const reasonCodes = new Set<string>();
  applyUnallocatedPackage(unassigned, packages, reasonCodes);
  if (Number(unassigned.missing_snapshot_count) > 0) reasonCodes.add("ATTRIBUTION_SNAPSHOT_MISSING");
  if (Number(unassigned.request_count) > 0) reasonCodes.add("DEPARTMENT_UNASSIGNED");
  if (unassigned.api_cost === null) reasonCodes.add("API_COST_UNKNOWN");
  costByDepartment.set(UNASSIGNED, unassigned);
  const metadata = new Map(departments.map((row) => [row.id, row]));
  const departmentIds = new Set([
    ...departments.filter((row) => row.status === "ACTIVE" || row.budget_id).map((row) => row.id),
    ...costs.flatMap((row) => row.department_id ? [row.department_id] : []),
  ]);
  const rows = [...departmentIds].map((departmentId) => assignedRow(
    departmentId, metadata.get(departmentId),
    costByDepartment.get(departmentId) ?? emptyCost(departmentId), month,
  ));
  rows.push({
    departmentId: null, departmentName: "待归属", isUnassigned: true,
    employeeDirectCost: unassigned.employee_direct_cost, projectCost: unassigned.project_cost,
    apiCost: unassigned.api_cost, packageAllocatedCost: unassigned.package_allocated_cost,
    totalCost: totalLineCost(unassigned), inputTokens: unassigned.input_tokens,
    outputTokens: unassigned.output_tokens,
    actualTokens: (BigInt(unassigned.input_tokens) + BigInt(unassigned.output_tokens)).toString(),
    requestCount: Number(unassigned.request_count),
    attributionSnapshotMissingCount: Number(unassigned.missing_snapshot_count),
    budget: null, budgetUsageRate: null, budgetStatus: "NOT_SET",
    reasonCodes: [...reasonCodes],
  });
  rows.sort((left, right) => Number(left.isUnassigned) - Number(right.isUnassigned)
    || left.departmentName.localeCompare(right.departmentName, "zh-CN"));
  return { rows, reasonCodes };
}

function sumKnownRowCost(
  rows: DepartmentCostRow[],
  select: (row: DepartmentCostRow) => string | null,
): string | null {
  const values = rows.map(select);
  const known = values.filter((value): value is string => value !== null);
  if (known.length !== values.length) return null;
  return known.reduce((sum, value) => addDepartmentMoney(sum, value), ZERO);
}

export function conservationResult(
  rows: DepartmentCostRow[],
  enterprise: RawEnterpriseSummary,
  packages: RawPackageSummary,
): DepartmentBillView["conservation"] {
  const rowInput = rows.reduce((sum, row) => sum + BigInt(row.inputTokens), 0n);
  const rowOutput = rows.reduce((sum, row) => sum + BigInt(row.outputTokens), 0n);
  const rowApi = sumKnownRowCost(rows, (row) => row.apiCost);
  const rowPackage = sumKnownRowCost(rows, (row) => row.packageAllocatedCost);
  const tokenDifference = (
    BigInt(enterprise.input_tokens) + BigInt(enterprise.output_tokens) - rowInput - rowOutput
  ).toString();
  const apiDifference = enterprise.api_cost === null || rowApi === null
    ? null : difference(enterprise.api_cost, rowApi);
  const packageDifference = packages.package_cost === null || rowPackage === null
    ? null : difference(packages.package_cost, rowPackage);
  const totalDifference = apiDifference === null || packageDifference === null
    ? null : addDepartmentMoney(apiDifference, packageDifference);
  const mismatch = tokenDifference !== "0"
    || (apiDifference !== null && !new Money(apiDifference).eq(0))
    || (packageDifference !== null && !new Money(packageDifference).eq(0));
  const unknown = enterprise.api_cost === null || packages.package_cost === null
    || rowApi === null || rowPackage === null;
  return {
    status: mismatch ? "MISMATCH" : unknown ? "UNKNOWN" : "BALANCED",
    tokenDifference, apiCostDifference: apiDifference,
    packageCostDifference: packageDifference, totalCostDifference: totalDifference,
  };
}
