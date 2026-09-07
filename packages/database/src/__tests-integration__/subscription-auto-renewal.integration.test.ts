import { createMigrator } from "../migrator.js";
import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, OperatingBillRepository, ProviderFinanceRepository, renewDueSubscription,
  runSubscriptionAutoRenewals, getSubscriptionAutoRenewal, cancelSubscriptionAutoRenewal, loadOperatingAnalysis } from "../index.js";
import { createAnalysisFixture } from "./fixtures/operating-analysis.js";
let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>;
const d = (s: string) => new Date(`${s}T00:00:00+08:00`);
beforeAll(async () => { pg=await startPostgresContainer();db=createKysely(pg.connectionString);await migrateToLatest(db); },120000);
afterAll(async () => { await db?.destroy();await pg?.stop(); });
async function fixture(active=true) {
  const t=await createAnalysisFixture(db); const resourceId=t.resources.get("kimi")!;
  if (active) await sql`INSERT INTO provider_finance_runtime_state (enterprise_id,strict_writes_enabled,activated_at,activated_by_admin_user_id,updated_at)
    VALUES (${t.enterpriseId}::uuid,true,now(),${t.adminId}::uuid,now())`.execute(db);
  const input={enterpriseId:t.enterpriseId,resourceId,adminId:t.adminId,kind:"PURCHASE" as const,
    productName:"Kimi",accountAmount:"199",accountCurrency:"CNY" as const,cashPaidCny:"199",occurredAt:d("2026-09-01"),
    periodStart:d("2026-09-01"),periodEndExclusive:d("2026-09-02"),idempotencyKey:randomUUID()};
  await new ProviderFinanceRepository(db).recordSubscription(input);
  return {...t,resourceId,input};
}
it("migration up/down/up is reversible before instructions or system facts exist", async () => {
  const migrator=createMigrator(db); const down=await migrator.migrateDown();expect(down.error).toBeUndefined();
  expect(down.results?.[0]?.migrationName).toBe("0066_subscription_auto_renewal");
  await migrateToLatest(db);
});
it("due-time creation is atomic, concurrent/repeated ticks create one record, and reports update automatically", async () => {
  const t=await fixture();
  expect((await getSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId))).toMatchObject({enabled:true,nextRenewalAt:d("2026-09-02").toISOString(),cashPaidCny:"199.00000000"});
  expect(await renewDueSubscription(db,t.enterpriseId,t.resourceId,new Date(d("2026-09-02").getTime()-1))).toBe(false);
  const outcomes=await Promise.all([renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-02")),renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-02"))]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(await renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-02"))).toBe(false);
  const events=await db.selectFrom("provider_finance_event").selectAll().where("enterprise_id","=",t.enterpriseId).where("source","=","SYSTEM_RENEWAL").execute();
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({cash_paid_cny:"199.00000000",created_by_admin_user_id:null,occurred_at:d("2026-09-02")});
  const period=await db.selectFrom("provider_subscription_period").selectAll().where("finance_event_id","=",events[0]!.id).executeTakeFirstOrThrow();
  expect(period).toMatchObject({period_start:d("2026-09-02"),period_end_exclusive:d("2026-09-03"),source:"RENEWAL"});
  const manualDuplicate=await new ProviderFinanceRepository(db).recordSubscription({...t.input,kind:"RENEWAL",occurredAt:d("2026-09-02"),periodStart:d("2026-09-02"),periodEndExclusive:d("2026-09-03"),idempotencyKey:randomUUID()});
  expect(manualDuplicate.event).toMatchObject({id:events[0]!.id,replayed:true,source:"SYSTEM_RENEWAL"});
  const report=await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",d("2026-09-03"));
  expect(report.payments.find(row=>row.id===events[0]!.id)).toMatchObject({source:"SYSTEM_RENEWAL",eventType:"CODING_PLAN_RENEWAL",cashPaidCny:"199.00000000"});
});
it("cancellation keeps existing periods and money, blocks later renewal and is not undone by replay", async () => {
  const t=await fixture(); const finance=new ProviderFinanceRepository(db);
  const before=await db.selectFrom("provider_subscription_period").selectAll().where("enterprise_id","=",t.enterpriseId).execute();
  await cancelSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId,t.adminId);
  await cancelSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId,t.adminId);
  await finance.recordSubscription(t.input);
  expect(await renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-05"))).toBe(false);
  expect((await getSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId)).enabled).toBe(false);
  expect(await db.selectFrom("provider_subscription_period").selectAll().where("enterprise_id","=",t.enterpriseId).execute()).toEqual(before);
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",t.enterpriseId).execute()).toHaveLength(1);
  expect(await db.selectFrom("operation_log").select("id").where("enterprise_id","=",t.enterpriseId).where("action","=","subscription.auto_renew.cancel").execute()).toHaveLength(1);
  const down=await createMigrator(db).migrateDown();expect(down.error).toBeDefined();
});
it("waiting worker sees a committed cancellation before creating any renewal", async () => {
  const t=await fixture(); let pending: Promise<boolean> | undefined;
  await db.transaction().execute(async trx => {
    await trx.selectFrom("provider_resource").select("id").where("id","=",t.resourceId).forUpdate().execute();
    pending=renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-02"));
    await trx.updateTable("provider_resource").set({subscription_auto_renew_enabled:false}).where("id","=",t.resourceId).execute();
  });
  expect(await pending).toBe(false);
});
it("scheduled catch-up persists missed periods, skips cancelled resources and never bypasses closed months", async () => {
  const t=await fixture(); const cancelled=await fixture(); await cancelSubscriptionAutoRenewal(db,cancelled.enterpriseId,cancelled.resourceId,cancelled.adminId);
  await runSubscriptionAutoRenewals(db,d("2026-09-05"));
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",t.enterpriseId).where("source","=","SYSTEM_RENEWAL").execute()).toHaveLength(4);
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",cancelled.enterpriseId).where("source","=","SYSTEM_RENEWAL").execute()).toHaveLength(0);
  await runSubscriptionAutoRenewals(db,d("2026-09-05"));
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",t.enterpriseId).where("source","=","SYSTEM_RENEWAL").execute()).toHaveLength(4);
  const closed=await fixture();
  await db.insertInto("operating_bill_period").values({enterprise_id:closed.enterpriseId,period_month:"2026-09-01",status:"CLOSED"}).execute();
  await expect(renewDueSubscription(db,closed.enterpriseId,closed.resourceId,d("2026-09-02"))).rejects.toThrow();
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",closed.enterpriseId).where("source","=","SYSTEM_RENEWAL").execute()).toHaveLength(0);
});
it("another tenant cannot cancel, and inactive finance contracts prevent scheduled writes", async () => {
  const t=await fixture(false), other=await fixture();
  await expect(cancelSubscriptionAutoRenewal(db,other.enterpriseId,t.resourceId,other.adminId)).rejects.toThrow("不存在");
  expect(await renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-02"))).toBe(false);
});

it("existing migrated subscriptions inherit their registered period and price by default", async () => {
  const t=await createAnalysisFixture(db);const resourceId=t.resources.get("zhipu")!;
  await sql`INSERT INTO provider_finance_runtime_state (enterprise_id,strict_writes_enabled,activated_at,activated_by_admin_user_id,updated_at)
    VALUES (${t.enterpriseId}::uuid,true,now(),${t.adminId}::uuid,now())`.execute(db);
  const snapshot=await db.insertInto("provider_resource_operating_snapshot").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,version:1,source:"ADMIN",collected_at:d("2026-09-01"),currency:"CNY",package_cost:"199",effective_from:d("2026-09-01"),effective_until:d("2026-09-02")}).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("provider_subscription_period").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,finance_event_id:null,product_name:"智谱已登记套餐",period_start:d("2026-09-01"),period_end_exclusive:d("2026-09-02"),source:"MIGRATED_CARRYOVER",migration_source_record_id:snapshot.id,created_by_admin_user_id:t.adminId}).execute();
  expect(await getSubscriptionAutoRenewal(db,t.enterpriseId,resourceId)).toMatchObject({enabled:true,amount:"199.00000000",cashPaidCny:"199.00000000"});
  expect(await renewDueSubscription(db,t.enterpriseId,resourceId,d("2026-09-02"))).toBe(true);
  expect((await getSubscriptionAutoRenewal(db,t.enterpriseId,resourceId)).nextRenewalAt).toBe(d("2026-09-03").toISOString());
});
it("a newly registered subscription re-enables continuation, while old request replay cannot", async () => {
  const t=await fixture();await cancelSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId,t.adminId);
  const repo=new ProviderFinanceRepository(db);
  await repo.recordSubscription({...t.input,kind:"RENEWAL",occurredAt:d("2026-09-02"),periodStart:d("2026-09-02"),periodEndExclusive:d("2026-09-03"),idempotencyKey:randomUUID()});
  expect((await getSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId)).enabled).toBe(true);
  expect(await renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-03"))).toBe(true);
});

