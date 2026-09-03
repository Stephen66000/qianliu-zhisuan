import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { OperatingBillReferenceError } from "./operating-bill-errors.js";
import type {
  OperatingBillPeriod, OperatingBillValueItemView, OperatingBillView,
} from "./operating-bill-types.js";

export function findOperatingBillPeriod(
  db: Kysely<Database>, enterpriseId: string, monthDate: string,
): Promise<OperatingBillPeriod | undefined> {
  return db.selectFrom("operating_bill_period").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("period_month", "=", monthDate)
    .executeTakeFirst();
}

export async function listAvailableOperatingBillMonths(enterpriseId: string, db: Kysely<Database>): Promise<Array<{
  month: string; status: "DRAFT" | "CLOSED"; currentVersion: number;
}>> {
  const result = await sql<{ month: string; status: "DRAFT" | "CLOSED"; current_version: number }>`
    SELECT to_char(period_month, 'YYYY-MM') AS month, status, current_version
      FROM operating_bill_period WHERE enterprise_id = ${enterpriseId}
     ORDER BY period_month DESC
  `.execute(db);
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
  const rows = result.rows.map((row) => ({
    month: row.month, status: row.status, currentVersion: row.current_version,
  }));
  if (!rows.some((row) => row.month === current)) {
    rows.unshift({ month: current, status: "DRAFT", currentVersion: 0 });
  }
  return rows;
}

export async function getOperatingBillValueItem(
  db: Kysely<Database>, enterpriseId: string, id: string,
): Promise<OperatingBillValueItemView> {
  const item = await valueItemQuery(db, enterpriseId).where("v.id", "=", id).executeTakeFirst();
  if (!item) throw new OperatingBillReferenceError();
  return item;
}

export function listOperatingBillValueItems(
  db: Kysely<Database>, enterpriseId: string, periodId: string,
): Promise<OperatingBillValueItemView[]> {
  return valueItemQuery(db, enterpriseId).where("v.period_id", "=", periodId)
    .orderBy("v.created_at", "asc").execute();
}

function valueItemQuery(db: Kysely<Database>, enterpriseId: string) {
  return db.selectFrom("operating_bill_value_item as v")
    .innerJoin("admin_user as submitter", "submitter.id", "v.submitted_by")
    .leftJoin("admin_user as confirmer", "confirmer.id", "v.confirmed_by")
    .leftJoin("principal as related", "related.id", "v.related_principal_id")
    .selectAll("v")
    .select([
      "submitter.display_name as submitted_by_name", "confirmer.display_name as confirmed_by_name",
      "related.name as related_principal_name",
    ]).where("v.enterprise_id", "=", enterpriseId);
}

export async function listOperatingBillVersions(
  db: Kysely<Database>, enterpriseId: string, periodId: string,
): Promise<OperatingBillView["versions"]> {
  const rows = await db.selectFrom("operating_bill_version as v")
    .innerJoin("admin_user as a", "a.id", "v.closed_by")
    .select(["v.id", "v.version", "v.closed_at", "v.close_note", "v.exceptions", "a.display_name as closed_by_name"])
    .where("v.enterprise_id", "=", enterpriseId).where("v.period_id", "=", periodId)
    .orderBy("v.version", "desc").execute();
  return rows.map((row) => ({
    id: row.id, version: row.version, closedAt: row.closed_at.toISOString(),
    closedBy: row.closed_by_name, closeNote: row.close_note, exceptions: row.exceptions,
  }));
}

export async function listOperatingBillEvents(
  db: Kysely<Database>, enterpriseId: string, periodId: string,
): Promise<OperatingBillView["events"]> {
  const rows = await db.selectFrom("operating_bill_event as e")
    .innerJoin("admin_user as a", "a.id", "e.actor_admin_id")
    .select(["e.id", "e.action", "e.version", "e.reason", "e.created_at", "a.display_name as actor_name"])
    .where("e.enterprise_id", "=", enterpriseId).where("e.period_id", "=", periodId)
    .orderBy("e.created_at", "desc").execute();
  return rows.map((row) => ({
    id: row.id, action: row.action, version: row.version, reason: row.reason,
    actor: row.actor_name, createdAt: row.created_at.toISOString(),
  }));
}
