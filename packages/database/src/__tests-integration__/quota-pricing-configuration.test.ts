import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createKysely, migrateToLatest, savePricingConfiguration, archiveDispatchPolicy,
  DispatchPolicyRepository, GatewayLedgerRepository, AdminWriteRepository } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { PricingConfigurationInput } from "../repositories/quota-pricing-configuration.js";

let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>;
const enterpriseId = randomUUID(); const adminId = randomUUID(); let providerId: string;
beforeAll(async () => {
  pg = await startPostgresContainer("quota_pricing_test"); db = createKysely(pg.connectionString); await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "计价测试" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId, username: "pricing-test", password_hash: "test-only" }).execute();
  providerId = (await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek" }).returning("id").executeTakeFirstOrThrow()).id;
}, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); });

async function fixture(validated = true) {
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: providerId, name: randomUUID(), mode: "API", credential_type: "API_KEY" }).returningAll().executeTakeFirstOrThrow();
  const model = await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias: randomUUID(), display_name: "测试模型", status: "PENDING_CONFIG" }).returningAll().executeTakeFirstOrThrow();
  const route = await db.insertInto("model_route").values({ enterprise_id: enterpriseId, unified_model_id: model.id, provider_resource_id: resource.id, upstream_model: "flash", enabled: false }).returningAll().executeTakeFirstOrThrow();
  if (validated) await db.insertInto("provider_model_validation").values({ enterprise_id: enterpriseId, provider_resource_id: resource.id,
    unified_model_id: model.id, upstream_model: "flash", idempotency_key: randomUUID(), request_fingerprint: randomUUID(),
    status: "SUCCEEDED", result: {}, started_at: new Date(), finished_at: new Date() }).execute();
  const input: PricingConfigurationInput = { enterpriseId, adminId, routeId: route.id, expectedRouteVersion: 1,
    expectedModelVersion: 1, priority: 80, weight: 2, submissionId: randomUUID(), requestHash: randomUUID(), sourceRuleIds: [],
    rules: [{ rule_type: "API_PRICE", rule_version: "base", provider_resource_id: resource.id, upstream_model: "flash",
      effective_from: new Date("2026-09-01T00:00:00Z"), pricing_mode: "MULTIPLIER", multiplier: "1",
      cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004", currency: "CNY" }] };
  return { resource, model, route, input };
}

it("activates pending model and route with an atomic price set; replay is exactly once", async () => {
  const { input, route, model } = await fixture();
  const results = await Promise.all([savePricingConfiguration(db, input), savePricingConfiguration(db, input)]);
  expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.ruleIds).toEqual(results[1]!.ruleIds);
  expect(await db.selectFrom("model_route").select(["enabled", "priority", "weight"]).where("id", "=", route.id).executeTakeFirst()).toEqual({ enabled: true, priority: 80, weight: 2 });
  expect((await db.selectFrom("unified_model").select("status").where("id", "=", model.id).executeTakeFirst())?.status).toBe("ACTIVE");
  await expect(savePricingConfiguration(db, { ...input, requestHash: "changed" })).rejects.toThrow("内容已变化");
});
it("unvalidated routes and stale versions cannot activate", async () => {
  const { input } = await fixture(false);
  await expect(savePricingConfiguration(db, input)).rejects.toThrow("真实模型验证");
  await expect(savePricingConfiguration(db, { ...input, expectedRouteVersion: 9 })).rejects.toThrow("路由已变化");
  const valid = await fixture();
  valid.input.rules[0]!.cache_hit_price = null;
  await expect(savePricingConfiguration(db, valid.input)).rejects.toThrow("明确填写三项");
});
it("a later invalid rule rolls back earlier inserts and activation", async () => {
  const { input, route } = await fixture();
  input.rules.push({ ...input.rules[0]!, rule_version: "bad", upstream_model: "wrong", priority: 10 });
  await expect(savePricingConfiguration(db, input)).rejects.toThrow("不一致");
  expect(await db.selectFrom("billing_rule").select("id").where("provider_resource_id", "=", input.rules[0]!.provider_resource_id!).execute()).toEqual([]);
  expect((await db.selectFrom("model_route").select("enabled").where("id", "=", route.id).executeTakeFirst())?.enabled).toBe(false);
});
it("same provider copies work, cross-provider and cross-mode sources are rejected", async () => {
  const first = await fixture(); const source = await savePricingConfiguration(db, first.input);
  const target = await fixture(); target.input.sourceRuleIds = source.ruleIds;
  await savePricingConfiguration(db, target.input);
  const other = await fixture();
  const kimi = await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "kimi", name: "Kimi", adapter_type: "kimi" }).returning("id").executeTakeFirstOrThrow();
  await db.updateTable("provider_resource").set({ provider_id: kimi.id }).where("id", "=", other.resource.id).execute();
  await expect(savePricingConfiguration(db, { ...other.input, sourceRuleIds: source.ruleIds })).rejects.toThrow("同厂商");
});
it("mode conflicts cannot be reintroduced by legacy create or enable; version replacement preserves old rule identity", async () => {
  const { input } = await fixture(); const repo = new GatewayLedgerRepository(db);
  const absolute = await repo.createBillingRule({ ...input.rules[0]!, enterprise_id: enterpriseId, pricing_mode: "ABSOLUTE", multiplier: null, rule_version: "old", effective_from: new Date(0) });
  await expect(savePricingConfiguration(db, input)).rejects.toThrow("不能混用");
  const result = await savePricingConfiguration(db, { ...input, replaceExisting: true });
  expect(result.ruleIds).toHaveLength(1);
  await expect(repo.createBillingRule({ ...input.rules[0]!, enterprise_id: enterpriseId, pricing_mode: "ABSOLUTE", rule_version: "bypass", multiplier: null })).rejects.toThrow("pricing_mode_conflict");
  const old = await db.selectFrom("billing_rule").selectAll().where("id", "=", absolute.id).executeTakeFirstOrThrow();
  expect(old.effective_to).toEqual(input.rules[0]!.effective_from);
  expect(await new AdminWriteRepository(db).updateBillingRule(enterpriseId, old.id, old.version, { effective_to: null, enabled: true })).toBeUndefined();
});
it("archive is tenant/version checked, retired-only, and keeps policy history", async () => {
  const repo = new DispatchPolicyRepository(db);
  const id = await repo.createPolicy({ enterpriseId, status: "RETIRED", matchUnifiedModel: null,
    matchResourceMode: null, matchProviderResourceId: null, matchTimezone: null, matchDaysOfWeek: null,
    matchStartTime: null, matchEndTime: null, matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null,
    matchForecastExhaustRisk: null, matchPrincipalScope: null, action: "ALLOW", switchEquivalentGroup: [],
    rateLimitPerMinute: null, policyVersion: "v1" });
  expect(await archiveDispatchPolicy(db, randomUUID(), id, adminId, 1)).toBe(false);
  expect(await archiveDispatchPolicy(db, enterpriseId, id, adminId, 8)).toBe(false);
  expect(await archiveDispatchPolicy(db, enterpriseId, id, adminId, 1)).toBe(true);
  expect(await archiveDispatchPolicy(db, enterpriseId, id, adminId, 1)).toBe(false);
  expect(await repo.getPolicy(enterpriseId, id)).toMatchObject({ status: "RETIRED", archivedAt: expect.any(Date), version: 2 });
  expect((await repo.copyPolicyAsDraft(enterpriseId, id, adminId))?.archivedAt).toBeNull();
});
