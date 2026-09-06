import { describe, it, expect } from "vitest";
import { StubUpstream } from "@qianliu/provider-adapters";
import { resDsA, resDsB, dispatchRepo, ENT_ID, authHeader, buildApp, setStub, seedCodingPlanSwitch } from "./w16-dispatch-fixture.js";

describe("W16 反事实节省", () => {
  it("WT-17：SWITCH 实际执行 → saving_calculable=true（可计算）", async () => {
    // 本用例独立准备 SWITCH 策略 + 高峰倍率 3 → 命中切换
    await seedCodingPlanSwitch();
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 400, output: 150, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "3",
      remainingQuotaRatio: 0.7,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision!.final_action).toBe("SWITCH");
    // CODING_PLAN 模式 api_cost=null（PACKAGE_INCLUDED，无价格证据）→ 节省 NOT_CALCULABLE（§9.1 行 630）
    // 这是正确语义：套餐模式无 API 费用可比，节省不可计算
    expect(decision!.saving_calculable).toBe(false);
    expect(decision!.not_calculable_reason).toBe("package_cost_not_comparable");
    expect(decision!.actual_cost).toBeNull(); // CODING_PLAN 不产生 API 费用
  });

  it("WT-17：API 模式 SWITCH + 有 api_cost → saving_calculable=true（可计算）", async () => {
    // deepseek API 模式 SWITCH 策略：等价组 [dsA, dsB]
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "qianliu-deepseek",
      matchResourceMode: "API",
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchPriceMultiplierMin: null,
      matchRemainingQuotaRatioMax: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "SWITCH",
      switchEquivalentGroup: [resDsA, resDsB],
      rateLimitPerMinute: null,
      policyVersion: "w16-v1",
      priority: 30, // 最高优先级
    });

    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 500, output: 200, cache: 50 } },
      providerCode: "deepseek",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.7,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision!.final_action).toBe("SWITCH");
    // 使用相同 usage：A 反事实成本 0.00310000，B 实际成本 0.00155000。
    expect(decision!.saving_calculable).toBe(true);
    expect(decision!.counterfactual_cost).toBe("0.00310000");
    expect(decision!.actual_cost).toBe("0.00155000");
    expect(decision!.dispatch_saving).toBe("0.00155000");
    expect(decision!.dispatch_input).toEqual(expect.objectContaining({
      baselineResourceId: resDsA,
      executedResourceIds: [resDsB],
      counterfactualRuleVersion: "ds-a-expensive-v1",
      savingCalculationVersion: "pool-021-v1",
      usageEvidence: { input: 500, output: 200, cache: 50 },
    }));
  });
});
