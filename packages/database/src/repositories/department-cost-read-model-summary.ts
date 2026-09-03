import { Decimal } from "decimal.js";
import { departmentMoney as money } from "./department-cost-types.js";
import type {
  RawCostRow, RawEnterpriseSummary,
} from "./department-cost-read-model-query-types.js";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const ZERO = "0.00000000";

export function emptyRawCost(departmentId: string | null): RawCostRow {
  return {
    department_id: departmentId, employee_direct_cost: ZERO, project_cost: ZERO,
    api_cost: ZERO, package_allocated_cost: ZERO, input_tokens: "0", output_tokens: "0",
    request_count: "0", missing_snapshot_count: "0",
  };
}

export function summarizeEnterpriseCosts(rows: RawCostRow[]): RawEnterpriseSummary {
  if (rows.length === 0) {
    return { input_tokens: "0", output_tokens: "0", api_cost: ZERO, request_count: "0" };
  }
  const apiCosts = rows.map((row) => row.api_cost);
  return {
    input_tokens: rows.reduce((sum, row) => sum + BigInt(row.input_tokens), 0n).toString(),
    output_tokens: rows.reduce((sum, row) => sum + BigInt(row.output_tokens), 0n).toString(),
    api_cost: apiCosts.some((value) => value === null)
      ? null
      : money(apiCosts.reduce((sum, value) => new Money(sum).plus(value!), new Money(0))),
    request_count: rows.reduce((sum, row) => sum + BigInt(row.request_count), 0n).toString(),
  };
}
