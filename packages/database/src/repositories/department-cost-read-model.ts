import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { departmentMonthDate as monthDate } from "./department-cost-types.js";
import type { DepartmentBillView } from "./department-cost-types.js";
import { loadRawCosts } from "./department-cost-read-model-query.js";
import {
  addDepartmentMoney,
  buildDepartmentRows,
  conservationResult,
  type RawDepartment,
} from "./department-cost-read-model-rows.js";

interface RawPeriod { status: "DRAFT" | "CLOSED"; current_version: number }

export async function loadLiveDepartmentBill(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  financeEnabled = false,
): Promise<DepartmentBillView> {
  const [{ costs, packages, enterprise, timezone }, departmentsResult, periodResult] = await Promise.all([
    loadRawCosts(db, enterpriseId, month, financeEnabled),
    sql<RawDepartment>`
      SELECT ou.id, ou.name, ou.status, b.id AS budget_id, b.currency, b.amount::text,
             b.warning_threshold::text, b.version AS budget_version,
             b.updated_at AS budget_updated_at
        FROM organization_unit ou
        LEFT JOIN department_budget b
          ON b.enterprise_id = ou.enterprise_id AND b.organization_unit_id = ou.id
         AND b.month = ${monthDate(month)}::date
       WHERE ou.enterprise_id = ${enterpriseId}::uuid
       ORDER BY ou.name, ou.id
    `.execute(db),
    sql<RawPeriod>`
      SELECT status, current_version FROM operating_bill_period
       WHERE enterprise_id = ${enterpriseId}::uuid AND period_month = ${monthDate(month)}::date
    `.execute(db),
  ]);
  const { rows, reasonCodes } = buildDepartmentRows(
    costs, departmentsResult.rows, packages, month,
  );
  const conservation = conservationResult(rows, enterprise, packages);
  if (conservation.status === "MISMATCH") reasonCodes.add("DEPARTMENT_COST_NOT_CONSERVED");
  if (enterprise.api_cost === null) reasonCodes.add("API_COST_UNKNOWN");

  const totalCost = enterprise.api_cost === null || packages.package_cost === null
    ? null : addDepartmentMoney(enterprise.api_cost, packages.package_cost);
  const period = periodResult.rows[0];
  return {
    month, timezone, status: period?.status ?? "DRAFT", version: period?.current_version ?? 0,
    rows,
    totals: {
      inputTokens: enterprise.input_tokens, outputTokens: enterprise.output_tokens,
      actualTokens: (BigInt(enterprise.input_tokens) + BigInt(enterprise.output_tokens)).toString(),
      apiCost: enterprise.api_cost, packageCost: packages.package_cost, totalCost,
      requestCount: Number(enterprise.request_count),
    },
    conservation,
    reasonCodes: [...reasonCodes].sort(), generatedAt: new Date().toISOString(),
  };
}
