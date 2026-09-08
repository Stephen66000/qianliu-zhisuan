import { beforeAll, expect, it, vi } from "vitest";
import { StubUpstream } from "@qianliu/provider-adapters";
import { db, resDsA, resA, stub, ledgerRepo, dispatchRepo, ENT_ID,
  authHeader, buildApp, setStub } from "./w16-dispatch-fixture.js";

// Only the clock and external provider response are controlled. HTTP, policy matching,
// decimal pricing, settlement and PostgreSQL persistence use the real implementation.
const windows = [
  { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "12:00" },
  { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "14:00", end_time: "18:00" },
];
beforeAll(async () => {
  // Calendar scenarios precede the real test run; their grants must already be valid.
  await db.updateTable("principal_grant").set({ valid_from: new Date("2026-09-01T00:00:00+08:00") })
    .where("enterprise_id", "=", ENT_ID).execute();
  await db.updateTable("billing_rule").set({ enabled: false }).where("enterprise_id", "=", ENT_ID).execute();
  const api = { enterprise_id: ENT_ID, provider_resource_id: resDsA, upstream_model: "deepseek-chat",
    rule_type: "API_PRICE" as const, effective_from: new Date(0), cache_hit_price: "0.000001",
    cache_miss_price: "0.000002", output_price: "0.000004" };
  await ledgerRepo.createBillingRule({ ...api, rule_version: "calendar-base", priority: 100,
    pricing_mode: "MULTIPLIER", multiplier: "1" });
  await ledgerRepo.createBillingRule({ ...api, rule_version: "calendar-peak", priority: 1,
    pricing_mode: "MULTIPLIER", multiplier: "3", time_windows: windows });
  const plan = { enterprise_id: ENT_ID, provider_resource_id: resA, upstream_model: "glm-5.2",
    effective_from: new Date(0) };
  await ledgerRepo.createBillingRule({ ...plan, rule_type: "MODEL_TIER", rule_version: "plan-base", multiplier: "1", priority: 100 });
  await ledgerRepo.createBillingRule({ ...plan, rule_type: "TIME_WINDOW", rule_version: "plan-peak",
    multiplier: "3", time_windows: windows, priority: 1 });
});

async function requestAt(at: string, plan = false) {
  setStub(new StubUpstream({ providerCode: plan ? "zhipu" : "deepseek", default: { kind: "SUCCESS",
    usage: plan ? { input: 1000, output: 100, cache: 200 } : { input: 1000000, output: 100000, cache: 200000 } } }));
  const app = await buildApp(undefined, () => Date.parse(at));
  try {
    // Admission's injected clock alone does not change the final authorization clock.
    // Freeze Date in this test process as well; leave HTTP/PG/timer scheduling real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/v1/chat/completions`, { method: "POST", headers: authHeader(),
      body: JSON.stringify({ model: plan ? "ql-glm-5.2" : "qianliu-deepseek", messages: [{ role: "user", content: "calendar check" }] }) });
    const body = await response.text();
    const id = response.headers.get("x-request-id");
    expect(id).toBeTruthy();
    const lines = await ledgerRepo.listLedgerLines(id!);
    return { status: response.status, body, id: id!, lines };
  } finally { vi.useRealTimers(); await app.close(); }
}

it.each([
  ["周一早峰前", "2026-09-07T08:59:59+08:00", "2.20000000", "1"],
  ["周一早峰开始", "2026-09-07T09:00:00+08:00", "6.60000000", "3"],
  ["周一早峰结束前", "2026-09-07T11:59:59+08:00", "6.60000000", "3"],
  ["周一午间低谷", "2026-09-07T12:00:00+08:00", "2.20000000", "1"],
  ["周一午后高峰", "2026-09-07T14:00:00+08:00", "6.60000000", "3"],
  ["周一高峰结束", "2026-09-07T18:00:00+08:00", "2.20000000", "1"],
  ["周六同一时刻", "2026-09-12T14:00:00+08:00", "2.20000000", "1"],
  ["周日同一时刻", "2026-09-06T14:00:00+08:00", "2.20000000", "1"],
])("真实HTTP → PG账本：%s", async (_name, at, cost, multiplier) => {
  const result = await requestAt(at);
  expect(result.status, result.body).toBe(200); expect(stub.calls).toHaveLength(1);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ provider_resource_id: resDsA, raw_input_tokens: "1000000",
    raw_output_tokens: "100000", raw_cache_tokens: "200000", api_cost: cost, multiplier,
    billing_rule_snapshot: { pricingMode: "MULTIPLIER", effectiveMultiplier: multiplier } });
  process.stdout.write(JSON.stringify({ scenario: _name, at, apiCost: result.lines[0]!.api_cost, multiplier }) + "\n");
});

