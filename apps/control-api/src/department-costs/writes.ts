import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import {
  acquireOperatingBillMonthWriteBarrier,
  type Database,
} from "@qianliu/database";
import { money, monthDate } from "./contracts.js";
import type { DepartmentBudgetView, PurchaseView } from "./types.js";

interface BudgetRow {
  id: string;
  department_id: string;
  department_name: string;
  month: Date | string;
  currency: string;
  amount: string;
  warning_threshold: string;
  version: number;
  updated_at: Date;
}

interface PurchaseRow {
  id: string;
  provider_resource_id: string;
  purchase_type: "API_RECHARGE" | "PACKAGE_PURCHASE";
  description: string | null;
  amount: string;
  currency: string;
  purchased_at: Date;
  service_period_start: string | null;
  service_period_end: string | null;
  source: "ADMIN" | "IMPORT" | "PROVIDER_SYNC";
  evidence_ref: string | null;
  created_by_name: string;
  created_at: Date;
}

interface Receipt { request_hash: string; response_snapshot: unknown }

export type SaveBudgetOutcome =
  | { kind: "ok"; budget: DepartmentBudgetView; replayed: boolean }
  | { kind: "not_found" | "closed" | "version_conflict" | "idempotency_conflict" };

export type CreatePurchaseOutcome =
  | { kind: "ok"; purchase: PurchaseView; replayed: boolean }
  | { kind: "not_found" | "closed" | "mode_mismatch" | "idempotency_conflict" };

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function budgetView(row: BudgetRow, month: string): DepartmentBudgetView {
  return {
    id: row.id, departmentId: row.department_id, departmentName: row.department_name,
    month, currency: row.currency, amount: money(row.amount),
    warningThreshold: row.warning_threshold, version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

function purchaseView(row: PurchaseRow): PurchaseView {
  return {
    id: row.id, providerResourceId: row.provider_resource_id,
    purchaseType: row.purchase_type, description: row.description,
    amount: money(row.amount), currency: row.currency,
    purchasedAt: row.purchased_at.toISOString(),
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    source: row.source, evidenceRef: row.evidence_ref,
    createdBy: row.created_by_name, createdAt: row.created_at.toISOString(),
  };
}

export async function readDepartmentBudget(
  db: Kysely<Database>,
  enterpriseId: string,
  departmentId: string,
  month: string,
): Promise<{ departmentId: string; departmentName: string; budget: DepartmentBudgetView | null } | null> {
  const result = await sql<BudgetRow & { budget_id: string | null }>`
    SELECT ou.id AS department_id, ou.name AS department_name,
           b.id AS budget_id, b.id, b.month, b.currency, b.amount::text,
           b.warning_threshold::text, b.version, b.updated_at
      FROM organization_unit ou
      LEFT JOIN department_budget b
        ON b.enterprise_id = ou.enterprise_id AND b.organization_unit_id = ou.id
       AND b.month = ${monthDate(month)}::date
     WHERE ou.enterprise_id = ${enterpriseId}::uuid AND ou.id = ${departmentId}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (!row) return null;
  return {
    departmentId: row.department_id, departmentName: row.department_name,
    budget: row.budget_id ? budgetView({ ...row, id: row.budget_id }, month) : null,
  };
}

export async function saveDepartmentBudget(
  db: Kysely<Database>,
  input: {
    enterpriseId: string;
    adminId: string;
    departmentId: string;
    month: string;
    amount: string;
    currency: string;
    warningThreshold: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<SaveBudgetOutcome> {
  const requestHash = sha256({
    departmentId: input.departmentId, month: input.month, amount: money(input.amount),
    currency: input.currency, warningThreshold: input.warningThreshold,
    expectedVersion: input.expectedVersion,
  });
  return db.transaction().execute(async (trx) => {
    const departmentResult = await sql<{ id: string; name: string }>`
      SELECT id, name FROM organization_unit
       WHERE enterprise_id = ${input.enterpriseId}::uuid AND id = ${input.departmentId}::uuid
       FOR KEY SHARE
    `.execute(trx);
    const department = departmentResult.rows[0];
    if (!department) return { kind: "not_found" as const };
    await acquireOperatingBillMonthWriteBarrier(trx, input.enterpriseId, input.month);
    await sql`SELECT pg_advisory_xact_lock(hashtext(
      ${`${input.enterpriseId}:budget:${input.departmentId}:${input.month}`}
    ))`.execute(trx);
    const receiptResult = await sql<Receipt>`
      SELECT request_hash, response_snapshot FROM department_budget_idempotency
       WHERE enterprise_id = ${input.enterpriseId}::uuid
         AND organization_unit_id = ${input.departmentId}::uuid
         AND month = ${monthDate(input.month)}::date
         AND idempotency_key = ${input.idempotencyKey}
    `.execute(trx);
    const receipt = receiptResult.rows[0];
    if (receipt) {
      return receipt.request_hash === requestHash
        ? { kind: "ok" as const, budget: receipt.response_snapshot as DepartmentBudgetView, replayed: true }
        : { kind: "idempotency_conflict" as const };
    }
    const periodResult = await sql<{ status: string }>`
      SELECT status FROM operating_bill_period
       WHERE enterprise_id = ${input.enterpriseId}::uuid
         AND period_month = ${monthDate(input.month)}::date
      FOR UPDATE
    `.execute(trx);
    if (periodResult.rows[0]?.status === "CLOSED") return { kind: "closed" as const };
    const currentResult = await sql<{ id: string; version: number }>`
      SELECT id, version FROM department_budget
       WHERE enterprise_id = ${input.enterpriseId}::uuid
         AND organization_unit_id = ${input.departmentId}::uuid
         AND month = ${monthDate(input.month)}::date
       FOR UPDATE
    `.execute(trx);
    const current = currentResult.rows[0];
    if ((current?.version ?? 0) !== input.expectedVersion) {
      return { kind: "version_conflict" as const };
    }
    const saved = current
      ? await sql<BudgetRow>`
          UPDATE department_budget
             SET amount = ${input.amount}::numeric(24,8), currency = ${input.currency},
                 warning_threshold = ${input.warningThreshold}::numeric(9,8),
                 version = version + 1, updated_by = ${input.adminId}::uuid, updated_at = now()
           WHERE id = ${current.id}::uuid
           RETURNING id, organization_unit_id AS department_id,
             ${department.name}::text AS department_name, month, currency, amount::text,
             warning_threshold::text, version, updated_at
        `.execute(trx)
      : await sql<BudgetRow>`
          INSERT INTO department_budget
            (enterprise_id, organization_unit_id, month, currency, amount,
             warning_threshold, updated_by)
          VALUES (${input.enterpriseId}::uuid, ${input.departmentId}::uuid,
                  ${monthDate(input.month)}::date, ${input.currency},
                  ${input.amount}::numeric(24,8), ${input.warningThreshold}::numeric(9,8),
                  ${input.adminId}::uuid)
          RETURNING id, organization_unit_id AS department_id,
            ${department.name}::text AS department_name, month, currency, amount::text,
            warning_threshold::text, version, updated_at
        `.execute(trx);
    const row = saved.rows[0]!;
    const budget = budgetView(row, input.month);
    await sql`
      INSERT INTO operation_log
        (enterprise_id, admin_user_id, action, target_type, target_id,
         change_summary, result, actor_source)
      VALUES (${input.enterpriseId}::uuid, ${input.adminId}::uuid,
              'department_budget.upsert', 'department_budget', ${row.id}::uuid,
              ${JSON.stringify({
                department_id: input.departmentId, month: input.month,
                amount: budget.amount, currency: budget.currency,
                warning_threshold: budget.warningThreshold, version: budget.version,
              })}::jsonb, 'SUCCESS', 'ADMIN')
    `.execute(trx);
    await sql`
      INSERT INTO department_budget_idempotency
        (enterprise_id, organization_unit_id, month, idempotency_key,
         request_hash, response_snapshot)
      VALUES (${input.enterpriseId}::uuid, ${input.departmentId}::uuid,
              ${monthDate(input.month)}::date, ${input.idempotencyKey}, ${requestHash},
              ${JSON.stringify(budget)}::jsonb)
    `.execute(trx);
    if (periodResult.rows[0]) {
      await sql`
        UPDATE operating_bill_period SET updated_at = now()
         WHERE enterprise_id = ${input.enterpriseId}::uuid
           AND period_month = ${monthDate(input.month)}::date
      `.execute(trx);
    }
    return { kind: "ok" as const, budget, replayed: false };
  });
}

export async function createResourcePurchase(
  db: Kysely<Database>,
  input: {
    enterpriseId: string;
    adminId: string;
    resourceId: string;
    purchaseType: "API_RECHARGE" | "PACKAGE_PURCHASE";
    description: string | null;
    amount: string;
    currency: string;
    purchasedAt: string;
    servicePeriodStart: string | null;
    servicePeriodEnd: string | null;
    evidenceRef: string | null;
    idempotencyKey: string;
  },
): Promise<CreatePurchaseOutcome> {
  const requestHash = sha256({
    resourceId: input.resourceId, purchaseType: input.purchaseType,
    description: input.description, amount: money(input.amount), currency: input.currency,
    purchasedAt: input.purchasedAt, servicePeriodStart: input.servicePeriodStart,
    servicePeriodEnd: input.servicePeriodEnd, evidenceRef: input.evidenceRef,
  });
  return db.transaction().execute(async (trx) => {
    const resourceResult = await sql<{ id: string; mode: "API" | "CODING_PLAN" }>`
      SELECT id, mode FROM provider_resource
       WHERE enterprise_id = ${input.enterpriseId}::uuid AND id = ${input.resourceId}::uuid
         AND status <> 'DELETED' FOR KEY SHARE
    `.execute(trx);
    const resource = resourceResult.rows[0];
    if (!resource) return { kind: "not_found" as const };
    await sql`SELECT pg_advisory_xact_lock(hashtext(
      ${`${input.enterpriseId}:purchase:${input.resourceId}:${input.idempotencyKey}`}
    ))`.execute(trx);
    const receiptResult = await sql<Receipt>`
      SELECT request_hash, response_snapshot FROM resource_purchase_idempotency
       WHERE enterprise_id = ${input.enterpriseId}::uuid
         AND provider_resource_id = ${input.resourceId}::uuid
         AND idempotency_key = ${input.idempotencyKey}
    `.execute(trx);
    const receipt = receiptResult.rows[0];
    if (receipt) {
      return receipt.request_hash === requestHash
        ? { kind: "ok" as const, purchase: receipt.response_snapshot as PurchaseView, replayed: true }
        : { kind: "idempotency_conflict" as const };
    }
    if ((resource.mode === "API") !== (input.purchaseType === "API_RECHARGE")) {
      return { kind: "mode_mismatch" as const };
    }
    const purchaseMonthResult = await sql<{ month: string }>`
      SELECT to_char(
        ${input.purchasedAt}::timestamptz AT TIME ZONE coalesce(timezone, 'Asia/Shanghai'),
        'YYYY-MM'
      ) AS month
        FROM enterprise WHERE id = ${input.enterpriseId}::uuid
    `.execute(trx);
    const purchaseMonth = purchaseMonthResult.rows[0]?.month;
    if (!purchaseMonth) return { kind: "not_found" as const };
    await acquireOperatingBillMonthWriteBarrier(trx, input.enterpriseId, purchaseMonth);
    const periodResult = await sql<{ status: string }>`
      SELECT status FROM operating_bill_period
       WHERE enterprise_id = ${input.enterpriseId}::uuid
         AND period_month = ${monthDate(purchaseMonth)}::date
       FOR UPDATE
    `.execute(trx);
    if (periodResult.rows[0]?.status === "CLOSED") return { kind: "closed" as const };
    const saved = await sql<PurchaseRow>`
      INSERT INTO resource_purchase_record
        (enterprise_id, provider_resource_id, purchase_type, description, amount,
         currency, purchased_at, service_period_start, service_period_end,
         source, evidence_ref, created_by)
      VALUES (${input.enterpriseId}::uuid, ${input.resourceId}::uuid, ${input.purchaseType},
              ${input.description}, ${input.amount}::numeric(24,8), ${input.currency},
              ${input.purchasedAt}::timestamptz, ${input.servicePeriodStart}::date,
              ${input.servicePeriodEnd}::date, 'ADMIN', ${input.evidenceRef}, ${input.adminId}::uuid)
      RETURNING id, provider_resource_id, purchase_type, description, amount::text,
        currency, purchased_at, service_period_start::text, service_period_end::text,
        source, evidence_ref, (SELECT display_name FROM admin_user WHERE id = ${input.adminId}::uuid)
          AS created_by_name, created_at
    `.execute(trx);
    const row = saved.rows[0]!;
    const purchase = purchaseView(row);
    await sql`
      INSERT INTO operation_log
        (enterprise_id, admin_user_id, action, target_type, target_id,
         change_summary, result, actor_source)
      VALUES (${input.enterpriseId}::uuid, ${input.adminId}::uuid,
              'resource_purchase.create', 'resource_purchase_record', ${row.id}::uuid,
              ${JSON.stringify({
                provider_resource_id: input.resourceId, purchase_type: input.purchaseType,
                amount: purchase.amount, currency: purchase.currency,
                purchased_at: purchase.purchasedAt,
              })}::jsonb, 'SUCCESS', 'ADMIN')
    `.execute(trx);
    await sql`
      INSERT INTO resource_purchase_idempotency
        (enterprise_id, provider_resource_id, idempotency_key, request_hash, response_snapshot)
      VALUES (${input.enterpriseId}::uuid, ${input.resourceId}::uuid,
              ${input.idempotencyKey}, ${requestHash}, ${JSON.stringify(purchase)}::jsonb)
    `.execute(trx);
    if (periodResult.rows[0]) {
      await sql`
        UPDATE operating_bill_period SET updated_at = now()
         WHERE enterprise_id = ${input.enterpriseId}::uuid
           AND period_month = ${monthDate(purchaseMonth)}::date
      `.execute(trx);
    }
    return { kind: "ok" as const, purchase, replayed: false };
  });
}

export async function listResourcePurchases(
  db: Kysely<Database>,
  input: { enterpriseId: string; resourceId: string; month?: string; limit: number; offset: number },
): Promise<{ items: PurchaseView[]; total: number; cashTotals: Array<{ currency: string; amount: string }> } | null> {
  const resourceResult = await sql<{ id: string }>`
    SELECT id FROM provider_resource
     WHERE enterprise_id = ${input.enterpriseId}::uuid AND id = ${input.resourceId}::uuid
       AND status <> 'DELETED'
  `.execute(db);
  if (!resourceResult.rows[0]) return null;
  const monthFilter = input.month
    ? sql`AND r.purchased_at >= ${monthDate(input.month)}::timestamp AT TIME ZONE coalesce(
            (SELECT timezone FROM enterprise WHERE id = ${input.enterpriseId}::uuid),
            'Asia/Shanghai'
          )
          AND r.purchased_at < (${monthDate(input.month)}::date + interval '1 month')::timestamp
            AT TIME ZONE coalesce(
              (SELECT timezone FROM enterprise WHERE id = ${input.enterpriseId}::uuid),
              'Asia/Shanghai'
            )`
    : sql``;
  const [itemsResult, totalsResult] = await Promise.all([
    sql<PurchaseRow & { total_count: string }>`
      SELECT r.id, r.provider_resource_id, r.purchase_type, r.description, r.amount::text,
             r.currency, r.purchased_at, r.service_period_start::text,
             r.service_period_end::text, r.source, r.evidence_ref,
             a.display_name AS created_by_name, r.created_at,
             count(*) OVER ()::text AS total_count
        FROM resource_purchase_record r
        JOIN admin_user a ON a.id = r.created_by AND a.enterprise_id = r.enterprise_id
       WHERE r.enterprise_id = ${input.enterpriseId}::uuid
         AND r.provider_resource_id = ${input.resourceId}::uuid ${monthFilter}
       ORDER BY r.purchased_at DESC, r.id DESC
       LIMIT ${input.limit} OFFSET ${input.offset}
    `.execute(db),
    sql<{ currency: string; amount: string }>`
      SELECT r.currency, sum(r.amount)::numeric(24,8)::text AS amount
        FROM resource_purchase_record r
       WHERE r.enterprise_id = ${input.enterpriseId}::uuid
         AND r.provider_resource_id = ${input.resourceId}::uuid ${monthFilter}
       GROUP BY r.currency ORDER BY r.currency
    `.execute(db),
  ]);
  return {
    items: itemsResult.rows.map(purchaseView),
    total: Number(itemsResult.rows[0]?.total_count ?? 0),
    cashTotals: totalsResult.rows.map((row) => ({ currency: row.currency, amount: money(row.amount) })),
  };
}
