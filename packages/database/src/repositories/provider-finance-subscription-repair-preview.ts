import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { loadSubscriptionCoverage } from "./provider-finance-subscription-coverage.js";
import { loadWindowOperatingFinance } from "./dashboard-home-costs.js";

/** Read-only fixed-row proposal. It has no apply mode and never changes financial facts.
 * Keep real manifests outside Git: they contain production row identities/fingerprints.
 */
export async function previewSubscriptionLinkRepair(
  db: Kysely<Database>, enterpriseId: string, start: Date, end: Date,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(enterpriseId)
    || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start>=end) {
    throw new Error("Explicit enterprise UUID and a valid half-open window required");
  }
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
    await sql`SET LOCAL statement_timeout='30s'`.execute(trx);
    const tenant=await trx.selectFrom("enterprise").select("id").where("id","=",enterpriseId).executeTakeFirst();
    if (!tenant) throw new Error("Enterprise not found");
    const coverage=await loadSubscriptionCoverage(trx,enterpriseId,start,end,true);
    const expenses=await loadWindowOperatingFinance(trx,enterpriseId,start,end);
    const rows=coverage.filter((row)=>row.linkedPeriodId===null && row.matchCount===1);
    const blocked=coverage.filter((row)=>row.matchCount!==1 ||
      (row.linkedPeriodId!==null && row.linkedPeriodId!==row.candidatePeriodId));
    const fixedSet={schemaVersion:1,enterpriseId,start:start.toISOString(),endExclusive:end.toISOString(),
      allowedColumn:"subscription_period_id",rows,blocked,coverageHash:createHash("sha256")
        .update(JSON.stringify(coverage)).digest("hex"),expenses};
    const hash=createHash("sha256").update(JSON.stringify(fixedSet)).digest("hex");
    return {mode:"READ_ONLY_PROPOSAL" as const,generatedAt:new Date().toISOString(),hash,...fixedSet,
      summary:{proposedRows:rows.length,blockedRows:blocked.length,
        missingFeeRows:coverage.filter((row)=>row.matchCount===1&&row.feeRequiredInWindow&&!row.feeKnown).length}};
  });
}
