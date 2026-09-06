import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { sql } from "kysely";
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

it.each(["model-version", "model-archived", "resource-unavailable", "provider-disabled"] as const)(
  "rejects changed configuration state: %s", async (kind) => {
    const f = await fixture();
    if (kind === "model-version") f.input.expectedModelVersion = 99;
    if (kind === "model-archived") await db.updateTable("unified_model").set({ archived_at: new Date(), status: "DISABLED" }).where("id", "=", f.model.id).execute();
    if (kind === "resource-unavailable") await db.updateTable("provider_resource").set({ status: "UNAVAILABLE" }).where("id", "=", f.resource.id).execute();
    if (kind === "provider-disabled") await db.updateTable("provider").set({ status: "DISABLED" }).where("id", "=", providerId).execute();
    try {
      await expect(savePricingConfiguration(db, f.input)).rejects.toThrow("模型或资源已变化");
      expect(await db.selectFrom("billing_rule").select("id").where("provider_resource_id", "=", f.resource.id).execute()).toEqual([]);
    } finally {
      if (kind === "provider-disabled") await db.updateTable("provider").set({ status: "ACTIVE" }).where("id", "=", providerId).execute();
    }
  });

it.each([[true, "ACTIVE", true], [true, "PENDING_CONFIG", false], [false, "ACTIVE", false]] as const)(
  "validation gate route=%s model=%s allowed=%s", async (enabled, status, allowed) => {
    const f = await fixture(false);
    await db.updateTable("model_route").set({ enabled }).where("id", "=", f.route.id).execute();
    await db.updateTable("unified_model").set({ status }).where("id", "=", f.model.id).execute();
    if (allowed) expect((await savePricingConfiguration(db, f.input)).ruleIds).toHaveLength(1);
    else await expect(savePricingConfiguration(db, f.input)).rejects.toThrow("真实模型验证");
  });

it("empty sets, undefined prices and mixed valid/invalid prices reject with their specific validation errors", async () => {
  const f = await fixture();
  await expect(savePricingConfiguration(db, { ...f.input, rules: [] })).rejects.toThrow("至少配置一条");
  const missing = { ...f.input.rules[0]!, rule_version: "missing", output_price: undefined, priority: 2 };
  await expect(savePricingConfiguration(db, { ...f.input, rules: [f.input.rules[0]!, missing] })).rejects.toThrow("明确填写三项");
  expect(await db.selectFrom("billing_rule").select("id").where("provider_resource_id", "=", f.resource.id).execute()).toEqual([]);
});

it.each(["same", "later"] as const)("replacement rejects an existing %s boundary without trimming earlier versions", async (kind) => {
  const f = await fixture(), repo = new GatewayLedgerRepository(db);
  const early = await repo.createBillingRule({ ...f.input.rules[0]!, enterprise_id: enterpriseId,
    rule_version: "early", priority: 1, effective_from: new Date(0) });
  const at = kind === "same" ? f.input.rules[0]!.effective_from : new Date("2026-10-01T00:00:00Z");
  const late = await repo.createBillingRule({ ...f.input.rules[0]!, enterprise_id: enterpriseId,
    rule_version: "late", priority: 2, effective_from: at });
  await expect(savePricingConfiguration(db, { ...f.input, replaceExisting: true })).rejects.toThrow("新版本生效时间必须晚于");
  const rows = await db.selectFrom("billing_rule").select("effective_to").where("id", "in", [early.id, late.id]).execute();
  expect(rows.every(row => row.effective_to === null)).toBe(true);
});

it.each(["resource", "type", "duplicate"] as const)("rejects mismatched rule %s before creating rows", async (kind) => {
  const f = await fixture();
  if (kind === "resource") f.input.rules[0]!.provider_resource_id = randomUUID();
  if (kind === "type") f.input.rules[0]!.rule_type = "MODEL_TIER";
  if (kind === "duplicate") {
    const saved = await new GatewayLedgerRepository(db).createBillingRule({ ...f.input.rules[0]!, enterprise_id: enterpriseId });
    await db.updateTable("billing_rule").set({ enabled: false }).where("id", "=", saved.id).execute();
  }
  await expect(savePricingConfiguration(db, f.input)).rejects.toThrow(kind === "duplicate" ? "版本已存在" : "不一致");
});

