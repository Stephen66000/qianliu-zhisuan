import { GatewayLedgerRepository } from "../repositories/gateway-ledger-repository.js";
import { loadRequestSettlementFacts } from "../repositories/gateway-ledger-request-facts.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest } from "../index.js";
import { createGuardedLedgerTransactionIfAbsent } from "../repositories/gateway-ledger-guarded-writes.js";
import type { CreateLedgerTransactionInput } from "../repositories/gateway-ledger-types.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => { pg = await startPostgresContainer("compat_cost_status"); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60000);

async function input(): Promise<CreateLedgerTransactionInput> {
  const enterprise = await db.insertInto("enterprise").values({ name: "compat status" }).returning("id").executeTakeFirstOrThrow();
  const principal = await db.insertInto("principal").values({ enterprise_id: enterprise.id, type: "EMPLOYEE", name: "compat employee" }).returning("id").executeTakeFirstOrThrow();
  const key = await db.insertInto("principal_key").values({ enterprise_id: enterprise.id, principal_id: principal.id, key_prefix: "compat", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow();
  const request = randomUUID();
  await db.insertInto("ai_request").values({ id: request, enterprise_id: enterprise.id, principal_id: principal.id, principal_key_id: key.id, protocol: "OPENAI_CHAT", unified_model: "compat", status: "IN_PROGRESS" }).execute();
  return { ai_request_id: request, enterprise_id: enterprise.id, principal_id: principal.id, total_input_tokens: 100n, total_output_tokens: 20n, total_cache_tokens: 0n, total_deducted_quota: 0n, total_api_cost: null, usage_quality: "PROVIDER_REPORTED", attempt_count: 0 };
}

async function seedPricedAttempt(facts: CreateLedgerTransactionInput, ordinal: number, cost: string | null, currency: "CNY" | "USD" | null, status: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | null, raw = 100n) {
  const provider = await db.insertInto("provider").values({enterprise_id:facts.enterprise_id,code:`compat-${ordinal}`,name:"compat evidence",adapter_type:"OPENAI_COMPATIBLE"}).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({enterprise_id:facts.enterprise_id,provider_id:provider.id,name:"compat API",mode:"API",credential_type:"API_KEY"}).returning("id").executeTakeFirstOrThrow();
  const attempt = await db.insertInto("upstream_attempt").values({enterprise_id:facts.enterprise_id,ai_request_id:facts.ai_request_id,attempt_no:ordinal,provider_resource_id:resource.id,upstream_model:"compat",finished_at:new Date(),response_committed:raw>0n,http_status:raw>0n?200:403}).returning("id").executeTakeFirstOrThrow();
  const usage = {enterprise_id:facts.enterprise_id,ai_request_id:facts.ai_request_id,upstream_attempt_id:attempt.id,provider_resource_id:resource.id,input_tokens:raw,output_tokens:0n,cache_tokens:0n,usage_quality:raw>0n?"PROVIDER_REPORTED":"UNKNOWN",dedup_key:randomUUID()};
  const line = {enterprise_id:facts.enterprise_id,ai_request_id:facts.ai_request_id,upstream_attempt_id:attempt.id,provider_resource_id:resource.id,principal_id:facts.principal_id,resource_mode:"API",raw_input_tokens:raw,raw_output_tokens:0n,raw_cache_tokens:0n,deducted_quota:null,api_cost:cost,api_cost_currency:currency,api_cost_status:status,usage_quality:usage.usage_quality};
  return {usage,line};
}

describe("compatibility ledger transaction cost-status persistence", () => {
  it.each([
    ["PRICED_USAGE", "0.0015"], ["NOT_APPLICABLE", null], ["UNKNOWN_COST", null],
  ] as const)("persists explicit %s without repricing the amount", async (status, amount) => {
    const facts = { ...await input(), total_api_cost: amount, api_cost_status: status };
    const row = await createGuardedLedgerTransactionIfAbsent(db, facts);
    expect(row?.api_cost_status).toBe(status);
    expect(row?.total_api_cost === null ? null : Number(row!.total_api_cost)).toBe(amount === null ? null : Number(amount));
    expect(await createGuardedLedgerTransactionIfAbsent(db, facts)).toBeUndefined();
    expect((await db.selectFrom("ai_request").select("status").where("id", "=", facts.ai_request_id).executeTakeFirstOrThrow()).status).toBe("IN_PROGRESS");
  });
  it("keeps missing amount/status unknown instead of inventing confirmed zero", async () => {
    const facts = await input();
    const row = await createGuardedLedgerTransactionIfAbsent(db, facts);
    expect(row?.api_cost_status).toBe("UNKNOWN_COST"); expect(row?.total_api_cost).toBeNull();
  });
  it.each(["atomic", "legacy"] as const)("%s writer freezes the explicit API currency and status", async method => {
    const facts=await input();const prepared=await seedPricedAttempt(facts,1,"0.0015","USD","PRICED_USAGE");const repo=new GatewayLedgerRepository(db);
    const line=method==="atomic"?(await repo.createUsageAndLedgerLineIfAbsent({usage:prepared.usage,ledger_line:prepared.line})).line
      :await repo.createLedgerLine({...prepared.line,usage_event_id:(await repo.createUsageEventIfAbsent(prepared.usage))!.id});
    expect(line).toMatchObject({api_cost_currency:"USD",api_cost_status:"PRICED_USAGE",deducted_quota:null});
    expect(Number(line.api_cost)).toBe(0.0015);
    expect(await db.selectFrom("ledger_line").select(["api_cost_currency","api_cost_status"]).where("id","=",line.id).executeTakeFirstOrThrow()).toEqual({api_cost_currency:"USD",api_cost_status:"PRICED_USAGE"});
  });
  it.each(["legacy-positive-plus-no-upstream-zero", "priced-mixed-currencies"] as const)("compat fallback classifies the verified %s aggregate", async kind => {
    const facts=await input();const repo=new GatewayLedgerRepository(db);
    const descriptors=kind==="legacy-positive-plus-no-upstream-zero"
      ? [["0.0015","USD",null,100n],["0",null,"CONFIRMED_ZERO_NO_UPSTREAM",0n]] as const
      : [["0.0015","CNY","PRICED_USAGE",50n],["0.0025","USD","PRICED_USAGE",50n]] as const;
    for(const [index,descriptor] of descriptors.entries()) {
      const prepared=await seedPricedAttempt(facts,index+1,...descriptor);
      const usage=await repo.createUsageEventIfAbsent(prepared.usage);
      await repo.createLedgerLine({...prepared.line,usage_event_id:usage!.id});
    }
    const exact=await db.transaction().execute(async trx=>{
      await trx.selectFrom("ai_request").select("id").where("id","=",facts.ai_request_id).forUpdate().executeTakeFirstOrThrow();
      return loadRequestSettlementFacts(trx,facts.enterprise_id,facts.ai_request_id);
    });
    const amount=kind==="legacy-positive-plus-no-upstream-zero"?"0.00150000":null;
    const status=kind==="legacy-positive-plus-no-upstream-zero"?"PRICED_USAGE":"UNKNOWN_COST";
    expect(exact.totalApiCost).toBe(amount);
    await expect(createGuardedLedgerTransactionIfAbsent(db,{...facts,total_input_tokens:exact.totalInputTokens,total_output_tokens:exact.totalOutputTokens,total_cache_tokens:exact.totalCacheTokens,total_deducted_quota:exact.totalDeductedQuota,total_api_cost:exact.totalApiCost,attempt_count:exact.attemptCount}))
      .resolves.toMatchObject({api_cost_status:status,total_api_cost:amount});
  });

});
