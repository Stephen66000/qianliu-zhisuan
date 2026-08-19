import type { Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import type { OperatingBillPeriod } from "./operating-bill-types.js";

export async function ensureOperatingBillPeriod(
  db: Kysely<Database>, enterpriseId: string, adminId: string, month: string,
): Promise<OperatingBillPeriod> {
  const range = operatingBillMonthRange(month);
  const inserted = await db.insertInto("operating_bill_period").values({
    enterprise_id: enterpriseId, period_month: range.monthDate, created_by: adminId,
  }).onConflict((oc) => oc.columns(["enterprise_id", "period_month"]).doNothing())
    .returningAll().executeTakeFirst();
  const period = inserted ?? await db.selectFrom("operating_bill_period").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("period_month", "=", range.monthDate)
    .executeTakeFirst();
  if (!period) throw new Error("operating_bill_period_create_failed");
  if (inserted) await db.insertInto("operating_bill_event").values({
    enterprise_id: enterpriseId, period_id: period.id, action: "CREATED", version: 0,
    reason: null, actor_admin_id: adminId, metadata: { month },
  }).execute();
  return period;
}
