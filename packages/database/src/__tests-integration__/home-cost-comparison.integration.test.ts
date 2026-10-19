import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, ProviderFinanceRepository, loadWindowOperatingFinance,
  getStandardHomeSummary, OperatingBillRepository } from "../index.js";
import { createAnalysisFixture } from "./fixtures/operating-analysis.js";
import { countFinanceGaps, countOperatingExpenseGaps } from "../repositories/provider-finance-gaps.js";
import { previewSubscriptionLinkRepair } from "../repositories/provider-finance-subscription-repair-preview.js";
import { loadSubscriptionCoverage } from "../repositories/provider-finance-subscription-coverage.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const start = new Date("2026-09-01T00:00:00+08:00");
const end = new Date("2026-09-19T11:13:00+08:00");
const monthEnd = new Date("2026-10-01T00:00:00+08:00");
beforeAll(async () => {
  pg = await startPostgresContainer("home_cost_comparison");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

type Fixture = Awaited<ReturnType<typeof createAnalysisFixture>>;
async function seedAnalysisUsage(f: Fixture, principal: string, code: string, tokens: bigint,
  at: Date, cost = "0", quality = "PROVIDER_REPORTED", periodId: string | null = null) {
  const requestId=randomUUID(), resource=f.resources.get(code)!;
  await db.insertInto("ai_request").values({id:requestId,enterprise_id:f.enterpriseId,
    principal_id:principal,principal_key_id:f.keys.get(principal)!,protocol:"chat",unified_model:"test",
    status:"SUCCEEDED",started_at:at,finished_at:at}).execute();
  const attempt=await db.insertInto("upstream_attempt").values({enterprise_id:f.enterpriseId,
    ai_request_id:requestId,attempt_no:1,provider_resource_id:resource,upstream_model:"test",
    http_status:200,response_committed:true,finished_at:at}).returning("id").executeTakeFirstOrThrow();
  const usage=await db.insertInto("usage_event").values({enterprise_id:f.enterpriseId,
    ai_request_id:requestId,upstream_attempt_id:attempt.id,provider_resource_id:resource,
    input_tokens:tokens,output_tokens:0n,cache_tokens:0n,reasoning_tokens:0n,
    usage_quality:quality,dedup_key:requestId,created_at:at}).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({enterprise_id:f.enterpriseId,ai_request_id:requestId,
    upstream_attempt_id:attempt.id,usage_event_id:usage.id,provider_resource_id:resource,
    principal_id:principal,resource_mode:code==="deepseek"?"API":"CODING_PLAN",
    raw_input_tokens:tokens,raw_output_tokens:0n,raw_cache_tokens:0n,raw_reasoning_tokens:0n,
    api_cost:code==="deepseek"?cost:null,api_cost_status:code==="deepseek"?"PRICED_USAGE":"NOT_APPLICABLE",
    api_cost_currency:code==="deepseek"?"CNY":null,subscription_period_id:periodId,
    settled_at:at,created_at:at,usage_quality:quality}).execute();
}
async function paidPeriod(f: Fixture, from: string, to: string, amount = "199", code = "kimi") {
  const id = randomUUID();
  await db.transaction().execute(async (trx) => {
    const event = await trx.insertInto("provider_finance_event").values({
      enterprise_id: f.enterpriseId, provider_resource_id: f.resources.get(code)!,
      event_type: "CODING_PLAN_PURCHASE", account_amount: amount, account_currency: "CNY",
      cash_paid_cny: amount, occurred_at: new Date(from), source: "MIGRATION",
      description: "Synthetic test purchase", evidence_ref: "fixture-only", idempotency_key: randomUUID(),
      created_by_admin_user_id: f.adminId,
    }).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("provider_subscription_period").values({ id, enterprise_id: f.enterpriseId,
      provider_resource_id: f.resources.get(code)!, finance_event_id: event.id,
      product_name: "Synthetic plan", period_start: new Date(from), period_end_exclusive: new Date(to),
      source: "PURCHASE", created_by_admin_user_id: f.adminId }).execute();
  });
  return id;
}
async function activeGaps(f: Fixture) {
  return (await countOperatingExpenseGaps(db,f.enterpriseId,start,end)).filter((row) => row.count!=="0");
}

describe("cash expense comparison and persisted subscription attribution", () => {
  it("a unique paid period removes only the cash gap; strict attribution still requires a stored link", async () => {
    const f = await createAnalysisFixture(db);
    const period = await paidPeriod(f,"2026-09-18T00:00:00+08:00","2026-10-18T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",23n,new Date("2026-09-18T16:00:00+08:00"));
    const before = await db.selectFrom("ledger_line").selectAll().where("enterprise_id","=",f.enterpriseId).execute();
    expect(await activeGaps(f)).toEqual([]);
    expect((await countFinanceGaps(db,f.enterpriseId,start,end)).find((r)=>r.code==="SUBSCRIPTION_PERIOD_MISSING")?.count).toBe("1");
    expect(await loadSubscriptionCoverage(db,f.enterpriseId,start,end)).toMatchObject([
      { linkedPeriodId:null,candidatePeriodId:period,matchCount:1,feeKnown:true },
    ]);
    expect(await loadWindowOperatingFinance(db,f.enterpriseId,start,end)).toEqual({
      totalSpends:[{currency:"CNY",amount:"199.00000000"}],incompleteReason:null,
    });
    expect((await new ProviderFinanceRepository(db).getMonthlyFinanceSummary(f.enterpriseId,"2026-09")))
      .toMatchObject({ complete:true,operatingCostCny:"199.00000000" });
    expect(await db.selectFrom("ledger_line").selectAll().where("enterprise_id","=",f.enterpriseId).execute()).toEqual(before);
  });

  it("adjacent periods use an exclusive end; paid August carryover adds no September cash", async () => {
    const f = await createAnalysisFixture(db);
    const old = await paidPeriod(f,"2026-08-18T00:00:00+08:00","2026-09-18T00:00:00+08:00");
    const next = await paidPeriod(f,"2026-09-18T00:00:00+08:00","2026-10-18T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",10n,new Date("2026-09-17T23:59:59.999+08:00"));
    await seedAnalysisUsage(f,f.a,"kimi",20n,new Date("2026-09-18T00:00:00+08:00"));
    const coverage=await loadSubscriptionCoverage(db,f.enterpriseId,start,end);
    expect(coverage.map((r)=>r.candidatePeriodId).sort()).toEqual([old,next].sort());
    expect(coverage.every((r)=>r.matchCount===1)).toBe(true);
    expect(await loadWindowOperatingFinance(db,f.enterpriseId,start,new Date("2026-09-18T00:00:00+08:00")))
      .toEqual({totalSpends:[],incompleteReason:null});
  });

  it("an unpriced prior-month carryover is not a missing payment in the current cash window", async () => {
    const f=await createAnalysisFixture(db);
    await db.insertInto("provider_subscription_period").values({enterprise_id:f.enterpriseId,
      provider_resource_id:f.resources.get("kimi")!,product_name:"Production-shaped carryover",
      period_start:new Date("2026-08-18T00:00:00+08:00"),
      period_end_exclusive:new Date("2026-09-18T00:00:00+08:00"),
      source:"MIGRATED_CARRYOVER",migration_source_record_id:null,created_by_admin_user_id:f.adminId}).execute();
    await seedAnalysisUsage(f,f.a,"kimi",10n,new Date("2026-09-10T00:00:00+08:00"));
    expect(await loadSubscriptionCoverage(db,f.enterpriseId,start,end)).toMatchObject([
      {matchCount:1,feeKnown:false,feeRequiredInWindow:false},
    ]);
    expect(await activeGaps(f)).toEqual([]);
    expect(await loadWindowOperatingFinance(db,f.enterpriseId,start,end)).toEqual({totalSpends:[],incompleteReason:null});
    expect((await countFinanceGaps(db,f.enterpriseId,start,end)).find(r=>r.code==="SUBSCRIPTION_PERIOD_MISSING")?.count).toBe("1");
  });

  it("overlap is a real gap even when both periods are paid and one is linked", async () => {
    const f = await createAnalysisFixture(db);
    const period = await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00");
    await paidPeriod(f,"2026-09-02T00:00:00+08:00","2026-10-02T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",10n,new Date("2026-09-10T00:00:00+08:00"),"0","PROVIDER_REPORTED",period);
    expect(await activeGaps(f)).toEqual([{code:"SUBSCRIPTION_PERIOD_AMBIGUOUS",count:"1"}]);
    expect((await loadSubscriptionCoverage(db,f.enterpriseId,start,end))[0]?.candidatePeriodId).toBeNull();
  });

  it("a period without fee evidence is not a known zero; no period remains missing", async () => {
    const f = await createAnalysisFixture(db);
    await db.insertInto("provider_subscription_period").values({ enterprise_id:f.enterpriseId,
      provider_resource_id:f.resources.get("kimi")!,product_name:"Unpriced carryover",
      period_start:start,period_end_exclusive:monthEnd,source:"MIGRATED_CARRYOVER",migration_source_record_id:randomUUID() }).execute();
    await seedAnalysisUsage(f,f.a,"kimi",10n,new Date("2026-09-10T00:00:00+08:00"));
    await seedAnalysisUsage(f,f.a,"zhipu",10n,new Date("2026-09-10T00:00:00+08:00"));
    expect(await activeGaps(f)).toEqual([
      {code:"SUBSCRIPTION_PERIOD_MISSING",count:"1"},{code:"SUBSCRIPTION_FEE_MISSING",count:"1"},
    ]);
  });

  it("periods of another tenant or resource never repair this usage", async () => {
    const f = await createAnalysisFixture(db), other = await createAnalysisFixture(db);
    await paidPeriod(other,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00");
    await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00","199","zhipu");
    await seedAnalysisUsage(f,f.a,"kimi",10n,new Date("2026-09-10T00:00:00+08:00"));
    expect(await activeGaps(f)).toEqual([{code:"SUBSCRIPTION_PERIOD_MISSING",count:"1"}]);
  });

  it("a reversed period is excluded instead of silently reusing its former price", async () => {
    const f = await createAnalysisFixture(db);
    const id = await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",10n,new Date("2026-09-10T00:00:00+08:00"),"0","PROVIDER_REPORTED",id);
    await db.transaction().execute(async (trx) => {
      const period = await trx.selectFrom("provider_subscription_period").select("finance_event_id").where("id","=",id).executeTakeFirstOrThrow();
      const original = await trx.selectFrom("provider_finance_event").selectAll().where("id","=",period.finance_event_id!).executeTakeFirstOrThrow();
      const reversal = await trx.insertInto("provider_finance_event").values({ ...original,id:randomUUID(),
        event_type:"REVERSAL",account_amount:"-199",cash_paid_cny:"-199",reversal_of_event_id:original.id,
        idempotency_key:randomUUID() }).returning("id").executeTakeFirstOrThrow();
      await trx.updateTable("provider_subscription_period").set({reversed_by_event_id:reversal.id}).where("id","=",id).execute();
    });
    expect(await activeGaps(f)).toEqual([{code:"SUBSCRIPTION_PERIOD_MISSING",count:"1"}]);
    expect((await loadWindowOperatingFinance(db,f.enterpriseId,start,end)).totalSpends).toEqual([]);
  });

  it("late historical API aggregate does not close a shorter comparison, and monthly/home facts agree", async () => {
    const f = await createAnalysisFixture(db);
    await seedAnalysisUsage(f,f.a,"deepseek",10n,new Date("2026-09-18T16:52:15+08:00"));
    await db.updateTable("ledger_line").set({api_cost:null,api_cost_currency:null,api_cost_status:"NOT_MIGRATED"})
      .where("enterprise_id","=",f.enterpriseId).execute();
    await db.insertInto("provider_finance_event").values({enterprise_id:f.enterpriseId,
      provider_resource_id:f.resources.get("deepseek")!,event_type:"API_HISTORICAL_USAGE_COST",
      account_amount:"-40.4572",account_currency:"CNY",occurred_at:new Date("2026-09-21T00:00:00+08:00"),
      source:"MIGRATION",description:"Synthetic historical aggregate",evidence_ref:"fixture-only",
      created_by_admin_user_id:f.adminId,idempotency_key:randomUUID()}).execute();
    await paidPeriod(f,"2026-09-18T00:00:00+08:00","2026-10-18T00:00:00+08:00");
    await paidPeriod(f,"2026-09-26T00:00:00+08:00","2026-10-26T00:00:00+08:00","422.1","zhipu");
    const same = await loadWindowOperatingFinance(db,f.enterpriseId,start,end);
    expect(same).toEqual({totalSpends:[{currency:"CNY",amount:"199.00000000"}],incompleteReason:"API_USAGE_COST_NOT_MIGRATED:1"});
    const whole = await loadWindowOperatingFinance(db,f.enterpriseId,start,monthEnd);
    expect(whole).toEqual({totalSpends:[{currency:"CNY",amount:"661.55720000"}],incompleteReason:null});
    expect((await new ProviderFinanceRepository(db).getMonthlyFinanceSummary(f.enterpriseId,"2026-09")))
      .toMatchObject({operatingCostCny:whole.totalSpends[0]!.amount,complete:true});
    const bill = await new OperatingBillRepository(db).getBill(f.enterpriseId,"2026-10");
    const home = await getStandardHomeSummary(db,{enterpriseId:f.enterpriseId,
      asOf:new Date("2026-10-19T11:13:00+08:00"),bill,financeRead:true});
    expect(home.monthlyCost.previous).toMatchObject(same);
    expect(home.monthlyCost.previous?.window.rangeEndExclusive).toBe(end.toISOString());
  });

  it.each(["CNY","USD"])("uses the latest registered fee snapshot consistently (%s)", async (currency) => {
    const f=await createAnalysisFixture(db), resource=f.resources.get("kimi")!;
    const snapshot=await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id:f.enterpriseId,provider_resource_id:resource,version:1,source:"ADMIN",
      collected_at:start,currency:"CNY",package_name:"Synthetic",package_cost:"199",
      effective_from:start,effective_until:monthEnd,usage_calculation:"SYSTEM_LEDGER",
    }).returning("id").executeTakeFirstOrThrow();
    const period=await db.insertInto("provider_subscription_period").values({enterprise_id:f.enterpriseId,
      provider_resource_id:resource,product_name:"Synthetic",period_start:start,period_end_exclusive:monthEnd,
      source:"MIGRATED_CARRYOVER",migration_source_record_id:snapshot.id}).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id:f.enterpriseId,provider_resource_id:resource,version:2,source:"ADMIN",
      collected_at:new Date(start.getTime()+1000),currency,package_name:"Synthetic",package_cost:"207",
      subscription_period_id:period.id,effective_from:start,effective_until:monthEnd,usage_calculation:"SYSTEM_LEDGER",
    }).execute();
    await seedAnalysisUsage(f,f.a,"kimi",10n,start);
    expect((await loadSubscriptionCoverage(db,f.enterpriseId,start,end))[0]?.feeKnown).toBe(currency==="CNY");
    expect(await loadWindowOperatingFinance(db,f.enterpriseId,start,end)).toEqual(currency==="CNY"
      ? {totalSpends:[{currency:"CNY",amount:"207.00000000"}],incompleteReason:null}
      : {totalSpends:[],incompleteReason:"SUBSCRIPTION_FEE_MISSING:1"});
  });

  it("recognizes an existing legacy purchase once and suppresses duplicate snapshot registration", async () => {
    const f=await createAnalysisFixture(db), resource=f.resources.get("kimi")!;
    const purchase=await db.insertInto("resource_purchase_record").values({enterprise_id:f.enterpriseId,
      provider_resource_id:resource,purchase_type:"PACKAGE_PURCHASE",amount:"199",currency:"CNY",
      purchased_at:start,source:"ADMIN",created_by:f.adminId,description:"Synthetic"})
      .returning("id").executeTakeFirstOrThrow();
    const period=await db.insertInto("provider_subscription_period").values({enterprise_id:f.enterpriseId,
      provider_resource_id:resource,product_name:"Synthetic",period_start:start,period_end_exclusive:monthEnd,
      source:"MIGRATED_PURCHASE",migration_source_record_id:purchase.id}).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("provider_resource_operating_snapshot").values({enterprise_id:f.enterpriseId,
      provider_resource_id:resource,version:1,source:"ADMIN",collected_at:start,currency:"CNY",
      package_name:"Synthetic",package_cost:"199",subscription_period_id:period.id,
      effective_from:start,effective_until:monthEnd,usage_calculation:"SYSTEM_LEDGER"}).execute();
    await seedAnalysisUsage(f,f.a,"kimi",10n,start);
    expect(await loadWindowOperatingFinance(db,f.enterpriseId,start,end)).toEqual({
      totalSpends:[{currency:"CNY",amount:"199.00000000"}],incompleteReason:null});
  });

  it("the standalone read-only SQL lists the same exact rows and fingerprints as the proposal", async () => {
    const f=await createAnalysisFixture(db);
    await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",13n,start);
    const audit=await readFile(new URL("../../../../V4/Evidence/HOME-COST-COMPARISON-20261019/subscription-link-audit.sql",import.meta.url),"utf8");
    const query=audit.slice(audit.indexOf("WITH scoped"),audit.indexOf("ROLLBACK;"))
      .replaceAll(":'enterprise'",`'${f.enterpriseId}'`)
      .replaceAll(":'window_start'",`'${start.toISOString()}'`)
      .replaceAll(":'window_end'",`'${end.toISOString()}'`);
    const actual=await db.transaction().execute(async trx=>{
      await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
      return sql.raw<{ledger_line_id:string;proposed_period_id:string;before_line_hash:string;non_target_hash:string}>(query).execute(trx);
    });
    const proposal=await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end);
    expect(actual.rows).toMatchObject([{ledger_line_id:proposal.rows[0]!.ledgerLineId,
      proposed_period_id:proposal.rows[0]!.candidatePeriodId,before_line_hash:proposal.rows[0]!.lineHash,
      non_target_hash:proposal.rows[0]!.nonTargetHash}]);
  });

  it("read-only repair proposal fixes exact IDs and detects line/period drift, including ambiguous matches", async () => {
    const f=await createAnalysisFixture(db);
    const period=await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",10n,start);
    await seedAnalysisUsage(f,f.a,"zhipu",10n,start);
    const first=await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end);
    const second=await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end);
    expect(second.hash).toBe(first.hash);
    expect(first.summary).toEqual({proposedRows:1,blockedRows:1,missingFeeRows:0});
    expect(first.rows[0]).toMatchObject({linkedPeriodId:null,candidatePeriodId:period});
    expect(first.rows[0]?.lineHash).toMatch(/^[0-9a-f]{32}$/);
    expect(first.rows[0]?.nonTargetHash).toMatch(/^[0-9a-f]{32}$/);
    expect(first.rows[0]?.periodHash).toMatch(/^[0-9a-f]{32}$/);
    await db.updateTable("ledger_line").set({raw_input_tokens:11n})
      .where("id","=",first.rows[0]!.ledgerLineId).execute();
    expect((await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end)).hash).not.toBe(first.hash);
    await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-02T00:00:00+08:00");
    expect((await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end)).summary.proposedRows).toBe(0);
  });

  it("rehearses fixed-row links, verifies unchanged amounts/non-target fields, and rolls the transaction back", async () => {
    const f=await createAnalysisFixture(db);
    await paidPeriod(f,"2026-09-01T00:00:00+08:00","2026-10-01T00:00:00+08:00");
    await seedAnalysisUsage(f,f.a,"kimi",31n,start);
    const proposal=await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end);
    await expect(db.transaction().execute(async (trx)=>{
      await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
      for (const row of proposal.rows) {
        const changed=await sql`UPDATE ledger_line l SET subscription_period_id=${row.candidatePeriodId}::uuid
          WHERE l.enterprise_id=${f.enterpriseId}::uuid AND l.id=${row.ledgerLineId}::uuid
            AND l.subscription_period_id IS NULL AND md5(to_jsonb(l)::text)=${row.lineHash}`.execute(trx);
        expect(Number(changed.numAffectedRows)).toBe(1);
      }
      const after=await loadSubscriptionCoverage(trx,f.enterpriseId,start,end,true);
      expect(after[0]?.nonTargetHash).toBe(proposal.rows[0]?.nonTargetHash);
      expect(after[0]?.linkedPeriodId).toBe(proposal.rows[0]?.candidatePeriodId);
      expect((await countFinanceGaps(trx,f.enterpriseId,start,end)).find(r=>r.code==="SUBSCRIPTION_PERIOD_MISSING")?.count).toBe("0");
      expect(await loadWindowOperatingFinance(trx,f.enterpriseId,start,end)).toEqual(proposal.expenses);
      throw new Error("REHEARSAL_ROLLBACK");
    })).rejects.toThrow("REHEARSAL_ROLLBACK");
    expect((await previewSubscriptionLinkRepair(db,f.enterpriseId,start,end)).hash).toBe(proposal.hash);
  });

  it("window is half open, settlement fallback is explicit, and read-only checks leave ledger bytes unchanged", async () => {
    const f=await createAnalysisFixture(db);
    await seedAnalysisUsage(f,f.a,"kimi",10n,start);
    await seedAnalysisUsage(f,f.a,"kimi",20n,end);
    await db.updateTable("ledger_line").set({settled_at:null}).where("enterprise_id","=",f.enterpriseId).execute();
    const hash = () => sql<{hash:string}>`SELECT md5(string_agg(to_jsonb(l)::text,',' ORDER BY id)) AS hash
      FROM ledger_line l WHERE enterprise_id=${f.enterpriseId}::uuid`.execute(db);
    const before=await hash();
    expect(await activeGaps(f)).toEqual([{code:"SUBSCRIPTION_PERIOD_MISSING",count:"1"}]);
    expect(await hash()).toEqual(before);
    expect(await loadSubscriptionCoverage(db,f.enterpriseId,new Date("2026-08-01"),start)).toEqual([]);
  });
});
