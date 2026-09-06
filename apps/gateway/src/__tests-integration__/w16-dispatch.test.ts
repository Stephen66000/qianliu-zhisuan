import { describe, it, expect } from "vitest";
import { StubUpstream } from "@qianliu/provider-adapters";
import { resA, resB, ledgerRepo, dispatchRepo, ENT_ID, authHeader, buildApp, setStub } from "./w16-dispatch-fixture.js";

describe("W16 调度动作", () => {
  it("WT-16：高峰时段命中 SWITCH 策略 → 在等价资源组内切换（dispatch_decision 可解释）", async () => {
    // 发布高峰 SWITCH 策略：A → 等价组 [A,B] 内切换
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchPriceMultiplierMin: "3", // 高峰倍率 ≥3 命中
      matchResourceMode: "CODING_PLAN",
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchRemainingQuotaRatioMax: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "SWITCH",
      switchEquivalentGroup: [resA, resB],
      rateLimitPerMinute: null,
      policyVersion: "w16-v1",
      priority: 100,
    });

    // StubUpstream 成功；resolveDispatchInput 注入高峰倍率 3（命中策略）
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 500, output: 200, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "3", // 高峰
      remainingQuotaRatio: 0.8,
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

    // dispatch_decision：final_action=SWITCH，目标=resB
    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision).toBeDefined();
    expect(decision!.final_action).toBe("SWITCH");
    expect(decision!.reason_code).toBe("SWITCH_WITHIN_GROUP");
    expect(decision!.switch_target_resource_id).toBe(resB);

    // 实际 Attempt 落到 resB（切换后的资源）
    const attempts = await ledgerRepo.listAttempts(requestId);
    expect(attempts[0]!.provider_resource_id).toBe(resB);
  });

  it("WT-16：命中 REJECT 策略 → 403（不无账放行）", async () => {
    // REJECT 策略：剩余额度比例 ≤0.1 命中
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchRemainingQuotaRatioMax: "0.1",
      matchResourceMode: null,
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchPriceMultiplierMin: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "REJECT",
      switchEquivalentGroup: null,
      rateLimitPerMinute: null,
      policyVersion: "w16-v1",
      priority: 50, // 比 SWITCH 更高优先级
    });

    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.05, // 命中 REJECT（≤0.1）
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(403);
    expect(chatRes.json().error).toEqual(expect.objectContaining({
      code: "dispatch_rejected",
      dispatch: {
        final_action: "REJECT",
        reason_code: "REJECTED",
        policy_version: "w16-v1",
      },
    }));
    expect(chatRes.json().error.dispatch).not.toHaveProperty("unavailable_window");
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision).toEqual(expect.objectContaining({
      matched_policy_action: "REJECT",
      final_action: "REJECT",
      reason_code: "REJECTED",
      saving_calculable: false,
      not_calculable_reason: "dispatch_terminated_before_attempt",
    }));
  });

  it("WT-16：命中 RATE_LIMIT 策略 → 429", async () => {
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchForecastExhaustRisk: true, // 预计耗尽风险命中
      matchResourceMode: null,
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchPriceMultiplierMin: null,
      matchRemainingQuotaRatioMax: null,
      matchPrincipalScope: null,
      action: "RATE_LIMIT",
      switchEquivalentGroup: null,
      rateLimitPerMinute: 10,
      policyVersion: "w16-v1",
      priority: 40,
    });

    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.5,
      forecastExhaustRisk: true, // 命中 RATE_LIMIT
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(429);
    expect(chatRes.json().error).toEqual(expect.objectContaining({
      message: "经营调度限流",
      code: "dispatch_rate_limited",
      dispatch: {
        final_action: "RATE_LIMIT",
        reason_code: "RATE_LIMITED",
        policy_version: "w16-v1",
      },
    }));
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    expect(await dispatchRepo.getDecision(requestId)).toEqual(expect.objectContaining({
      matched_policy_action: "RATE_LIMIT",
      final_action: "RATE_LIMIT",
      reason_code: "RATE_LIMITED",
      saving_calculable: false,
      not_calculable_reason: "dispatch_terminated_before_attempt",
    }));
  });

  it("WT-17：无策略/ALLOW 仅提示 → saving_calculable=false（NOT_CALCULABLE）", async () => {
    // 该请求无任何高风险输入 → 不命中 REJECT/RATE_LIMIT/SWITCH → 默认 ALLOW_NO_POLICY
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 300, output: 100, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.9, // 充足，不命中任何策略
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
    expect(decision!.final_action).toBe("ALLOW");
    expect(decision!.reason_code).toBe("ALLOW_NO_POLICY");
    // ALLOW 仅提示，未改变行为 → NOT_CALCULABLE（行 631）
    expect(decision!.saving_calculable).toBe(false);
    expect(decision!.not_calculable_reason).toBe("no_action_executed");
    expect(decision!.dispatch_saving).toBeNull();
  });
});