it("August registered Kimi and Zhipu fees appear in history, August totals and procurement without September duplicates", async () => {
  const t=await createAnalysisFixture(db);const repo=new ProviderFinanceRepository(db);
  await sql`INSERT INTO provider_finance_runtime_state (enterprise_id,strict_writes_enabled,activated_at,activated_by_admin_user_id,updated_at)
    VALUES (${t.enterpriseId}::uuid,true,now(),${t.adminId}::uuid,now())`.execute(db);
  for (const [code,amount] of [["kimi","199"],["zhipu","99"]]) {
    const resourceId=t.resources.get(code!)!;
    const snapshot=await db.insertInto("provider_resource_operating_snapshot").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,version:1,source:"ADMIN",collected_at:d("2026-08-19"),currency:"CNY",package_cost:amount!,effective_from:d("2026-08-19"),effective_until:d("2026-09-19")}).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("provider_subscription_period").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,finance_event_id:null,product_name:code!,period_start:d("2026-08-19"),period_end_exclusive:d("2026-09-19"),source:"MIGRATED_CARRYOVER",migration_source_record_id:snapshot.id,created_by_admin_user_id:t.adminId}).execute();
    const history=await repo.listFinanceEvents(t.enterpriseId,resourceId,{from:d("2026-08-01"),to:d("2026-09-01"),limit:100,offset:0});
    expect(history?.items).toEqual([expect.objectContaining({accountAmount:`${amount}.00000000`,source:"HISTORICAL_REGISTRATION"})]);
  }
  expect(await repo.getMonthlyFinanceSummary(t.enterpriseId,"2026-08")).toMatchObject({codingPlanFixedCostCny:"298.00000000",cashOutflowCny:"298.00000000"});
  const overview=await new OperatingBillRepository(db,"ACTIVE").getBill(t.enterpriseId,"2026-08");
  expect(overview.summary).toMatchObject({packageCost:"298.00000000",packageCosts:[{currency:"CNY",amount:"298.00000000"}]});
  expect(overview.providers.find((row)=>row.providerCode==="kimi")).toMatchObject({packageCost:"199.00000000"});
  expect(overview.providers.find((row)=>row.providerCode==="zhipu")).toMatchObject({packageCost:"99.00000000"});
  const september=await new OperatingBillRepository(db,"ACTIVE").getBill(t.enterpriseId,"2026-09");
  expect(september.summary.packageCost).toBe("0.00000000");
  expect(await repo.getMonthlyFinanceSummary(t.enterpriseId,"2026-09")).toMatchObject({codingPlanFixedCostCny:"0.00000000"});
  const report=await loadOperatingAnalysis(db,t.enterpriseId,"2026-08",d("2026-09-01"));
  expect(report.payments.filter((p)=>p.id.startsWith("registered:"))).toHaveLength(2);
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",t.enterpriseId).execute()).toHaveLength(0);
});
it("new other-provider plan persists opt-out, then opt-in runs scheduler, history and procurement once, cancellation stops it", async () => {
  const t=await fixture();const repo=new ProviderFinanceRepository(db);
  const provider=await db.selectFrom("provider_resource").select("provider_id").where("id","=",t.resourceId).executeTakeFirstOrThrow();
  await db.updateTable("provider").set({code:"another-plan"}).where("id","=",provider.provider_id).execute();
  const input={...t.input,autoRenew:false,occurredAt:d("2026-09-02"),periodStart:d("2026-09-02"),periodEndExclusive:d("2026-09-03"),idempotencyKey:randomUUID()};
  await repo.recordSubscription(input);await runSubscriptionAutoRenewals(db,d("2026-09-03"));
  expect((await getSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId)).enabled).toBe(false);
  const enabled={...input,autoRenew:true,occurredAt:d("2026-09-03"),periodStart:d("2026-09-03"),periodEndExclusive:d("2026-09-04"),idempotencyKey:randomUUID()};
  await repo.recordSubscription(enabled);
  await runSubscriptionAutoRenewals(db,d("2026-09-04"));await runSubscriptionAutoRenewals(db,d("2026-09-04"));
  const history=await repo.listFinanceEvents(t.enterpriseId,t.resourceId,{limit:100,offset:0});
  expect(history?.items.filter((p)=>p.source==="SYSTEM_RENEWAL")).toHaveLength(1);
  const report=await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",d("2026-09-05"));
  expect(report.payments.filter((p)=>p.source==="SYSTEM_RENEWAL")).toHaveLength(1);
  await cancelSubscriptionAutoRenewal(db,t.enterpriseId,t.resourceId,t.adminId);await repo.recordSubscription(enabled);
  expect(await renewDueSubscription(db,t.enterpriseId,t.resourceId,d("2026-09-05"))).toBe(false);
});
