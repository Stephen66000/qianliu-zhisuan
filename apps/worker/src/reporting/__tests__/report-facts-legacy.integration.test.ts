import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { readEmployeeReportFacts, reportQuotaCutoff } from "../report-facts.js";
let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>; let enterpriseId: string;
beforeAll(async () => {
  pg=await startPostgresContainer("report_a_legacy"); db=createKysely(pg.connectionString); await migrateToLatest(db);
  enterpriseId=(await db.insertInto("enterprise").values({name:"独立报表验收",timezone:"Asia/Shanghai"}).returning("id").executeTakeFirstOrThrow()).id;
  for (const type of ["EMPLOYEE","PROJECT"] as const) {
    const person=(await db.insertInto("person").values({enterprise_id:enterpriseId,name:type}).returning("id").executeTakeFirstOrThrow()).id;
    const principal=(await db.insertInto("principal").values({enterprise_id:enterpriseId,person_id:person,type,name:type}).returning("id").executeTakeFirstOrThrow()).id;
    const key=(await db.insertInto("principal_key").values({enterprise_id:enterpriseId,principal_id:principal,key_prefix:type,key_digest:randomUUID()}).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("principal_grant").values({enterprise_id:enterpriseId,principal_id:principal,provider:type==="EMPLOYEE"?"zhipu":"project-only",model_alias:"*",quota_value:2200000000n,created_at:new Date("2026-09-01T00:00:00Z"),updated_at:new Date("2026-09-01T00:00:00Z"),valid_from:new Date("2026-09-01T00:00:00Z")}).execute();
    for (const [model,tokens] of [["GLM 5.3 Flash",400n],["GLM 5.3",300n],["DeepSeek V3",200n],["K3",100n]] as const) {
      const id=randomUUID(),at=new Date("2026-10-15T12:00:00+08:00");
      await db.insertInto("ai_request").values({id,enterprise_id:enterpriseId,principal_id:principal,principal_key_id:key,protocol:"OPENAI_CHAT",unified_model:model,status:"SUCCEEDED",started_at:at,finished_at:at}).execute();
      await db.insertInto("ledger_transaction").values({enterprise_id:enterpriseId,ai_request_id:id,principal_id:principal,total_input_tokens:tokens,total_output_tokens:0n,total_deducted_quota:0n,total_api_cost:"0",api_cost_status:"NOT_APPLICABLE",usage_quality:"UPSTREAM_REPORTED",attempt_count:1,status:"SETTLED",created_at:at}).execute();
    }
  }
},120000);
afterAll(async()=>{await db?.destroy();await pg?.stop();},60000);
describe("standalone reporting on existing production schema",()=>{
  it("does not require or create monthly quota tables; employee totals and models share one scope",async()=>{
    const before=await sql`SELECT to_regclass('principal_quota_period') AS monthly`.execute(db);
    expect(before.rows[0]).toEqual({monthly:null});
    const facts=await readEmployeeReportFacts(db,{enterpriseId,period:"MONTH",timezone:"Asia/Shanghai",anchor:new Date("2026-10-15T12:00:00+08:00"),now:new Date("2026-11-02T01:00:00Z")});
    expect(facts.overview.metrics.realTokens).toBe("1000");expect(facts.overview.metrics.requestCount).toBe("4");
    expect(facts.models.totalModels).toBe(4);expect(facts.models.models.map(m=>m.model)).toEqual(["GLM 5.3 Flash","GLM 5.3","DeepSeek V3"]);
    expect(facts.models.models.reduce((n,m)=>n+m.tokens,0)).toBe(900);
    expect(facts.quota.rows.map(r=>r.provider)).toEqual(["zhipu"]);
    expect(facts.quota.statusLabel).toBe("历史余额待核账");expect(facts.quota.policyLabel).toBe("历史策略待核");
    expect(facts.snapshotMetadata).toMatchObject({scope:"EMPLOYEE",quotaPeriodKey:"2026-10",quotaAsOf:"2026-10-31T16:00:00.000Z"});
    expect((await sql`SELECT to_regclass('principal_quota_period') AS monthly`.execute(db)).rows).toEqual(before.rows);
  });
  it("uses the quota month containing the report final instant",()=>{
    expect(reportQuotaCutoff(new Date("2026-11-01T16:00:00Z"),"Asia/Shanghai")).toEqual({periodKey:"2026-11",asOfLabel:"截至11月1日"});
  });
});
