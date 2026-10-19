import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer,type PostgresTestInstance } from "@qianliu/testing";
import { createKysely,migrateToLatest } from "../index.js";
import { createAnalysisFixture } from "./fixtures/operating-analysis.js";
import { loadSubscriptionCoverage } from "../repositories/provider-finance-subscription-coverage.js";
import { executeSubscriptionLinkRepair,subscriptionLinkManifestHash,type SubscriptionLinkRepairManifest }
  from "../repositories/provider-finance-subscription-link-repair.js";
let pg:PostgresTestInstance;
let db:ReturnType<typeof createKysely>;
const start=new Date("2026-09-01T00:00:00+08:00"),end=new Date("2026-10-01T00:00:00+08:00");
beforeAll(async()=>{pg=await startPostgresContainer("subscription_link_repair");db=createKysely(pg.connectionString);await migrateToLatest(db);},120_000);
afterAll(async()=>{await db?.destroy();await pg?.stop();},60_000);
async function fixture(){
 const f=await createAnalysisFixture(db),resource=f.resources.get("kimi")!;
 await db.updateTable("admin_user").set({role_code:"SUPER_ADMIN"}).where("id","=",f.adminId).execute();
 const period=await db.insertInto("provider_subscription_period").values({enterprise_id:f.enterpriseId,
  provider_resource_id:resource,product_name:"Synthetic",period_start:start,period_end_exclusive:end,
  source:"MIGRATED_CARRYOVER",created_by_admin_user_id:f.adminId}).returning("id").executeTakeFirstOrThrow();
 async function addLine(){
  const request=randomUUID();
  await db.insertInto("ai_request").values({id:request,enterprise_id:f.enterpriseId,principal_id:f.a,
   principal_key_id:f.keys.get(f.a)!,protocol:"chat",unified_model:"test",status:"SUCCEEDED",started_at:start,finished_at:start}).execute();
  const attempt=await db.insertInto("upstream_attempt").values({enterprise_id:f.enterpriseId,ai_request_id:request,
   attempt_no:1,provider_resource_id:resource,upstream_model:"test",http_status:200,finished_at:start}).returning("id").executeTakeFirstOrThrow();
  const usage=await db.insertInto("usage_event").values({enterprise_id:f.enterpriseId,ai_request_id:request,
   upstream_attempt_id:attempt.id,provider_resource_id:resource,input_tokens:7n,output_tokens:2n,cache_tokens:0n,
   reasoning_tokens:0n,usage_quality:"PROVIDER_REPORTED",dedup_key:request,created_at:start}).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({enterprise_id:f.enterpriseId,ai_request_id:request,
   upstream_attempt_id:attempt.id,usage_event_id:usage.id,provider_resource_id:resource,principal_id:f.a,
   resource_mode:"CODING_PLAN",raw_input_tokens:7n,raw_output_tokens:2n,raw_cache_tokens:0n,raw_reasoning_tokens:0n,
   api_cost_status:"NOT_APPLICABLE",usage_quality:"PROVIDER_REPORTED",settled_at:start,created_at:start}).execute();
 }
 await addLine();
 const coverage=await db.transaction().execute(async trx=>{
  await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
  return loadSubscriptionCoverage(trx,f.enterpriseId,start,end,true);
 });
 const core={schemaVersion:1 as const,mode:"PROPOSAL_ONLY" as const,enterpriseId:f.enterpriseId,snapshot:"fixture",
  snapshotAt:new Date().toISOString(),windowStart:start.toISOString(),windowEndExclusive:end.toISOString(),
  allowedColumn:"subscription_period_id" as const,rowCount:coverage.length,rows:coverage.map(r=>({
   ledgerLineId:r.ledgerLineId,resourceId:r.providerResourceId,usageAt:start.toISOString(),beforePeriodId:null,
   matchCount:1 as const,targetPeriodId:r.candidatePeriodId!,lineHash:r.lineHash,nonTargetHash:r.nonTargetHash,periodHash:r.periodHash!,
  }))};
 const manifest:SubscriptionLinkRepairManifest={...core,candidateSha256:subscriptionLinkManifestHash(core)};
 const auth={adminId:f.adminId,approvalRef:"fixture:explicit-owner-approval",direction:"APPLY" as const};
 const lines=()=>db.selectFrom("ledger_line").selectAll().where("enterprise_id","=",f.enterpriseId).orderBy("id").execute();
 return {...f,period,manifest,auth,lines,addLine};
}

