import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, loadOperatingAnalysis, ProviderFinanceRepository, savePrincipalAccounting, OperatingBillAccountRepository, loadOperatingDepartmentAccounts } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createAnalysisFixture, seedAnalysisUsage } from "./fixtures/operating-analysis.js";
let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => { pg = await startPostgresContainer(); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); });
const now = new Date("2026-09-07T00:00:00Z");

it("three months of data use three as denominator; zero-consumption failed audit rows do not taint month quality", async () => {
  const t = await createAnalysisFixture(db);
  for (const [month, tokens] of [[7,100],[8,200],[9,300]] as const) await seedAnalysisUsage(t,t.a,"kimi",BigInt(tokens),new Date(`2026-${String(month).padStart(2,"0")}-02T00:00:00Z`));
  const failed = await seedAnalysisUsage(t,t.a,"kimi",0n,new Date("2026-08-03T00:00:00Z"),"0","UNKNOWN");
  await db.updateTable("ai_request").set({status:"FAILED"}).where("id","=",failed).execute();
  await db.updateTable("upstream_attempt").set({response_committed:false,http_status:400}).where("ai_request_id","=",failed).execute();
  const report = await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",now);
  expect(report.summary).toMatchObject({companyTokens:"300",ytdAverageTokens:"200.00",averageMonthCount:3});
  expect(report.months[7]).toMatchObject({totalTokens:"200",usageIncomplete:false});
  expect((await db.selectFrom("ledger_line").selectAll().where("ai_request_id","=",failed).execute())).toHaveLength(1);
  const consumed = await seedAnalysisUsage(t,t.a,"kimi",25n,new Date("2026-08-04T00:00:00Z"),"0","UNKNOWN");
  await db.updateTable("ai_request").set({status:"FAILED"}).where("id","=",consumed).execute();
  expect((await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",now)).months[7]).toMatchObject({totalTokens:"225",usageIncomplete:true});
});

it("confirmed resource renewals automatically appear once; legacy paid subscriptions are included without migration duplication", async () => {
  const t = await createAnalysisFixture(db);
  const resourceId = t.resources.get("kimi")!;
  const old = await db.insertInto("resource_purchase_record").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,purchase_type:"PACKAGE_PURCHASE",amount:"199",currency:"CNY",purchased_at:new Date("2026-08-10T00:00:00Z"),source:"ADMIN",created_by:t.adminId,description:"Kimi 八月实付"}).returning("id").executeTakeFirstOrThrow();
  const finance = new ProviderFinanceRepository(db);
  const input = {enterpriseId:t.enterpriseId,resourceId,adminId:t.adminId,kind:"RENEWAL" as const,productName:"Kimi 订阅",accountAmount:"199",accountCurrency:"CNY" as const,cashPaidCny:"199",occurredAt:new Date("2026-09-01T00:00:00Z"),periodStart:new Date("2026-08-31T16:00:00Z"),periodEndExclusive:new Date("2026-09-30T16:00:00Z"),idempotencyKey:randomUUID()};
  await finance.recordSubscription(input); await finance.recordSubscription(input);
  let report = await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",now);
  expect(report.payments.filter((p)=>p.eventType==="CODING_PLAN_RENEWAL")).toHaveLength(1);
  expect(report.payments.find((p)=>p.eventType==="CODING_PLAN_RENEWAL")).toMatchObject({cashPaidCny:"199.00000000",source:"ADMIN"});
  expect(report.purchases.find((p)=>p.providerCode==="kimi")).toMatchObject({yearCash:"398.00"});
  expect(report.purchases.some((p)=>p.providerCode==="zhipu")).toBe(true);
  await db.transaction().execute(async (trx) => {
    const event = await trx.insertInto("provider_finance_event").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,event_type:"CODING_PLAN_PURCHASE",account_amount:"199",account_currency:"CNY",cash_paid_cny:"199",occurred_at:new Date("2026-08-10T00:00:00Z"),external_reference:`legacy-purchase:${old.id}`,source:"MIGRATION",idempotency_key:randomUUID()}).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("provider_subscription_period").values({enterprise_id:t.enterpriseId,provider_resource_id:resourceId,finance_event_id:event.id,product_name:"Kimi 历史订阅",period_start:new Date("2026-08-09T16:00:00Z"),period_end_exclusive:new Date("2026-08-31T16:00:00Z"),source:"MIGRATED_PURCHASE",migration_source_record_id:old.id,created_by_admin_user_id:t.adminId}).execute();
  });
  report = await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",now);
  expect(report.purchases.find((p)=>p.providerCode==="kimi")).toMatchObject({yearCash:"398.00"});
});

