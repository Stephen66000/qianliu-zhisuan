import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { allocationMonthsForRequests, markAllocationDirty } from "./project-allocation-common.js";

export interface SubscriptionLinkRepairRow {
  ledgerLineId: string; resourceId: string; usageAt: string; beforePeriodId: null;
  matchCount: 1; targetPeriodId: string; lineHash: string; nonTargetHash: string; periodHash: string;
}
export interface SubscriptionLinkRepairManifest {
  schemaVersion: 1; mode: "PROPOSAL_ONLY"; enterpriseId: string; snapshot: string;
  snapshotAt: string; windowStart: string; windowEndExclusive: string;
  allowedColumn: "subscription_period_id"; rowCount: number; rows: SubscriptionLinkRepairRow[];
  candidateSha256: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function subscriptionLinkManifestHash(manifest: Omit<SubscriptionLinkRepairManifest,"candidateSha256">): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}
function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Subscription link repair: ${message}`);
}

/** No caller runs this automatically. Requires a separately approved, exact manifest.
 * Only subscription_period_id changes on ledger lines; guard/dirty/audit metadata is
 * written in the same transaction. No events, fees, tokens or pricing facts change.
 * Revert uses the original manifest and refuses subsequent edits to any fixed row.
 */
export async function executeSubscriptionLinkRepair(
  db: Kysely<Database>, manifest: SubscriptionLinkRepairManifest,
  authorization: { adminId: string; approvalRef: string; direction: "APPLY" | "REVERT" },
) {
  const {candidateSha256,...core}=manifest;
  const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const fingerprint=/^[a-f0-9]{32}$/;
  requireFact(authorization.approvalRef.trim() && !/NOT_APPROVED|PROPOSAL_ONLY|PENDING/i.test(authorization.approvalRef),
    "explicit approval reference required");
  requireFact(["APPLY","REVERT"].includes(authorization.direction),"invalid direction");
  requireFact(manifest.schemaVersion===1 && manifest.mode==="PROPOSAL_ONLY"
    && manifest.allowedColumn==="subscription_period_id" && uuid.test(manifest.enterpriseId)
    && uuid.test(authorization.adminId),"invalid manifest identity");
  requireFact(candidateSha256===subscriptionLinkManifestHash(core),"manifest hash mismatch");
  requireFact(manifest.rowCount>0 && manifest.rowCount===manifest.rows.length
    && new Set(manifest.rows.map(r=>r.ledgerLineId)).size===manifest.rowCount,"invalid fixed row set");
  requireFact(manifest.rows.every(r=>uuid.test(r.ledgerLineId)&&uuid.test(r.resourceId)&&uuid.test(r.targetPeriodId)
    && r.beforePeriodId===null && r.matchCount===1 && [r.lineHash,r.nonTargetHash,r.periodHash].every(h=>fingerprint.test(h))),
    "invalid fixed row facts");
  const start=new Date(manifest.windowStart), end=new Date(manifest.windowEndExclusive);
  const month=manifest.windowStart ? new Date(start.getTime()+8*3_600_000).toISOString().slice(0,7) : "";
  const range=operatingBillMonthRange(month);
  requireFact(start.getTime()===range.start.getTime() && end>start && end<=range.end,"one explicit Shanghai month required");
  const reverting=authorization.direction==="REVERT";
  return db.transaction().setIsolationLevel("serializable").execute(async trx=>{
    // Match the production export's timestamptz JSON representation, regardless of client defaults.
    await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
    await sql`SET LOCAL lock_timeout='2s'`.execute(trx);
    await sql`SET LOCAL statement_timeout='30s'`.execute(trx);
    const admin=await trx.selectFrom("admin_user").select("id").where("enterprise_id","=",manifest.enterpriseId)
      .where("id","=",authorization.adminId).where("status","=","ACTIVE").where("role_code","=","SUPER_ADMIN")
      .where("archived_at","is",null).executeTakeFirst();
    requireFact(admin,"active tenant owner required");
    await guardOperatingBillLedgerWrite(trx,manifest.enterpriseId,start);
    // Stage data is a DB temp relation, never a server file. Locks are acquired only
    // after staging so the fixed-row transfer does not stall live settlements.
    await sql`CREATE TEMP TABLE approved_subscription_link_rows ON COMMIT DROP AS
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(manifest.rows)}::jsonb) AS r(
        "ledgerLineId" uuid,"resourceId" uuid,"usageAt" timestamptz,"beforePeriodId" uuid,
        "matchCount" integer,"targetPeriodId" uuid,"lineHash" text,"nonTargetHash" text,"periodHash" text)`
      .execute(trx);
    await sql`LOCK TABLE provider_subscription_period IN SHARE MODE`.execute(trx);
    await sql`LOCK TABLE ledger_line IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
    const {rows:[check]}=await sql<{bad:string;unlinked:string}>`
      SELECT COUNT(*) FILTER(WHERE l.id IS NULL OR l.resource_mode<>'CODING_PLAN'
        OR l.provider_resource_id<>r."resourceId"
        OR COALESCE(l.settled_at,l.created_at) IS DISTINCT FROM r."usageAt"
        OR r."usageAt"<${start} OR r."usageAt">=${end}
        OR l.subscription_period_id IS DISTINCT FROM CASE WHEN ${reverting} THEN r."targetPeriodId" ELSE NULL::uuid END
        OR md5((to_jsonb(l)-'subscription_period_id')::text)<>r."nonTargetHash"
        OR (NOT ${reverting} AND md5(to_jsonb(l)::text)<>r."lineHash")
        OR p.id IS NULL OR p.provider_resource_id<>r."resourceId" OR p.reversed_by_event_id IS NOT NULL
        OR p.period_start>r."usageAt" OR p.period_end_exclusive<=r."usageAt"
        OR md5(to_jsonb(p)::text)<>r."periodHash"
        OR (SELECT COUNT(*) FROM provider_subscription_period c WHERE c.enterprise_id=${manifest.enterpriseId}::uuid
          AND c.provider_resource_id=r."resourceId" AND c.reversed_by_event_id IS NULL
          AND c.period_start<=r."usageAt" AND c.period_end_exclusive>r."usageAt")<>1)::text AS bad,
        (SELECT COUNT(*)::text FROM ledger_line x WHERE x.enterprise_id=${manifest.enterpriseId}::uuid
          AND x.resource_mode='CODING_PLAN' AND x.subscription_period_id IS NULL
          AND COALESCE(x.settled_at,x.created_at)>=${start} AND COALESCE(x.settled_at,x.created_at)<${end}) AS unlinked
      FROM approved_subscription_link_rows r
      LEFT JOIN ledger_line l ON l.enterprise_id=${manifest.enterpriseId}::uuid AND l.id=r."ledgerLineId"
      LEFT JOIN provider_subscription_period p ON p.enterprise_id=${manifest.enterpriseId}::uuid AND p.id=r."targetPeriodId"`
      .execute(trx);
    requireFact(check?.bad==="0" && (reverting || Number(check.unlinked)===manifest.rowCount),"server facts or eligibility set changed");
    const conservation=()=>sql<{hash:string}>`SELECT md5(jsonb_build_object(
      'lines',(SELECT jsonb_agg(to_jsonb(l)-'subscription_period_id' ORDER BY l.id) FROM ledger_line l
        JOIN approved_subscription_link_rows r ON r."ledgerLineId"=l.id WHERE l.enterprise_id=${manifest.enterpriseId}::uuid),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM provider_finance_event e WHERE e.enterprise_id=${manifest.enterpriseId}::uuid),
      'periods',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM provider_subscription_period p WHERE p.enterprise_id=${manifest.enterpriseId}::uuid)
      )::text) AS hash`.execute(trx);
    const before=(await conservation()).rows[0]!.hash;
    const changed=await sql`UPDATE ledger_line l SET subscription_period_id=
      CASE WHEN ${reverting} THEN r."beforePeriodId" ELSE r."targetPeriodId" END
      FROM approved_subscription_link_rows r WHERE l.enterprise_id=${manifest.enterpriseId}::uuid AND l.id=r."ledgerLineId"`
      .execute(trx);
    requireFact(Number(changed.numAffectedRows)===manifest.rowCount,"updated count mismatch");
    const targets=await sql<{bad:string}>`SELECT COUNT(*) FILTER(WHERE l.id IS NULL
      OR l.subscription_period_id IS DISTINCT FROM CASE WHEN ${reverting} THEN r."beforePeriodId" ELSE r."targetPeriodId" END)::text AS bad
      FROM approved_subscription_link_rows r LEFT JOIN ledger_line l
        ON l.enterprise_id=${manifest.enterpriseId}::uuid AND l.id=r."ledgerLineId"`.execute(trx);
    requireFact(targets.rows[0]?.bad==="0","target association verification failed");
    const after=(await conservation()).rows[0]!.hash;
    requireFact(after===before,"non-target or financial facts changed");
    const requests=await sql<{id:string}>`SELECT DISTINCT l.ai_request_id AS id FROM ledger_line l
      JOIN approved_subscription_link_rows r ON r."ledgerLineId"=l.id WHERE l.enterprise_id=${manifest.enterpriseId}::uuid`.execute(trx);
    await markAllocationDirty(trx,manifest.enterpriseId,
      await allocationMonthsForRequests(trx,manifest.enterpriseId,requests.rows.map(r=>r.id)));
    const receipt={direction:authorization.direction,manifestSha256:candidateSha256,rowCount:manifest.rowCount,
      beforeConservationHash:before,afterConservationHash:after,approvalRef:authorization.approvalRef};
    await trx.insertInto("operation_log").values({enterprise_id:manifest.enterpriseId,admin_user_id:authorization.adminId,
      actor_source:"ADMIN",action:`provider_finance.subscription_link.${authorization.direction.toLowerCase()}`,
      target_type:"enterprise",target_id:manifest.enterpriseId,result:"SUCCESS",failure_reason:null,change_summary:receipt}).execute();
    return receipt;
  });
}
