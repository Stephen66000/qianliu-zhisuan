import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { PrincipalAccountingError } from "./principal-accounting.js";
import {
  guardOperatingBillLedgerWrite,
  OperatingBillClosedError,
} from "./operating-bill-write-barrier.js";
import { markUsageAggregateDirtyForRequests } from "./usage-aggregate-repository.js";

export interface AttributionBackfillInput {
  enterpriseId: string;
  principalId: string;
  departmentId: string;
  from: Date;
  until: Date;
}
interface MissingAttribution {
  request_id: string;
  occurred_at: Date;
  snapshot_id: string | null;
  version: number | null;
  employee_person_id: string | null;
  project_principal_id: string | null;
}

async function inspect(db: Kysely<Database>, input: AttributionBackfillInput) {
  const { enterpriseId, principalId, departmentId, from, until } = input;
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(until.getTime()) ||
    until <= from ||
    until.getTime() - from.getTime() > 31 * 86400000
  )
    throw new PrincipalAccountingError(
      "INVALID",
      "请选择不超过31天的有效时间段",
    );
  const principal = await db
    .selectFrom("principal")
    .select(["id", "name", "type", "person_id"])
    .where("enterprise_id", "=", enterpriseId)
    .where("id", "=", principalId)
    .executeTakeFirst();
  if (!principal) throw new PrincipalAccountingError("NOT_FOUND", "主体不存在");
  const department = await db
    .selectFrom("organization_unit")
    .select(["id", "name"])
    .where("enterprise_id", "=", enterpriseId)
    .where("id", "=", departmentId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  if (!department)
    throw new PrincipalAccountingError("INVALID", "请选择本企业有效部门");
  const result =
    await sql<MissingAttribution>`SELECT request.id AS request_id,request.started_at AS occurred_at,
      prior.id AS snapshot_id,prior.version,prior.employee_person_id,prior.project_principal_id
    FROM ai_request request LEFT JOIN LATERAL (
      SELECT * FROM request_attribution_snapshot WHERE enterprise_id=${enterpriseId}::uuid AND ai_request_id=request.id
      ORDER BY version DESC LIMIT 1
    ) prior ON true
    WHERE request.enterprise_id=${enterpriseId}::uuid AND request.principal_id=${principalId}::uuid
      AND request.started_at>=${from} AND request.started_at<${until} AND request.started_at<=clock_timestamp()
      AND request.status<>'IN_PROGRESS' AND prior.organization_unit_id IS NULL
      AND EXISTS(SELECT 1 FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid AND ai_request_id=request.id)
    ORDER BY request.id LIMIT 10001`.execute(db);
  if (result.rows.length > 10000)
    throw new PrincipalAccountingError(
      "INVALID",
      "待补齐请求超过10000条，请缩小时间段",
    );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        enterpriseId,
        principalId,
        departmentId,
        from,
        until,
        rows: result.rows,
      }),
    )
    .digest("hex");
  return { principal, department, rows: result.rows, fingerprint };
}

export async function previewPrincipalAttributionBackfill(
  db: Kysely<Database>,
  input: AttributionBackfillInput,
) {
  const result = await inspect(db, input);
  return {
    principalName: result.principal.name,
    departmentName: result.department.name,
    requestCount: result.rows.length,
    fingerprint: result.fingerprint,
  };
}

export async function confirmPrincipalAttributionBackfill(
  db: Kysely<Database>,
  input: AttributionBackfillInput & {
    adminId: string;
    reason: string;
    fingerprint: string;
  },
) {
  if (!input.reason.trim() || input.reason.length > 500)
    throw new PrincipalAccountingError(
      "INVALID",
      "请填写不超过500字的确认依据",
    );
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`attribution-backfill:${input.enterpriseId}:${input.principalId}`},0))`.execute(
      trx,
    );
    const result = await inspect(trx, input);
    if (result.fingerprint !== input.fingerprint)
      throw new PrincipalAccountingError(
        "CONFLICT",
        "待补齐记录已变化，请重新预览",
      );
    const ids = result.rows.map((row) => row.request_id);
    if (!ids.length) return { confirmedCount: 0 };
    // Lock every affected billing month, including requests settled across a month boundary.
    const months = await sql<{
      month: string;
    }>`SELECT DISTINCT to_char(stamp AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month
      FROM ledger_line line CROSS JOIN LATERAL (VALUES(line.created_at),(line.settled_at)) times(stamp)
      WHERE line.enterprise_id=${input.enterpriseId}::uuid AND line.ai_request_id=ANY(${ids}::uuid[]) AND stamp IS NOT NULL ORDER BY month`.execute(
      trx,
    );
    for (const { month } of months.rows) {
      try {
        await guardOperatingBillLedgerWrite(
          trx,
          input.enterpriseId,
          new Date(`${month}-01T00:00:00+08:00`),
        );
      } catch (error) {
        if (error instanceof OperatingBillClosedError)
          throw new PrincipalAccountingError(
            "CONFLICT",
            `${month}已结账，不能补写历史归属`,
          );
        throw error;
      }
    }
    // Existing snapshots remain immutable. Latest-version readers consume this confirmed correction.
    const rows = result.rows.map((row) => ({
      ...row,
      employee_person_id:
        row.employee_person_id ??
        (result.principal.type === "EMPLOYEE"
          ? result.principal.person_id
          : null),
      project_principal_id:
        row.project_principal_id ??
        (result.principal.type === "PROJECT" ? input.principalId : null),
    }));
    await sql`INSERT INTO request_attribution_snapshot(enterprise_id,ai_request_id,source_principal_id,employee_person_id,
      project_principal_id,organization_unit_id,cost_category,attribution_source,request_occurred_at,version,supersedes_id,snapshot_origin,reason_code,created_by)
      SELECT ${input.enterpriseId}::uuid,row.request_id,${input.principalId}::uuid,row.employee_person_id,row.project_principal_id,${input.departmentId}::uuid,
        CASE WHEN row.project_principal_id IS NOT NULL THEN 'PROJECT' ELSE 'EMPLOYEE_DIRECT' END,
        CASE WHEN ${result.principal.type}='PROJECT' THEN 'PROJECT_DIRECT' WHEN row.project_principal_id IS NOT NULL THEN 'EMPLOYEE_PROJECT' ELSE 'EMPLOYEE_MEMBERSHIP' END,
        row.occurred_at,COALESCE(row.version,0)+1,row.snapshot_id,'CORRECTION','ADMIN_CONFIRMED_BACKFILL',${input.adminId}::uuid
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS row(request_id uuid,occurred_at timestamptz,snapshot_id uuid,version integer,employee_person_id uuid,project_principal_id uuid)`.execute(
      trx,
    );
    await markUsageAggregateDirtyForRequests(trx, input.enterpriseId, ids);
    await trx
      .insertInto("operation_log")
      .values({
        enterprise_id: input.enterpriseId,
        admin_user_id: input.adminId,
        action: "principal.attribution.backfill",
        target_type: "principal",
        target_id: input.principalId,
        result: "SUCCESS",
        failure_reason: null,
        change_summary: {
          department_id: input.departmentId,
          from: input.from.toISOString(),
          until: input.until.toISOString(),
          reason: input.reason.trim(),
          request_ids: ids,
          fingerprint: input.fingerprint,
        },
      })
      .execute();
    return { confirmedCount: ids.length };
  });
}