it("saved project owner/department automatically classify missing historical usage without writing attribution snapshots", async () => {
  const t = await createAnalysisFixture(db);
  await seedAnalysisUsage(t,t.project,"kimi",20n,new Date("2026-09-02T00:00:00Z"));
  await savePrincipalAccounting(db,{enterpriseId:t.enterpriseId,principalId:t.a,adminId:t.adminId,departmentName:"研发部",expectedVersion:0});
  await savePrincipalAccounting(db,{enterpriseId:t.enterpriseId,principalId:t.project,adminId:t.adminId,ownerPrincipalId:t.a,expectedVersion:0});
  const owner = await db.selectFrom("principal").select("name").where("id","=",t.a).executeTakeFirstOrThrow();
  const before = await db.selectFrom("request_attribution_snapshot").selectAll().where("enterprise_id","=",t.enterpriseId).execute();
  const bill = await new OperatingBillAccountRepository(db).listAccounts(t.enterpriseId,"2026-09","PROJECT");
  const project = bill.rows.find((r)=>r.subjectId===t.project)!;
  expect(project.projectOwner?.personName).toBe(owner.name);
  expect(project.projectDepartments[0]?.departmentName).toBe("研发部");
  expect(project.totals.totalTokens).toBe("20");
  const departments = await loadOperatingDepartmentAccounts(db,t.enterpriseId,"2026-09");
  expect(departments.rows.find((row)=>row.subjectName==="研发部")?.totals.totalTokens).toBe("20");
  expect(departments.rows.some((row)=>row.isUnassigned)).toBe(false);
  expect(await db.selectFrom("request_attribution_snapshot").selectAll().where("enterprise_id","=",t.enterpriseId).execute()).toEqual(before);
});

it("automatic saved rules preserve known historical attribution and tenant boundaries", async () => {
  const t=await createAnalysisFixture(db);
  await savePrincipalAccounting(db,{enterpriseId:t.enterpriseId,principalId:t.a,adminId:t.adminId,departmentName:"研发部",expectedVersion:0});
  const historical=await db.insertInto("organization_unit").values({enterprise_id:t.enterpriseId,name:"历史部门"}).returning("id").executeTakeFirstOrThrow();
  const known=await seedAnalysisUsage(t,t.a,"kimi",10n,new Date("2026-09-02T00:00:00Z"));
  await seedAnalysisUsage(t,t.a,"kimi",20n,new Date("2026-09-03T00:00:00Z"));
  await seedAnalysisUsage(t,t.b,"kimi",30n,new Date("2026-09-04T00:00:00Z"));
  await db.insertInto("request_attribution_snapshot").values({enterprise_id:t.enterpriseId,ai_request_id:known,source_principal_id:t.a,organization_unit_id:historical.id,cost_category:"EMPLOYEE_DIRECT",attribution_source:"EMPLOYEE_MEMBERSHIP",request_occurred_at:new Date("2026-09-02T00:00:00Z"),version:1,snapshot_origin:"RUNTIME"}).execute();
  const other=await createAnalysisFixture(db);
  await savePrincipalAccounting(db,{enterpriseId:other.enterpriseId,principalId:other.a,adminId:other.adminId,departmentName:"其他企业部门",expectedVersion:0});
  await seedAnalysisUsage(other,other.a,"kimi",999n,new Date("2026-09-02T00:00:00Z"));
  const result=await loadOperatingDepartmentAccounts(db,t.enterpriseId,"2026-09");
  expect(result.totals.totalTokens).toBe("60");
  expect(result.rows.find(r=>r.subjectName==="历史部门")?.totals.totalTokens).toBe("10");
  expect(result.rows.find(r=>r.subjectName==="研发部")?.totals.totalTokens).toBe("20");
  expect(result.rows.find(r=>r.isUnassigned)?.totals.totalTokens).toBe("30");
  expect(await db.selectFrom("request_attribution_snapshot").select("id").where("enterprise_id","=",t.enterpriseId).execute()).toHaveLength(1);
});

