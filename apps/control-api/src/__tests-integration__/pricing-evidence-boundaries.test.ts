import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CreateBillingRuleSchema } from "../read-models/billing-rule-contract.js";
import { app, db, adminCookie, ENT_ID, seedProviderResource } from "./w19-admin-fixture.js";

const base = { rule_type: "API_PRICE", rule_version: "contract-v1",
  effective_from: "2026-09-01T00:00:00Z", cache_hit_price: "0", cache_miss_price: "0.1", output_price: "0.2" };
const window = { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "12:00" };

it.each([
  [{ multiplier: "1" }, "multiplier"],
  [{ pricing_mode: "MULTIPLIER", multiplier: "0" }, "pricing_mode"],
  [{ pricing_mode: "MULTIPLIER", multiplier: "3", output_price: null }, "pricing_mode"],
  [{ rule_type: "TIME_WINDOW", cache_hit_price: null, cache_miss_price: null, output_price: null, multiplier: "2" }, "start_time"],
  [{ rule_type: "MODEL_TIER", cache_hit_price: null, cache_miss_price: null, output_price: null, multiplier: "2", windows: [window] }, "timezone"],
  [{ timezone: "Asia/Shanghai" }, "timezone"],
  [{ timezone: "Invalid/Zone", start_time: "09:00", end_time: "12:00" }, "timezone"],
  [{ timezone: "Asia/Shanghai", start_time: "09:00", end_time: "09:00" }, "end_time"],
  [{ timezone: "Asia/Shanghai", start_time: "09:00", end_time: "12:00", days_of_week: [1, 1] }, "days_of_week"],
  [{ days_of_week: [1] }, "days_of_week"],
  [{ windows: [window, window] }, "windows"],
  [{ windows: [window], timezone: "Asia/Shanghai", start_time: "09:00", end_time: "12:00" }, "windows"],
  [{ effective_to: base.effective_from }, "effective_to"],
])("计价边界拒绝 %j 并定位 %s", (patch, field) => {
  const result = CreateBillingRuleSchema.safeParse({ ...base, ...patch });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some(issue => issue.path.includes(field))).toBe(true);
});

it("绝对免费价格、合法API倍率和完整套餐时段均可通过合同", () => {
  expect(CreateBillingRuleSchema.safeParse({ ...base, cache_miss_price: "0", output_price: "0" }).success).toBe(true);
  expect(CreateBillingRuleSchema.safeParse({ ...base, pricing_mode: "MULTIPLIER", multiplier: "3", windows: [window] }).success).toBe(true);
  expect(CreateBillingRuleSchema.safeParse({ ...base, rule_type: "TIME_WINDOW", cache_hit_price: null,
    cache_miss_price: null, output_price: null, multiplier: "2", ...window }).success).toBe(true);
});

it("旧创建入口将价格模式冲突转换409，但非预期仓储错误仍失败", async () => {
  const payload = { ...base, rule_version: randomUUID().slice(0, 8) };
  const created = await app.inject({ method: "POST", url: "/billing-rules", headers: { cookie: adminCookie }, payload });
  expect(created.statusCode).toBe(201);
  const conflicting = await app.inject({ method: "POST", url: "/billing-rules", headers: { cookie: adminCookie },
    payload: { ...payload, rule_version: randomUUID().slice(0, 8), pricing_mode: "MULTIPLIER", multiplier: "3" } });
  expect(conflicting.statusCode).toBe(409);
  expect(conflicting.json().error).toBe("pricing_mode_conflict");
  const failure = vi.spyOn(app.ledgerRepo, "createBillingRule").mockRejectedValueOnce(new Error("fixture-storage-failure"));
  try {
    const response = await app.inject({ method: "POST", url: "/billing-rules", headers: { cookie: adminCookie },
      payload: { ...payload, rule_version: randomUUID().slice(0, 8) } });
    expect(response.statusCode).toBe(500);
  } finally { failure.mockRestore(); }
});

async function newPolicy(status: "DRAFT" | "PUBLISHED" | "RETIRED", resourceId: string | null = null) {
  return app.dispatchRepo.createPolicy({ enterpriseId: ENT_ID, status, matchUnifiedModel: null,
    matchResourceMode: null, matchProviderResourceId: resourceId, matchTimezone: null,
    matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null, matchPriceMultiplierMin: null,
    matchRemainingQuotaRatioMax: null, matchForecastExhaustRisk: null, matchPrincipalScope: null,
    action: "ALLOW", switchEquivalentGroup: null, rateLimitPerMinute: null, policyVersion: randomUUID().slice(0, 8), priority: 100 });
}
const action = (id: string, name: string, payload: Record<string, unknown> = {}) => app.inject({
  method: "POST", url: `/dispatch-policies/${id}/${name}`, headers: { cookie: adminCookie }, payload,
});

it("策略存档HTTP校验版本和状态，重复存档不重复写入", async () => {
  const id = await newPolicy("RETIRED");
  expect((await action(id, "archive")).statusCode).toBe(400);
  expect((await action(id, "archive", { expected_version: 9 })).statusCode).toBe(409);
  const published = await newPolicy("PUBLISHED");
  expect((await action(published, "archive", { expected_version: 1 })).statusCode).toBe(409);
  expect((await action(randomUUID(), "archive", { expected_version: 1 })).statusCode).toBe(409);
  const archived = await action(id, "archive", { expected_version: 1 });
  expect(archived.statusCode).toBe(200);
  expect(archived.json().policy).toMatchObject({ status: "RETIRED", version: 2, archivedAt: expect.any(String) });
  expect((await action(id, "archive", { expected_version: 2 })).statusCode).toBe(409);
  const row = await db.selectFrom("dispatch_policy").select(["status", "version", "archived_at"]).where("id", "=", id).executeTakeFirstOrThrow();
  expect(row).toMatchObject({ status: "RETIRED", version: 2, archived_at: expect.any(Date) });
});

it("策略校验遇到缺价资源返回明确引用错误且不改变草稿状态", async () => {
  const { resource } = await seedProviderResource();
  const id = await newPolicy("DRAFT", resource.id);
  const response = await action(id, "validate");
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("invalid_reference");
  expect((await app.dispatchRepo.getPolicy(ENT_ID, id))?.status).toBe("DRAFT");
});
