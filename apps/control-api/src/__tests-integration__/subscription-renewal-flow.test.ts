import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, migrateToLatest, runSubscriptionAutoRenewals } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";
let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>; let app: FastifyInstance;
beforeAll(async () => {
  pg=await startPostgresContainer();db=createKysely(pg.connectionString);await migrateToLatest(db);
  const { buildControlApi }=await import("../server.js");app=buildControlApi(db);await app.ready();
},120000);
afterAll(async () => {await app?.close();await db?.destroy();await pg?.stop();});

it("API registration opt-in reaches scheduled renewal, history and procurement, then cancellation stops future entries", async () => {
  const tenant=randomUUID(), admin=randomUUID(), provider=randomUUID(), resource=randomUUID();
  await db.insertInto("enterprise").values({id:tenant,name:"Full renewal flow"}).execute();
  await db.insertInto("admin_user").values({id:admin,enterprise_id:tenant,username:admin,password_hash:await hashPassword("Renewal-flow-test!"),status:"ACTIVE"}).execute();
  await db.insertInto("provider").values({id:provider,enterprise_id:tenant,code:"other-plan",name:"Other Plan",adapter_type:"OPENAI_COMPATIBLE"}).execute();
  await db.insertInto("provider_resource").values({id:resource,enterprise_id:tenant,provider_id:provider,name:"Other",mode:"CODING_PLAN",credential_type:"SUBSCRIPTION_SESSION"}).execute();
  await sql`INSERT INTO provider_finance_runtime_state (enterprise_id,strict_writes_enabled,activated_at,activated_by_admin_user_id,updated_at)
    VALUES (${tenant}::uuid,true,now(),${admin}::uuid,now())`.execute(db);
  const login=await app.inject({method:"POST",url:"/auth/login",payload:{username:admin,password:"Renewal-flow-test!"}});
  expect(login.statusCode,login.body).toBe(200);
  const raw=login.headers["set-cookie"];const headers={cookie:(Array.isArray(raw)?raw[0]:raw)!.split(";")[0]!};
  const register=async (day:string,auto:boolean) => {
    const response=await app.inject({method:"POST",url:`/provider-resources/${resource}/finance/subscriptions`,headers,payload:{
      kind:"PURCHASE",product_name:"Other",auto_renew:auto,account_currency:"CNY",account_amount:"99",cash_paid_cny:"99",
      occurred_at:`${day}T00:00:00+08:00`,service_period_start:day,service_period_end:day,
      description:"一天测试周期",idempotency_key:randomUUID()}});
    expect(response.statusCode,response.body).toBe(201);
  };
  const status=async () => (await app.inject({method:"GET",url:`/provider-resources/${resource}/finance/auto-renewal`,headers})).json();
  await register("2026-09-01",false);
  expect(await status()).toMatchObject({enabled:false});
  await runSubscriptionAutoRenewals(db,new Date("2026-09-02T00:00:00+08:00"));
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",tenant).execute()).toHaveLength(1);
  await register("2026-09-02",true);expect(await status()).toMatchObject({enabled:true});
  await runSubscriptionAutoRenewals(db,new Date("2026-09-03T00:00:00+08:00"));
  await runSubscriptionAutoRenewals(db,new Date("2026-09-03T00:00:00+08:00"));
  const history=(await app.inject({method:"GET",url:`/provider-resources/${resource}/finance/events`,headers})).json();
  expect(history.items.filter((row:{source:string})=>row.source==="SYSTEM_RENEWAL")).toHaveLength(1);
  const summary=(await app.inject({method:"GET",url:"/provider-finance/summary?month=2026-09",headers})).json();
  expect(summary).toMatchObject({codingPlanFixedCostCny:"297.00000000",cashOutflowCny:"297.00000000"});
  const report=(await app.inject({method:"GET",url:"/operating-bills/2026-09/analysis",headers})).json();
  expect(report.payments.filter((row:{source:string})=>row.source==="SYSTEM_RENEWAL")).toHaveLength(1);
  const cancelled=await app.inject({method:"POST",url:`/provider-resources/${resource}/finance/auto-renewal/cancel`,headers,payload:{}});
  expect(cancelled.statusCode).toBe(200);expect(await status()).toMatchObject({enabled:false});
  await runSubscriptionAutoRenewals(db,new Date("2026-09-04T00:00:00+08:00"));
  expect(await db.selectFrom("provider_finance_event").select("id").where("enterprise_id","=",tenant).execute()).toHaveLength(3);
});