describe("approved fixed-row link repair and restoration (local synthetic DB only)",()=>{
 it("changes only the approved link; audit/dirty generation commit atomically and revert restores exact ledger facts",async()=>{
  const f=await fixture(),before=await f.lines();
  const receipt=await executeSubscriptionLinkRepair(db,f.manifest,f.auth);
  expect(receipt.rowCount).toBe(1);expect(receipt.beforeConservationHash).toBe(receipt.afterConservationHash);
  expect(await f.lines()).toEqual(before.map(r=>({...r,subscription_period_id:f.period.id})));
  expect((await db.selectFrom("project_allocation_dirty").selectAll().where("enterprise_id","=",f.enterpriseId).execute())[0]?.dirty).toBe(true);
  await expect(executeSubscriptionLinkRepair(db,f.manifest,f.auth)).rejects.toThrow("server facts or eligibility set changed");
  await executeSubscriptionLinkRepair(db,f.manifest,{...f.auth,direction:"REVERT"});
  expect(await f.lines()).toEqual(before);
  const audits=await db.selectFrom("operation_log").select("action").where("enterprise_id","=",f.enterpriseId).execute();
  expect(audits.map(a=>a.action).sort()).toEqual(["provider_finance.subscription_link.apply","provider_finance.subscription_link.revert"]);
 });
 it("rejects manifest edits, absent approval, and a foreign tenant owner without partial writes",async()=>{
  const f=await fixture(),foreign=await fixture(),before=await f.lines();
  await expect(executeSubscriptionLinkRepair(db,{...f.manifest,rowCount:2},f.auth)).rejects.toThrow("manifest hash mismatch");
  await expect(executeSubscriptionLinkRepair(db,f.manifest,{...f.auth,approvalRef:"NOT_APPROVED"})).rejects.toThrow("approval reference");
  await expect(executeSubscriptionLinkRepair(db,f.manifest,{...f.auth,adminId:foreign.adminId})).rejects.toThrow("active tenant owner");
  expect(await f.lines()).toEqual(before);
 });
 it("refuses changed ledger facts, overlapping periods and newly eligible rows",async()=>{
  const f=await fixture();
  await db.updateTable("ledger_line").set({raw_input_tokens:8n}).where("id","=",f.manifest.rows[0]!.ledgerLineId).execute();
  await expect(executeSubscriptionLinkRepair(db,f.manifest,f.auth)).rejects.toThrow("server facts");
  expect((await f.lines())[0]?.subscription_period_id).toBeNull();
  const overlap=await fixture();
  await db.insertInto("provider_subscription_period").values({enterprise_id:overlap.enterpriseId,
   provider_resource_id:overlap.resources.get("kimi")!,product_name:"Overlap",period_start:start,
   period_end_exclusive:end,source:"MIGRATED_CARRYOVER",created_by_admin_user_id:overlap.adminId}).execute();
  await expect(executeSubscriptionLinkRepair(db,overlap.manifest,overlap.auth)).rejects.toThrow("server facts");
  const added=await fixture();await added.addLine();
  await expect(executeSubscriptionLinkRepair(db,added.manifest,added.auth)).rejects.toThrow("eligibility set changed");
 });
 it("refuses closed months and refuses a revert that would overwrite later changes",async()=>{
  const f=await fixture();
  await db.insertInto("operating_bill_period").values({enterprise_id:f.enterpriseId,period_month:"2026-09-01",
   status:"CLOSED",created_by:f.adminId}).execute();
  await expect(executeSubscriptionLinkRepair(db,f.manifest,f.auth)).rejects.toThrow();
  expect((await f.lines())[0]?.subscription_period_id).toBeNull();
  const later=await fixture();await executeSubscriptionLinkRepair(db,later.manifest,later.auth);
  await db.updateTable("ledger_line").set({raw_output_tokens:3n}).where("id","=",later.manifest.rows[0]!.ledgerLineId).execute();
  await expect(executeSubscriptionLinkRepair(db,later.manifest,{...later.auth,direction:"REVERT"})).rejects.toThrow("server facts");
  expect((await later.lines())[0]?.subscription_period_id).toBe(later.period.id);
  expect((await sql<{n:string}>`SELECT count(*)::text AS n FROM operation_log
    WHERE enterprise_id=${later.enterpriseId}::uuid AND action='provider_finance.subscription_link.revert'`.execute(db)).rows[0]?.n).toBe("0");
 });
});
