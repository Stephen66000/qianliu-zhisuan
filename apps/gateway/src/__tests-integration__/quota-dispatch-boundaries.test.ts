import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createKysely, DispatchPolicyRepository, GatewayLedgerRepository, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { p1Fixture, p1App, p1Facts } from "./quota-p1-fixture.js";
import * as preparation from "../pipeline/pipeline-attempt-preparation.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer("quota_dispatch_boundaries");
  db = createKysely(pg.connectionString); await migrateToLatest(db);
}, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); });

it.each([
  ["REJECT", 2, 403, 0], ["RATE_LIMIT", 2, 429, 0],
  ["SWITCH", 2, 200, 1], ["SWITCH", 1, 429, 0],
] as const)("套餐最终复核 %s，maxAttempts=%i，保留零消费并释放额度/探针", async (action, maxAttempts, status, calls) => {
  const f = await p1Fixture(db, { resources: 2, probe: true });
  const original = DispatchPolicyRepository.prototype.createDecisionIfAbsent;
  const originalPrepare = preparation.prepareSelectedAttempt;
  const steps: unknown[] = [];
  const satisfied: unknown[] = [];
  const prepareSpy = vi.spyOn(preparation, "prepareSelectedAttempt").mockImplementation(async (context, state) => {
    const result = await originalPrepare(context, state); steps.push(result);
    satisfied.push(state.dispatchSatisfiedSwitch && { ...state.dispatchSatisfiedSwitch }); return result;
  });
  let inserted = false;
  // Commit a real policy between the initial decision and the final pre-upstream check.
  // The existing decision write, all reads, accounting and policy algorithm stay real.
  const interleave = vi.spyOn(DispatchPolicyRepository.prototype, "createDecisionIfAbsent")
    .mockImplementation(async function (this: DispatchPolicyRepository, input) {
      const id = await original.call(this, input);
      if (!inserted) {
        inserted = true;
        await this.createPolicy({ enterpriseId: f.enterpriseId, status: "PUBLISHED", matchUnifiedModel: "p1-model",
          matchResourceMode: "CODING_PLAN", matchProviderResourceId: f.candidates[0]!.resourceId,
          matchTimezone: null, matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null,
          matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null, matchForecastExhaustRisk: null,
          matchPrincipalScope: null, action, switchEquivalentGroup: f.candidates.map(c => c.resourceId),
          rateLimitPerMinute: action === "RATE_LIMIT" ? 1 : null, policyVersion: "late-cp", priority: 1 });
      }
      return id;
    });
  const { app, send, stub } = await p1App(db, f, { maxAttempts });
  try {
    const response = await send();
    expect(response.statusCode).toBe(status);
    expect(inserted).toBe(true);
    expect(stub.calls).toHaveLength(calls);
    const facts = await p1Facts(db, f);
    expect(facts.request.status).toBe(calls ? "SUCCEEDED" : "FAILED");
    expect(facts.attempts).toHaveLength(calls ? 2 : 1);
    expect(steps[0]).toEqual({ kind: "STOP", result: calls ? "CONTINUE" : "RETURNED" });
    if (calls) expect(satisfied[0]).toEqual({ policyId: expect.any(String), policyVersion: "late-cp", targetId: f.candidates[1]!.resourceId });
    expect(facts.attempts[0]).toMatchObject({ http_status: calls ? 409 : status, response_committed: false,
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: calls ? "dispatch_reselected_before_upstream" : "dispatch_changed_before_upstream" });
    if (!calls) expect(response.json()).toMatchObject({ error: { type: "rate_limit_error",
      code: "dispatch_changed_before_upstream", retryable: true,
      message: "当前时段调度策略禁止此调用，请稍后重试", request_id: facts.request.id } });
    expect(facts.attempts[0]!.dispatch_check).toMatchObject({ action, policyVersion: "late-cp", priceMultiplier: "3" });
    expect(facts.lines.find(line => line.provider_resource_id === f.candidates[0]!.resourceId))
      .toMatchObject({ raw_input_tokens: "0", raw_output_tokens: "0" });
    expect(facts.counter.used_value).toBe(calls ? "42" : "0");
    expect(facts.transaction?.total_deducted_quota).toBe(calls ? "42" : "0");
    expect(facts.leases.every(lease => lease.released_at instanceof Date)).toBe(true);
    const probes = await db.selectFrom("provider_resource").select("last_probe_at")
      .where("enterprise_id", "=", f.enterpriseId).execute();
    expect(probes).toHaveLength(2);
    expect(probes.every(probe => probe.last_probe_at === null)).toBe(true);
  } finally { await app.close(); interleave.mockRestore(); prepareSpy.mockRestore(); }
});

it("允许超额时零可用额度仍只扣真实消耗，available的零边界不变成负数", async () => {
  const f = await p1Fixture(db, { quota: 0n });
  await db.updateTable("principal_grant").set({ allow_overage: true }).where("id", "=", f.grantId).execute();
  const { app, send } = await p1App(db, f);
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(facts.counter).toMatchObject({ used_value: "42", overage_value: "42" });
    expect(facts.transaction).toMatchObject({ total_deducted_quota: "42", overage: true });
    expect(facts.leases.every(lease => lease.released_at instanceof Date)).toBe(true);
  } finally { await app.close(); }
});

