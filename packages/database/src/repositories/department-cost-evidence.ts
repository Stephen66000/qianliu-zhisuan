import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { loadLiveDepartmentBill } from "./department-cost-read-model.js";
import { departmentMonthDate, type DepartmentBillView } from "./department-cost-types.js";

export interface FrozenDepartmentAttributionFact {
  aiRequestId: string;
  requestOccurredAt: string;
  snapshotId: string | null;
  snapshotVersion: number | null;
  sourcePrincipalId: string | null;
  employeePersonId: string | null;
  projectPrincipalId: string | null;
  organizationUnitId: string | null;
  costCategory: string | null;
  attributionSource: string | null;
  snapshotOrigin: string | null;
  reasonCode: string | null;
}

export interface FrozenDepartmentBudgetFact {
  id: string;
  organizationUnitId: string;
  month: string;
  currency: string;
  amount: string;
  warningThreshold: string;
  version: number;
  updatedAt: string;
}

export interface FrozenResourcePurchaseFact {
  id: string;
  providerResourceId: string;
  purchaseType: string;
  amount: string;
  currency: string;
  purchasedAt: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  source: string;
  evidenceRef: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DepartmentCloseEvidence {
  departmentBill: DepartmentBillView;
  departmentAttributionFacts: FrozenDepartmentAttributionFact[];
  departmentBudgetFacts: FrozenDepartmentBudgetFact[];
  resourcePurchaseFacts: FrozenResourcePurchaseFact[];
}

interface RawAttributionFact {
  ai_request_id: string;
  request_occurred_at: Date;
  snapshot_id: string | null;
  snapshot_version: number | null;
  source_principal_id: string | null;
  employee_person_id: string | null;
  project_principal_id: string | null;
  organization_unit_id: string | null;
  cost_category: string | null;
  attribution_source: string | null;
  snapshot_origin: string | null;
  reason_code: string | null;
}

interface RawBudgetFact {
  id: string;
  organization_unit_id: string;
  month: Date | string;
  currency: string;
  amount: string;
  warning_threshold: string;
  version: number;
  updated_at: Date;
}

interface RawPurchaseFact {
  id: string;
  provider_resource_id: string;
  purchase_type: string;
  amount: string;
  currency: string;
  purchased_at: Date;
  service_period_start: Date | string | null;
  service_period_end: Date | string | null;
  source: string;
  evidence_ref: string | null;
  created_by: string;
  created_at: Date;
}

interface FrozenDepartmentResult {
  status: "DRAFT" | "CLOSED";
  current_version: number;
  department_bill: DepartmentBillView | null;
}

/** 已结账月份 fail-closed：不能因为缺少新证据就悄悄回落到实时重算。 */
export async function loadDepartmentBill(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  financeEnabled = false,
): Promise<DepartmentBillView> {
  const result = await sql<FrozenDepartmentResult>`
    SELECT p.status, p.current_version,
           v.snapshot #> '{sourceFacts,departmentBill}' AS department_bill
      FROM operating_bill_period p
      LEFT JOIN operating_bill_version v
        ON v.enterprise_id = p.enterprise_id AND v.period_id = p.id
       AND v.version = p.current_version
     WHERE p.enterprise_id = ${enterpriseId}::uuid
       AND p.period_month = ${departmentMonthDate(month)}::date
  `.execute(db);
  const period = result.rows[0];
  if (period?.status === "CLOSED") {
    if (!period.department_bill) throw new DepartmentBillEvidenceUnavailableError();
    return period.department_bill;
  }
  return loadLiveDepartmentBill(db, enterpriseId, month, financeEnabled);
}

/** 在 closeMonth 的 RR 事务快照内一次性收集部门读模型及其可追溯事实。 */
export async function loadDepartmentCloseEvidence(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  financeEnabled = false,
): Promise<DepartmentCloseEvidence> {
  const departmentBill = await loadLiveDepartmentBill(db, enterpriseId, month, financeEnabled);
  const [attributionResult, budgetResult, purchaseResult] = await Promise.all([
    sql<RawAttributionFact>`
      WITH bounds AS (
        SELECT ${departmentMonthDate(month)}::timestamp
                 AT TIME ZONE coalesce(e.timezone, 'Asia/Shanghai') AS started_at,
               (${departmentMonthDate(month)}::date + interval '1 month')::timestamp
                 AT TIME ZONE coalesce(e.timezone, 'Asia/Shanghai') AS ended_at
          FROM enterprise e WHERE e.id = ${enterpriseId}::uuid
      ), month_requests AS (
        SELECT DISTINCT ll.ai_request_id
          FROM ledger_line ll CROSS JOIN bounds b
         WHERE ll.enterprise_id = ${enterpriseId}::uuid
           AND ll.created_at >= b.started_at AND ll.created_at < b.ended_at
      )
      SELECT mr.ai_request_id, ar.started_at AS request_occurred_at,
             a.id AS snapshot_id, a.version AS snapshot_version,
             a.source_principal_id, a.employee_person_id, a.project_principal_id,
             a.organization_unit_id, a.cost_category, a.attribution_source,
             a.snapshot_origin, a.reason_code
        FROM month_requests mr
        JOIN ai_request ar
          ON ar.id = mr.ai_request_id AND ar.enterprise_id = ${enterpriseId}::uuid
        LEFT JOIN LATERAL (
          SELECT s.* FROM request_attribution_snapshot s
           WHERE s.enterprise_id = ${enterpriseId}::uuid
             AND s.ai_request_id = mr.ai_request_id
           ORDER BY s.version DESC, s.created_at DESC, s.id DESC LIMIT 1
        ) a ON true
       ORDER BY mr.ai_request_id
    `.execute(db),
    sql<RawBudgetFact>`
      SELECT id, organization_unit_id, month, currency, amount::text,
             warning_threshold::text, version, updated_at
        FROM department_budget
       WHERE enterprise_id = ${enterpriseId}::uuid
         AND month = ${departmentMonthDate(month)}::date
       ORDER BY organization_unit_id, id
    `.execute(db),
    sql<RawPurchaseFact>`
      WITH bounds AS (
        SELECT ${departmentMonthDate(month)}::timestamp
                 AT TIME ZONE coalesce(e.timezone, 'Asia/Shanghai') AS started_at,
               (${departmentMonthDate(month)}::date + interval '1 month')::timestamp
                 AT TIME ZONE coalesce(e.timezone, 'Asia/Shanghai') AS ended_at
          FROM enterprise e WHERE e.id = ${enterpriseId}::uuid
      )
      SELECT p.id, p.provider_resource_id, p.purchase_type, p.amount::text, p.currency,
             p.purchased_at, p.service_period_start, p.service_period_end, p.source,
             p.evidence_ref, p.created_by, p.created_at
        FROM resource_purchase_record p CROSS JOIN bounds b
       WHERE p.enterprise_id = ${enterpriseId}::uuid
         AND p.purchased_at >= b.started_at AND p.purchased_at < b.ended_at
       ORDER BY p.purchased_at, p.id
    `.execute(db),
  ]);

  return {
    departmentBill,
    departmentAttributionFacts: attributionResult.rows.map((row) => ({
      aiRequestId: row.ai_request_id,
      requestOccurredAt: row.request_occurred_at.toISOString(),
      snapshotId: row.snapshot_id,
      snapshotVersion: row.snapshot_version,
      sourcePrincipalId: row.source_principal_id,
      employeePersonId: row.employee_person_id,
      projectPrincipalId: row.project_principal_id,
      organizationUnitId: row.organization_unit_id,
      costCategory: row.cost_category,
      attributionSource: row.attribution_source,
      snapshotOrigin: row.snapshot_origin,
      reasonCode: row.reason_code,
    })),
    departmentBudgetFacts: budgetResult.rows.map((row) => ({
      id: row.id,
      organizationUnitId: row.organization_unit_id,
      month: dateText(row.month),
      currency: row.currency,
      amount: row.amount,
      warningThreshold: row.warning_threshold,
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    })),
    resourcePurchaseFacts: purchaseResult.rows.map((row) => ({
      id: row.id,
      providerResourceId: row.provider_resource_id,
      purchaseType: row.purchase_type,
      amount: row.amount,
      currency: row.currency,
      purchasedAt: row.purchased_at.toISOString(),
      servicePeriodStart: nullableDateText(row.service_period_start),
      servicePeriodEnd: nullableDateText(row.service_period_end),
      source: row.source,
      evidenceRef: row.evidence_ref,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export function assertDepartmentCostConserved(view: DepartmentBillView): void {
  if (view.conservation.status === "MISMATCH") {
    throw new DepartmentCostNotConservedError(view.conservation);
  }
}

function nullableDateText(value: Date | string | null): string | null {
  return value === null ? null : dateText(value);
}

function dateText(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export class DepartmentBillEvidenceUnavailableError extends Error {
  constructor() {
    super("department_bill_evidence_unavailable");
  }
}

export class DepartmentCostNotConservedError extends Error {
  constructor(readonly conservation: DepartmentBillView["conservation"]) {
    super("department_cost_not_conserved");
  }
}