it.each([
  ["周一高峰", "2026-09-07T14:00:00+08:00", "3300", "3"],
  ["周一低谷", "2026-09-07T18:00:00+08:00", "1100", "1"],
  ["周日", "2026-09-06T14:00:00+08:00", "1100", "1"],
])("套餐真实HTTP → PG扣减：%s", async (_name, at, deducted, multiplier) => {
  const result = await requestAt(at, true);
  expect(result.status, result.body).toBe(200); expect(stub.calls).toHaveLength(1);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ provider_resource_id: resA, raw_input_tokens: "1000",
    raw_output_tokens: "100", raw_cache_tokens: "200", deducted_quota: deducted, multiplier, api_cost: null });
  process.stdout.write(JSON.stringify({ scenario: _name, at, deductedQuota: result.lines[0]!.deducted_quota, multiplier }) + "\n");
});

it("按真实高峰倍率拒绝时不调用上游；周日自动按基础价放行", async () => {
  const policyId = await dispatchRepo.createPolicy({ enterpriseId: ENT_ID, status: "PUBLISHED",
    matchUnifiedModel: "qianliu-deepseek", matchResourceMode: "API", matchProviderResourceId: resDsA,
    matchTimezone: null, matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null,
    matchPriceMultiplierMin: "3", matchRemainingQuotaRatioMax: null, matchForecastExhaustRisk: null,
    matchPrincipalScope: null, action: "REJECT", switchEquivalentGroup: [], rateLimitPerMinute: null,
    policyVersion: "calendar-reject", priority: 1 });
  try {
    const peak = await requestAt("2026-09-07T14:00:00+08:00");
    expect(peak.status).toBe(403); expect(stub.calls).toHaveLength(0);
    expect(JSON.parse(peak.body).error.code).toBe("dispatch_rejected");
    expect(peak.lines.every((line) => line.api_cost === "0.00000000")).toBe(true);
    const sunday = await requestAt("2026-09-06T14:00:00+08:00");
    expect(sunday.status).toBe(200); expect(stub.calls).toHaveLength(1);
    expect(sunday.lines[0]!.api_cost).toBe("2.20000000");
  } finally { await dispatchRepo.transitionStatus(ENT_ID, policyId, "PUBLISHED", "RETIRED"); }
});

it("已有绝对单价模式也按工作日高峰切换，逐笔费用在数据库正确汇总", async () => {
  await db.updateTable("billing_rule").set({ enabled: false }).where("enterprise_id", "=", ENT_ID)
    .where("provider_resource_id", "=", resDsA).execute();
  const scope = { enterprise_id: ENT_ID, provider_resource_id: resDsA, upstream_model: "deepseek-chat",
    rule_type: "API_PRICE" as const, pricing_mode: "ABSOLUTE" as const, effective_from: new Date(0) };
  await ledgerRepo.createBillingRule({ ...scope, rule_version: "absolute-base", priority: 100,
    cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004" });
  await ledgerRepo.createBillingRule({ ...scope, rule_version: "absolute-peak", priority: 1,
    cache_hit_price: "0.000003", cache_miss_price: "0.000006", output_price: "0.000012", time_windows: windows });
  const peak = await requestAt("2026-09-07T14:00:00+08:00");
  const sunday = await requestAt("2026-09-06T14:00:00+08:00");
  expect(peak.status).toBe(200); expect(sunday.status).toBe(200);
  expect(peak.lines[0]).toMatchObject({ api_cost: "6.60000000", billing_rule_snapshot: { pricingMode: "ABSOLUTE" } });
  expect(sunday.lines[0]!.api_cost).toBe("2.20000000");
  const total = await db.selectFrom("ledger_line").select(({ fn }) => fn.sum<string>("api_cost").as("cost"))
    .where("ai_request_id", "in", [peak.id, sunday.id]).executeTakeFirstOrThrow();
  expect(total.cost).toBe("8.80000000");
});