it("实际消耗恰好等于额度时不标记超额", async () => {
  const f = await p1Fixture(db, { quota: 42n });
  await db.updateTable("principal_grant").set({ allow_overage: true }).where("id", "=", f.grantId).execute();
  const { app, send } = await p1App(db, f);
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(facts.counter).toMatchObject({ used_value: "42", overage_value: "0" });
    expect(facts.transaction?.overage).toBe(false);
  } finally { await app.close(); }
});

it("重试累计超过额度时，前序实际扣减不能被当成可返还预占", async () => {
  const f = await p1Fixture(db, { quota: 600n, resources: 2 });
  const { app, send } = await p1App(db, f, { maxAttempts: 2, outcome: (outcome, n) => n === 1
    ? { ...outcome, committed: false, status: 502, error: "upstream_error" }
    : { ...outcome, usage: { ...outcome.usage, input: 200, output: 0 } } });
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(facts.counter).toMatchObject({ used_value: "642", overage_value: "42" });
    expect(facts.transaction).toMatchObject({ total_deducted_quota: "642", overage: true });
  } finally { await app.close(); }
});

it("跨厂商重试不能把前一个厂商的可返还预占用于新厂商额度", async () => {
  const f = await p1Fixture(db, { quota: 600n, resources: 2 });
  const provider = await db.insertInto("provider").values({ enterprise_id: f.enterpriseId, code: "kimi", name: "Kimi", adapter_type: "kimi" })
    .returning("id").executeTakeFirstOrThrow();
  await db.updateTable("provider_resource").set({ provider_id: provider.id }).where("id", "=", f.candidates[1]!.resourceId).execute();
  f.candidates[1]!.providerCode = "kimi";
  const grant = await db.insertInto("principal_grant").values({ enterprise_id: f.enterpriseId, principal_id: f.principalId,
    provider: "kimi", model_alias: "p1-model", quota_value: 300n }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  const { app, send } = await p1App(db, f, { maxAttempts: 2, outcome: (outcome, n) => n === 1
    ? { ...outcome, committed: false, status: 502, error: "upstream_error" }
    : { ...outcome, usage: { ...outcome.usage, input: 160, output: 0 } } });
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(facts.counter.used_value).toBe("42");
    expect(facts.transaction).toMatchObject({ total_deducted_quota: "522", overage: true });
    expect(await db.selectFrom("quota_counter").select(["used_value", "overage_value"]).where("grant_id", "=", grant.id).executeTakeFirst())
      .toEqual({ used_value: "480", overage_value: "180" });
  } finally { await app.close(); }
});

it("API成功不发送伪造的主体额度结算项", async () => {
  const f = await p1Fixture(db, { mode: "API" });
  const original = GatewayLedgerRepository.prototype.finalizeLedgerSettlementIfAbsent;
  const observed: unknown[] = [];
  const spy = vi.spyOn(GatewayLedgerRepository.prototype, "finalizeLedgerSettlementIfAbsent")
    .mockImplementation(async function (this: GatewayLedgerRepository, input) {
      observed.push(input.quota_settlements); return original.call(this, input);
    });
  const { app, send } = await p1App(db, f);
  try {
    expect((await send()).statusCode).toBe(200);
    expect(observed).toEqual([[]]);
    expect((await p1Facts(db, f)).counter.used_value).toBe("0");
  } finally { await app.close(); spy.mockRestore(); }
});

it("最终检查异常必须返回明确STOP/RETURNED，不能让执行器继续解构未准备的尝试", async () => {
  const f = await p1Fixture(db), original = preparation.prepareSelectedAttempt;
  const seen: unknown[] = [];
  const spy = vi.spyOn(preparation, "prepareSelectedAttempt").mockImplementation(async (context, state) => {
    const result = await original(context, state); seen.push(result); return result;
  });
  const { app, send } = await p1App(db, f, { fault: "policy" });
  try { expect((await send()).statusCode).toBe(500); expect(seen).toEqual([{ kind: "STOP", result: "RETURNED" }]); }
  finally { await app.close(); spy.mockRestore(); }
});

it("第二次复核被拒绝仍结算前次消耗并释放前次租约", async () => {
  const f = await p1Fixture(db, { resources: 2 }), original = DispatchPolicyRepository.prototype.listPublishedPolicies;
  let reads = 0;
  const spy = vi.spyOn(DispatchPolicyRepository.prototype, "listPublishedPolicies")
    .mockImplementation(async function (this: DispatchPolicyRepository, enterpriseId) {
      if (++reads === 3) await this.createPolicy({ enterpriseId, status: "PUBLISHED", matchUnifiedModel: "p1-model",
        matchResourceMode: "CODING_PLAN", matchProviderResourceId: f.candidates[1]!.resourceId,
        matchTimezone: null, matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null,
        matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null, matchForecastExhaustRisk: null,
        matchPrincipalScope: null, action: "REJECT", switchEquivalentGroup: [], rateLimitPerMinute: null,
        policyVersion: "reject-retry", priority: 1 });
      return original.call(this, enterpriseId);
    });
  const { app, send, stub } = await p1App(db, f, { maxAttempts: 2,
    outcome: outcome => ({ ...outcome, committed: false, status: 502, error: "upstream_error" }) });
  try {
    expect((await send()).statusCode).toBe(403);
    const facts = await p1Facts(db, f);
    expect(stub.calls).toHaveLength(1);
    expect(facts.counter.used_value).toBe("42");
    expect(facts.transaction?.total_deducted_quota).toBe("42");
    expect(facts.leases).toHaveLength(2);
    expect(facts.leases.every(lease => lease.released_at instanceof Date)).toBe(true);
  } finally { await app.close(); spy.mockRestore(); }
});
