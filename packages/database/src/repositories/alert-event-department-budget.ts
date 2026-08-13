import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { loadLiveDepartmentBill } from "./department-cost-read-model.js";

export interface DepartmentBudgetDerivedAlert {
  alertKey: string;
  domain: "USAGE_SPIKE";
  signal: "department_budget_warning";
  severity: "HIGH" | "MEDIUM";
  title: string;
  detail: string;
  resourceId: null;
  principalId: null;
  aiRequestId: null;
}

/** 部门预算只进入既有告警中心，同部门同月使用稳定 key 去重。 */
export async function deriveDepartmentBudgetAlerts(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<DepartmentBudgetDerivedAlert[]> {
  const context = await sql<{ month: string; has_budget: boolean }>`
    WITH enterprise_month AS (
      SELECT to_char(
               current_timestamp AT TIME ZONE coalesce(timezone, 'Asia/Shanghai'),
               'YYYY-MM'
             ) AS month
        FROM enterprise
       WHERE id = ${enterpriseId}::uuid
    )
    SELECT enterprise_month.month,
           EXISTS (
             SELECT 1
               FROM department_budget budget
              WHERE budget.enterprise_id = ${enterpriseId}::uuid
                AND budget.month = (enterprise_month.month || '-01')::date
           ) AS has_budget
      FROM enterprise_month
  `.execute(db);
  const current = context.rows[0];
  if (!current?.has_budget) return [];

  const bill = await loadLiveDepartmentBill(db, enterpriseId, current.month);
  return bill.rows.flatMap((row): DepartmentBudgetDerivedAlert[] => {
    if (!row.departmentId || !row.budget ||
      (row.budgetStatus !== "WARNING" && row.budgetStatus !== "OVER_BUDGET")) {
      return [];
    }
    const overBudget = row.budgetStatus === "OVER_BUDGET";
    return [{
      alertKey: `USAGE_SPIKE:department-budget:${current.month}:${row.departmentId}`,
      domain: "USAGE_SPIKE",
      signal: "department_budget_warning",
      severity: overBudget ? "HIGH" : "MEDIUM",
      title: `${overBudget ? "部门超预算" : "部门预算已预警"}：${row.departmentName}`,
      detail: `${current.month} 归集成本 ${row.totalCost ?? "未知"} ${row.budget.currency}，预算 ${row.budget.amount}，使用率 ${row.budgetUsageRate ?? "未知"}，警戒线 ${row.budget.warningThreshold}`,
      resourceId: null,
      principalId: null,
      aiRequestId: null,
    }];
  });
}