it("system-synced paid subscription renewal automatically enters monthly procurement with its real source", async () => {
  const t=await createAnalysisFixture(db);
  const common={enterprise_id:t.enterpriseId,provider_resource_id:t.resources.get("zhipu")!,purchase_type:"PACKAGE_PURCHASE",currency:"CNY",source:"PROVIDER_SYNC",created_by:t.adminId};
  await db.insertInto("resource_purchase_record").values([
    {...common,amount:"199",purchased_at:new Date("2026-08-01T00:00:00Z"),service_period_start:"2026-08-01",service_period_end:"2026-08-31",evidence_ref:"confirmed-system-payment-august"},
    {...common,amount:"199",purchased_at:new Date("2026-09-01T00:00:00Z"),service_period_start:"2026-09-01",service_period_end:"2026-09-30",evidence_ref:"confirmed-system-payment-september"},
  ]).execute();
  const report=await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",now);
  expect(report.payments.filter(p=>p.providerName==="智谱")).toHaveLength(1);
  expect(report.payments.find(p=>p.providerName==="智谱")).toMatchObject({eventType:"CODING_PLAN_RENEWAL",source:"PROVIDER_SYNC",cashPaidCny:"199.00000000"});
  expect(report.purchases.find(p=>p.providerCode==="zhipu")?.yearCash).toBe("398.00");
  // Reading the report cannot invent a future payment from an expiring subscription.
  const future=await loadOperatingAnalysis(db,t.enterpriseId,"2026-10",new Date("2026-10-10T00:00:00Z"));
  expect(future.payments).toHaveLength(0);
});

it("historical foreign-currency purchases are not guessed as RMB or hidden from annual completeness", async () => {
  const t=await createAnalysisFixture(db);
  await db.insertInto("resource_purchase_record").values({enterprise_id:t.enterpriseId,provider_resource_id:t.resources.get("kimi")!,purchase_type:"PACKAGE_PURCHASE",amount:"20",currency:"USD",purchased_at:new Date("2025-11-01T00:00:00Z"),source:"ADMIN",created_by:t.adminId}).execute();
  const report=await loadOperatingAnalysis(db,t.enterpriseId,"2025-12",now);
  expect(report.purchases.find(p=>p.providerCode==="kimi")?.monthlyCash[10]).toBeNull();
  expect(report.purchases.find(p=>p.providerCode==="kimi")?.yearCash).toBeNull();
  expect(report.cashSummary.yearCash).toBeNull();
});

it("owner without a department is rejected without partially changing existing rules", async () => {
  const t=await createAnalysisFixture(db);
  const old=await db.insertInto("organization_unit").values({enterprise_id:t.enterpriseId,name:"旧项目部门"}).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("project_department_assignment").values({enterprise_id:t.enterpriseId,project_principal_id:t.project,organization_unit_id:old.id,valid_from:new Date("2026-07-01T00:00:00Z"),valid_until:null,source:"EXPLICIT",created_by:t.adminId}).execute();
  await expect(savePrincipalAccounting(db,{enterpriseId:t.enterpriseId,principalId:t.project,adminId:t.adminId,ownerPrincipalId:t.b,expectedVersion:0})).rejects.toThrow("补齐负责人的部门");
  await seedAnalysisUsage(t,t.project,"kimi",10n,new Date("2026-09-02T00:00:00Z"));
  const list=await new OperatingBillAccountRepository(db).listAccounts(t.enterpriseId,"2026-09","PROJECT");
  expect(list.rows.find(row=>row.subjectId===t.project)?.projectDepartments[0]?.departmentName).toBe("旧项目部门");
  expect(await db.selectFrom("principal_accounting_assignment").select("id").where("principal_id","=",t.project).execute()).toHaveLength(0);
  const departments=await loadOperatingDepartmentAccounts(db,t.enterpriseId,"2026-09");
  expect(departments.rows.find(row=>row.subjectName==="旧项目部门")?.totals.totalTokens).toBe("10");
});
