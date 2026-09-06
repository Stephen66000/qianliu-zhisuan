import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createKysely, migrateToLatest, listPricingReadyRoutes, policyPricingReadiness } from "../index.js";
import { hasConflictingPricingMode } from "../repositories/pricing-write-guard.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => { pg = await startPostgresContainer("pricing_readiness_test"); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); });

async function fixture(mode: "API" | "CODING_PLAN" = "API") {
  const ent = randomUUID();
  await db.insertInto("enterprise").values({ id: ent, name: "isolated readiness" }).execute();
  const provider = await db.insertInto("provider").values({ enterprise_id: ent, code: "deepseek", name: "test", adapter_type: "deepseek" }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: ent, provider_id: provider.id, name: "test", mode, credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
  const model = await db.insertInto("unified_model").values({ enterprise_id: ent, alias: "ready-model", display_name: "test" }).returning("id").executeTakeFirstOrThrow();
  const route = await db.insertInto("model_route").values({ enterprise_id: ent, unified_model_id: model.id,
    provider_resource_id: resource.id, upstream_model: "ready-upstream", enabled: true }).returning("id").executeTakeFirstOrThrow();
  const rule = await db.insertInto("billing_rule").values({ enterprise_id: ent, provider_resource_id: resource.id,
    upstream_model: "ready-upstream", rule_type: mode === "API" ? "API_PRICE" : "MODEL_TIER", rule_version: "v1",
    effective_from: new Date(0), multiplier: mode === "API" ? null : "3",
    cache_hit_price: mode === "API" ? "0.000001" : null, cache_miss_price: mode === "API" ? "0.000002" : null,
    output_price: mode === "API" ? "0.000004" : null }).returning("id").executeTakeFirstOrThrow();
  const policy = { match_unified_model: "ready-model", match_provider_resource_id: resource.id,
    match_resource_mode: mode, switch_equivalent_group: [] as string[], match_price_multiplier_min: null as string | null };
  return { ent, provider: provider.id, resource: resource.id, model: model.id, route: route.id, rule: rule.id, policy };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

it.each(["API", "CODING_PLAN"] as const)("%s has structurally valid pricing, including non-current time windows", async (mode) => {
  const f = await fixture(mode);
  expect(await listPricingReadyRoutes(db, f.ent)).toEqual([{ id: f.route, alias: "ready-model",
    provider_resource_id: f.resource, mode, upstream_model: "ready-upstream" }]);
  expect(await policyPricingReadiness(db, f.ent, f.policy)).toBeNull();
  expect(await policyPricingReadiness(db, f.ent, { ...f.policy, match_unified_model: null,
    match_provider_resource_id: null, match_resource_mode: null, switch_equivalent_group: null })).toBeNull();
  await db.updateTable("billing_rule").set({ timezone: "Asia/Shanghai", start_time: "00:00", end_time: "00:01" }).where("id", "=", f.rule).execute();
  expect(await policyPricingReadiness(db, f.ent, f.policy)).toBeNull();
  expect(await db.transaction().execute((trx) => policyPricingReadiness(trx, f.ent, f.policy))).toBeNull();
});

const unavailable: Array<[string, (f: Fixture) => Promise<unknown>]> = [
  ["disabled provider", (f) => db.updateTable("provider").set({ status: "DISABLED" }).where("id", "=", f.provider).execute()],
  ["disabled model", (f) => db.updateTable("unified_model").set({ status: "DISABLED" }).where("id", "=", f.model).execute()],
  ["archived model", (f) => db.updateTable("unified_model").set({ archived_at: new Date() }).where("id", "=", f.model).execute()],
  ["disabled route", (f) => db.updateTable("model_route").set({ enabled: false }).where("id", "=", f.route).execute()],
  ["archived route", (f) => db.updateTable("model_route").set({ archived_at: new Date() }).where("id", "=", f.route).execute()],
  ["unavailable resource", (f) => db.updateTable("provider_resource").set({ status: "UNAVAILABLE" }).where("id", "=", f.resource).execute()],
  ["disabled price", (f) => db.updateTable("billing_rule").set({ enabled: false }).where("id", "=", f.rule).execute()],
  ["archived price", (f) => db.updateTable("billing_rule").set({ archived_at: new Date() }).where("id", "=", f.rule).execute()],
  ["future price", (f) => db.updateTable("billing_rule").set({ effective_from: new Date(Date.now() + 3600000) }).where("id", "=", f.rule).execute()],
  ["expired price", (f) => db.updateTable("billing_rule").set({ effective_to: new Date(1) }).where("id", "=", f.rule).execute()],
  ["different upstream", (f) => db.updateTable("billing_rule").set({ upstream_model: "wrong" }).where("id", "=", f.rule).execute()],
  ["empty API price", (f) => db.updateTable("billing_rule").set({ cache_hit_price: null, cache_miss_price: null, output_price: null }).where("id", "=", f.rule).execute()],
  ["package rule on API", (f) => db.updateTable("billing_rule").set({ rule_type: "MODEL_TIER", multiplier: "3" }).where("id", "=", f.rule).execute()],
];
it.each(unavailable)("excludes %s from readiness", async (_name, change) => {
  const f = await fixture(); await change(f);
  expect(await listPricingReadyRoutes(db, f.ent)).toEqual([]);
  expect(await policyPricingReadiness(db, f.ent, f.policy)).toContain("尚未完成");
});

it("isolates tenants and matching model/resource/mode conditions", async () => {
  const f = await fixture();
  expect(await listPricingReadyRoutes(db, randomUUID())).toEqual([]);
  for (const patch of [{ match_unified_model: "wrong" }, { match_provider_resource_id: randomUUID() }, { match_resource_mode: "CODING_PLAN" }]) {
    expect(await policyPricingReadiness(db, f.ent, { ...f.policy, ...patch })).toContain("尚未完成");
  }
  await db.updateTable("provider_resource").set({ status: "DEGRADED" }).where("id", "=", f.resource).execute();
  expect(await policyPricingReadiness(db, f.ent, f.policy)).toBeNull();
});

it("global/partial-scope prices remain compatible and a wrong resource is excluded", async () => {
  const f = await fixture();
  await db.updateTable("billing_rule").set({ provider_resource_id: null, upstream_model: null }).where("id", "=", f.rule).execute();
  expect(await listPricingReadyRoutes(db, f.ent)).toHaveLength(1);
  await db.updateTable("billing_rule").set({ provider_resource_id: f.resource }).where("id", "=", f.rule).execute();
  expect(await listPricingReadyRoutes(db, f.ent)).toHaveLength(1);
  const other = await db.insertInto("provider_resource").values({ enterprise_id: f.ent, provider_id: f.provider,
    name: "other", mode: "API", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
  await db.updateTable("billing_rule").set({ provider_resource_id: other.id }).where("id", "=", f.rule).execute();
  expect(await listPricingReadyRoutes(db, f.ent)).toEqual([]);
});

it("rejects unknown switch targets and accepts a ready matching target", async () => {
  const f = await fixture();
  expect(await policyPricingReadiness(db, f.ent, { ...f.policy, switch_equivalent_group: [randomUUID()] })).toContain("切换目标");
  expect(await policyPricingReadiness(db, f.ent, { ...f.policy, switch_equivalent_group: [f.resource] })).toBeNull();
  expect(await policyPricingReadiness(db, f.ent, { ...f.policy, match_unified_model: null, switch_equivalent_group: [f.resource] })).toBeNull();
});

it("API multiplier policies require explicit effective multiplier rules; packages use their own multiplier", async () => {
  const f = await fixture();
  const peakPolicy = { ...f.policy, match_price_multiplier_min: "3" };
  expect(await policyPricingReadiness(db, f.ent, peakPolicy)).toContain("绝对时段价格没有可核对倍率");
  const explicit = await db.insertInto("billing_rule").values({ enterprise_id: f.ent, provider_resource_id: f.resource,
    upstream_model: "ready-upstream", rule_type: "API_PRICE", rule_version: "peak", pricing_mode: "MULTIPLIER", multiplier: "3",
    cache_hit_price: "0", cache_miss_price: "0.000002", output_price: "0.000004", effective_from: new Date(0),
    effective_to: new Date(Date.now() + 3600000) }).returning("id").executeTakeFirstOrThrow();
  expect(await policyPricingReadiness(db, f.ent, peakPolicy)).toBeNull();
  for (const patch of [{ enabled: false }, { enabled: true, effective_from: new Date(Date.now() + 3600000), effective_to: null },
    { effective_from: new Date(0), effective_to: new Date(1) }]) {
    await db.updateTable("billing_rule").set(patch).where("id", "=", explicit.id).execute();
    expect(await policyPricingReadiness(db, f.ent, peakPolicy)).toContain("绝对时段价格没有可核对倍率");
  }
  await db.updateTable("billing_rule").set({ effective_to: null }).where("id", "=", explicit.id).execute();
  expect(await policyPricingReadiness(db, f.ent, peakPolicy)).toBeNull();
  const cp = await fixture("CODING_PLAN");
  expect(await policyPricingReadiness(db, cp.ent, { ...cp.policy, match_price_multiplier_min: "3" })).toBeNull();
  await db.updateTable("billing_rule").set({ multiplier: null }).where("id", "=", cp.rule).execute();
  expect(await listPricingReadyRoutes(db, cp.ent)).toEqual([]);
});

it("mode conflict guards honor scope, identity, period boundaries and non-API semantics", async () => {
  const f = await fixture();
  const incoming = { rule_type: "API_PRICE", pricing_mode: "MULTIPLIER", provider_resource_id: f.resource,
    upstream_model: "ready-upstream", effective_from: new Date(1000) };
  expect(await hasConflictingPricingMode(db, f.ent, incoming)).toBe(true);
  expect(await hasConflictingPricingMode(db, f.ent, { ...incoming, id: f.rule })).toBe(false);
  expect(await hasConflictingPricingMode(db, f.ent, { ...incoming, pricing_mode: undefined })).toBe(false);
  expect(await hasConflictingPricingMode(db, f.ent, { ...incoming, rule_type: "MODEL_TIER" })).toBe(false);
  expect(await hasConflictingPricingMode(db, f.ent, { ...incoming, upstream_model: "wrong" })).toBe(false);
  expect(await hasConflictingPricingMode(db, randomUUID(), incoming)).toBe(false);
  expect(await hasConflictingPricingMode(db, f.ent, { ...incoming, provider_resource_id: null, upstream_model: null })).toBe(true);
  expect(await hasConflictingPricingMode(db, f.ent, { ...incoming, effective_from: new Date(-1000), effective_to: new Date(0) })).toBe(false);
  await db.updateTable("billing_rule").set({ effective_to: new Date(1000) }).where("id", "=", f.rule).execute();
  expect(await hasConflictingPricingMode(db, f.ent, incoming)).toBe(false);
});