it.each(["MODEL_TIER", "TIME_WINDOW"])("Coding Plan accepts %s without API units and rejects an API rule", async ruleType => {
  const f = await fixture();
  await db.updateTable("provider_resource").set({ mode: "CODING_PLAN", status: "DEGRADED" }).where("id", "=", f.resource.id).execute();
  await expect(savePricingConfiguration(db, f.input)).rejects.toThrow("不一致");
  const planRule = { ...f.input.rules[0]!, rule_type: ruleType, pricing_mode: "ABSOLUTE" as const,
    time_windows: ruleType === "TIME_WINDOW" ? [{ timezone: "Asia/Shanghai", days_of_week: null, start_time: "09:00", end_time: "12:00" }] : undefined,
    multiplier: "2", cache_hit_price: null, cache_miss_price: null, output_price: null };
  const saved = await savePricingConfiguration(db, { ...f.input, rules: [planRule] });
  expect(saved.ruleIds).toHaveLength(1);
  expect(await db.selectFrom("billing_rule").select(["rule_type", "multiplier", "cache_hit_price", "source"])
    .where("id", "=", saved.ruleIds[0]!).executeTakeFirst()).toMatchObject({
      rule_type: ruleType, multiplier: "2", cache_hit_price: null, source: "WEB_ADMIN" });
});

it("copies a long provenance list safely and freezes exact before/after audit fields", async () => {
  const source = await fixture(), repo = new GatewayLedgerRepository(db);
  const sourceIds: string[] = [];
  for (let i = 0; i < 8; i++) sourceIds.push((await repo.createBillingRule({ ...source.input.rules[0]!,
    enterprise_id: enterpriseId, rule_version: `source-${i}`, priority: i })).id);
  const f = await fixture();
  const saved = await savePricingConfiguration(db, { ...f.input, sourceRuleIds: sourceIds });
  expect((await db.selectFrom("billing_rule").select("source").where("id", "=", saved.ruleIds[0]!)
    .executeTakeFirstOrThrow()).source).toBe(`WEB_ADMIN_COPY:${sourceIds.join(",")}`.slice(0, 255));
  const log = await db.selectFrom("operation_log").selectAll().where("target_id", "=", f.route.id).executeTakeFirstOrThrow();
  expect(log).toMatchObject({ action: "pricing_configuration.save", target_type: "model_route",
    result: "SUCCESS", change_summary: { source_rule_ids: sourceIds, replaced_rule_ids: [],
      before: { enabled: false, priority: f.route.priority, weight: f.route.weight, model_status: "PENDING_CONFIG" },
      after: { enabled: true, priority: 80, weight: 2, model_status: "ACTIVE" } } });
});

it("additive prices do not close prior versions; replacement audit names every replaced rule", async () => {
  const f = await fixture(), repo = new GatewayLedgerRepository(db);
  const old = await repo.createBillingRule({ ...f.input.rules[0]!, enterprise_id: enterpriseId,
    rule_version: "old-additive", priority: 1, effective_from: new Date(0) });
  const added = await savePricingConfiguration(db, { ...f.input, rules: [{ ...f.input.rules[0]!, priority: 2 }] });
  expect((await db.selectFrom("billing_rule").select("effective_to").where("id", "=", old.id).executeTakeFirstOrThrow()).effective_to).toBeNull();
  const boundary = new Date("2026-10-01T00:00:00Z");
  await savePricingConfiguration(db, { ...f.input, submissionId: randomUUID(), requestHash: "replacement",
    expectedModelVersion: 2, expectedRouteVersion: 2, replaceExisting: true,
    rules: [{ ...f.input.rules[0]!, rule_version: "replacement", effective_from: boundary }] });
  const audit = await db.selectFrom("operation_log").select("change_summary")
    .where("target_id", "=", f.route.id)
    .where(sql<string>`change_summary->>'request_hash'`, "=", "replacement").executeTakeFirstOrThrow();
  expect(audit.change_summary).toMatchObject({ request_hash: "replacement",
    replaced_rule_ids: expect.arrayContaining([old.id, added.ruleIds[0]]),
    before: { enabled: true, priority: 80, weight: 2, model_status: "ACTIVE" },
    after: { enabled: true, priority: 80, weight: 2, model_status: "ACTIVE" } });
  expect(await db.selectFrom("billing_rule").select("effective_to").where("id", "in", [old.id, added.ruleIds[0]!]).execute())
    .toEqual([{ effective_to: boundary }, { effective_to: boundary }]);
});
