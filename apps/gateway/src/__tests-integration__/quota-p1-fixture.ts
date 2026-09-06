import { randomUUID } from "node:crypto";
import type { Outcome } from "@qianliu/contracts";
import { type createKysely, GatewayLedgerRepository, ResourcePoolRepository, DispatchPolicyRepository, QuotaGateRepository } from "@qianliu/database";
import { generateApiKey, digestApiKey, apiKeyPrefix, StubUpstream } from "@qianliu/provider-adapters";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { buildGateway } from "../server.js";

type Db = ReturnType<typeof createKysely>;
export type Fault = "policy" | "operating" | "evidence" | "second-attempt";

export async function p1Fixture(db: Db, options: {
  mode?: "API" | "CODING_PLAN"; quota?: bigint; resources?: number; probe?: boolean;
} = {}) {
  const mode = options.mode ?? "CODING_PLAN";
  const enterpriseId = randomUUID(), principalId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "P1 isolated regression" }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId, name: "test", type: "EMPLOYEE" }).execute();
  const provider = await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "zhipu", name: "test", adapter_type: "zhipu" }).returning("id").executeTakeFirstOrThrow();
  const model = await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias: "p1-model", display_name: "test", status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow();
  const pepper = "p1-isolated-test-pepper-no-live-key";
  const key = generateApiKey();
  await db.insertInto("principal_key").values({ enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, pepper), status: "ACTIVE",
    allowed_model_ids: JSON.stringify([model.id]) as unknown as string[] }).execute();
  const grant = await db.insertInto("principal_grant").values({ enterprise_id: enterpriseId, principal_id: principalId,
    provider: "zhipu", model_alias: "p1-model", quota_value: options.quota ?? 1000000n }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  const ledger = new GatewayLedgerRepository(db);
  const candidates: RouteCandidateRow[] = [];
  for (let i = 0; i < (options.resources ?? 1); i++) {
    const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: provider.id,
      name: `resource-${i}`, mode, credential_type: "API_KEY", concurrency_limit: 1,
      status: options.probe ? "UNAVAILABLE" : "ACTIVE", cooldown_until: options.probe ? new Date(0) : null,
    }).returning("id").executeTakeFirstOrThrow();
    const route = await db.insertInto("model_route").values({ enterprise_id: enterpriseId, unified_model_id: model.id,
      provider_resource_id: resource.id, upstream_model: "glm-test", enabled: true, priority: 100 + i,
    }).returning("id").executeTakeFirstOrThrow();
    await ledger.createBillingRule({ enterprise_id: enterpriseId, provider_resource_id: resource.id, upstream_model: "glm-test",
      rule_type: mode === "API" ? "API_PRICE" : "MODEL_TIER", rule_version: "p1-test-v1", effective_from: new Date(0),
      multiplier: mode === "API" ? null : "3", cache_hit_price: mode === "API" ? "0.000001" : null,
      cache_miss_price: mode === "API" ? "0.000002" : null, output_price: mode === "API" ? "0.000004" : null });
    candidates.push({ resourceId: resource.id, routeId: route.id, providerCode: "zhipu", upstreamModel: "glm-test",
      priority: 100 + i, weight: 1, mode, status: options.probe ? "UNAVAILABLE" : "ACTIVE", probe: options.probe ?? false,
      principalId, concurrencyLimit: 1 });
  }
  return { enterpriseId, principalId, grantId: grant.id, key, pepper, candidates, ledger, mode };
}

export async function p1App(db: Db, f: Awaited<ReturnType<typeof p1Fixture>>, options: {
  fault?: Fault; outcome?: (outcome: Outcome, attemptNo: number) => Outcome;
  stub?: StubUpstream; maxAttempts?: number;
} = {}) {
  class Dispatch extends DispatchPolicyRepository {
    reads = 0; operatingReads = 0;
    override async listPublishedPolicies(ent: string) {
      this.reads++;
      if (this.reads === (options.fault === "second-attempt" ? 3 : 2)
        && (options.fault === "policy" || options.fault === "second-attempt")) throw new Error("P1_FINAL_POLICY_READ_FAULT");
      return super.listPublishedPolicies(ent);
    }
    override async resolveResourceOperatingInput(...args: Parameters<DispatchPolicyRepository["resolveResourceOperatingInput"]>) {
      if (++this.operatingReads === 2 && options.fault === "operating") throw new Error("P1_FINAL_OPERATING_READ_FAULT");
      return super.resolveResourceOperatingInput(...args);
    }
  }
  class Ledger extends GatewayLedgerRepository {
    override async updateAttemptResult(...args: Parameters<GatewayLedgerRepository["updateAttemptResult"]>) {
      if (options.fault === "evidence" && args[1].dispatch_check) throw new Error("P1_FINAL_EVIDENCE_WRITE_FAULT");
      return super.updateAttemptResult(...args);
    }
  }
  const dispatch = new Dispatch(db), ledger = new Ledger(db);
  const stub = options.stub ?? new StubUpstream({ providerCode: "zhipu", default: { kind: "SUCCESS", usage: { input: 10, output: 4, cache: 0 } } });
  const app = buildGateway(db, f.pepper, createRealPipeline({ db, ledgerRepo: ledger,
    poolRepo: new ResourcePoolRepository(db), quotaRepo: new QuotaGateRepository(db), dispatchRepo: dispatch,
    listCandidates: async () => f.candidates, maxAttempts: options.maxAttempts ?? 1,
    resolveDispatchInput: (ent, _pid, _model, id, _mode, at, upstream) => dispatch.resolveResourceOperatingInput(ent, id, at, upstream),
    caller: async (resource, request, attemptNo) => {
      const outcome = await stub.invoke(resource, request, attemptNo);
      return options.outcome ? options.outcome(outcome, attemptNo) : outcome;
    },
  }));
  await app.ready();
  const send = () => app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${f.key}`, "idempotency-key": "p1-replay" },
    payload: { model: "p1-model", messages: [{ role: "user", content: "isolated test" }] } });
  return { app, stub, send };
}

export async function p1Facts(db: Db, f: Awaited<ReturnType<typeof p1Fixture>>) {
  const request = await db.selectFrom("ai_request").selectAll().where("enterprise_id", "=", f.enterpriseId).executeTakeFirstOrThrow();
  const attempts = await db.selectFrom("upstream_attempt").selectAll().where("ai_request_id", "=", request.id).orderBy("attempt_no").execute();
  const lines = await f.ledger.listLedgerLines(request.id);
  const counter = await db.selectFrom("quota_counter").selectAll().where("grant_id", "=", f.grantId).executeTakeFirstOrThrow();
  const leases = await db.selectFrom("concurrency_lease").selectAll().where("ai_request_id", "=", request.id).execute();
  const transaction = await db.selectFrom("ledger_transaction").selectAll().where("ai_request_id", "=", request.id).executeTakeFirst();
  return { request, attempts, lines, counter, leases, transaction };
}
