import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";

export async function archiveDispatchPolicy(db: Kysely<Database>, enterpriseId: string,
  policyId: string, actor: string, expectedVersion: number) {
  return db.transaction().execute(async (trx) => {
    const row = await trx.updateTable("dispatch_policy")
      .set({ archived_at: new Date(), archived_by_admin_id: actor, version: sql`version + 1`, updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", policyId)
      .where("status", "=", "RETIRED").where("archived_at", "is", null)
      .where("version", "=", expectedVersion).returning("id").executeTakeFirst();
    if (!row) return false;
    await trx.insertInto("operation_log").values({ enterprise_id: enterpriseId, admin_user_id: actor,
      action: "dispatch_policy.archive", target_type: "dispatch_policy", target_id: policyId,
      change_summary: { before_version: expectedVersion, status: "RETIRED", archived: true },
      result: "SUCCESS", failure_reason: null }).execute();
    return true;
  });
}
