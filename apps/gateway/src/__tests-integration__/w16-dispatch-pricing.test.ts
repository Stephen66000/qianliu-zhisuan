import { it, expect } from "vitest";
import { StubUpstream } from "@qianliu/provider-adapters";
import { DispatchPolicyRepository } from "@qianliu/database";
import { db, resDsA, resDsB, stub, ledgerRepo, dispatchRepo, ENT_ID, authHeader, buildApp, setStub } from "./w16-dispatch-fixture.js";

it("正式数据库倍率解析驱动拒绝、逐次 6.60 元结算及不可变快照", async () => {
  await db.updateTable("dispatch_policy").set({ status: "RETIRED" }).where("enterprise_id", "=", ENT_ID).execute();
  await db.updateTable("billing_rule").set({ enabled: false }).where("enterprise_id", "=", ENT_ID).where("provider_resource_id", "=", resDsA).execute();
  const rule = await ledgerRepo.createBillingRule({ enterprise_id: ENT_ID, provider_resource_id: resDsA,
    upstream_model: "deepseek-chat", rule_type: "API_PRICE", rule_version: "real-multiplier", pricing_mode: "MULTIPLIER",
    effective_from: new Date(0), cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004",
    multiplier: "3", time_windows: [
      { timezone: "Asia/Shanghai", days_of_week: null, start_time: "00:00", end_time: "12:00" },
      { timezone: "Asia/Shanghai", days_of_week: null, start_time: "12:00", end_time: "00:00" },
    ] });
  const id = await dispatchRepo.createPolicy({ enterpriseId: ENT_ID, status: "PUBLISHED", matchUnifiedModel: "qianliu-deepseek",
    matchResourceMode: "API", matchProviderResourceId: resDsA, matchTimezone: null, matchDaysOfWeek: null,
    matchStartTime: null, matchEndTime: null, matchPriceMultiplierMin: "3", matchRemainingQuotaRatioMax: null,
    matchForecastExhaustRisk: null, matchPrincipalScope: null, action: "REJECT", switchEquivalentGroup: [],
    rateLimitPerMinute: null, policyVersion: "real-multiplier-reject", priority: 1 });
  setStub(new StubUpstream({ default: { kind: "SUCCESS", usage: { input: 1000000, output: 100000, cache: 200000 } }, providerCode: "deepseek" }));
  const app = await buildApp();
  try {
    const rejected = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "test" }] } });
    expect(rejected.statusCode).toBe(403); expect(stub.calls).toHaveLength(0);
    await dispatchRepo.transitionStatus(ENT_ID, id, "PUBLISHED", "RETIRED");
    const success = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "test" }] } });
    expect(success.statusCode).toBe(200);
    const requestId = String(success.headers["x-request-id"]);
    const lines = await ledgerRepo.listLedgerLines(requestId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ raw_input_tokens: "1000000", raw_output_tokens: "100000", raw_cache_tokens: "200000",
      api_cost: "6.60000000", multiplier: "3", billing_rule_snapshot: { pricingMode: "MULTIPLIER", baseRuleId: rule.id, effectiveMultiplier: "3" } });
    await db.updateTable("billing_rule").set({ enabled: false }).where("id", "=", rule.id).execute();
    expect((await ledgerRepo.listLedgerLines(requestId))[0]!.api_cost).toBe("6.60000000");
  } finally { await app.close(); }
});

it.each(["SWITCH", "REJECT"] as const)("调用前策略变为 %s：重选或拒绝并冻结零消费证据", async (action) => {
  await db.updateTable("dispatch_policy").set({ status: "RETIRED" }).where("enterprise_id", "=", ENT_ID).execute();
  await db.updateTable("billing_rule").set({ enabled: false }).where("enterprise_id", "=", ENT_ID).where("provider_resource_id", "=", resDsA).execute();
  await ledgerRepo.createBillingRule({ enterprise_id: ENT_ID, provider_resource_id: resDsA, upstream_model: "deepseek-chat",
    rule_type: "API_PRICE", rule_version: `late-${action}`, effective_from: new Date(0),
    cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004" });
  class LatePolicyRepository extends DispatchPolicyRepository {
    override async createDecisionIfAbsent(input: Parameters<DispatchPolicyRepository["createDecisionIfAbsent"]>[0]) {
      const id = await super.createDecisionIfAbsent(input);
      await this.createPolicy({ enterpriseId: ENT_ID, status: "PUBLISHED", matchUnifiedModel: "qianliu-deepseek",
        matchResourceMode: "API", matchProviderResourceId: resDsA, matchTimezone: null, matchDaysOfWeek: null,
        matchStartTime: null, matchEndTime: null, matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null,
        matchForecastExhaustRisk: null, matchPrincipalScope: null, action, switchEquivalentGroup: [resDsA, resDsB],
        rateLimitPerMinute: null, policyVersion: `late-${action}`, priority: 1 });
      return id;
    }
  }
  setStub(new StubUpstream({ default: { kind: "SUCCESS", usage: { input: 100, output: 20, cache: 10 } }, providerCode: "deepseek" }));
  const app = await buildApp(undefined, undefined, new LatePolicyRepository(db));
  try {
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "test" }] } });
    expect(response.statusCode).toBe(action === "SWITCH" ? 200 : 403);
    const requestId = String(response.headers["x-request-id"]);
    const attempts = await db.selectFrom("upstream_attempt").selectAll().where("ai_request_id", "=", requestId).orderBy("attempt_no").execute();
    expect(attempts[0]!.dispatch_check).toMatchObject({ action, policyVersion: `late-${action}` });
    expect(attempts).toHaveLength(action === "SWITCH" ? 2 : 1);
    expect(stub.calls).toHaveLength(action === "SWITCH" ? 1 : 0);
    const lines = await ledgerRepo.listLedgerLines(requestId);
    expect(lines.find((line) => line.provider_resource_id === resDsA)).toMatchObject({ api_cost: "0.00000000", api_cost_status: "CONFIRMED_ZERO_NO_UPSTREAM" });
  } finally { await app.close(); }
});
