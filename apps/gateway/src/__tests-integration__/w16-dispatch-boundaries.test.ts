import { describe, it, expect, vi } from "vitest";
import { StubUpstream } from "@qianliu/provider-adapters";
import { db, stub, dispatchRepo, ENT_ID, authHeader, buildApp, setStub } from "./w16-dispatch-fixture.js";

describe("W16 高峰边界", () => {
  it("智谱 14:00–18:00 REJECT 边界：峰内不访问上游、不扣额度，18:00 恢复", async () => {
    await db.updateTable("principal_grant").set({ valid_from: new Date(0) }).where("enterprise_id", "=", ENT_ID).execute();
    const policyId = await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchResourceMode: "CODING_PLAN",
      matchProviderResourceId: null,
      matchTimezone: "Asia/Shanghai",
      matchDaysOfWeek: [1, 2, 3, 4, 5],
      matchStartTime: "14:00:00",
      matchEndTime: "18:00:00",
      matchPriceMultiplierMin: null,
      matchRemainingQuotaRatioMax: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "REJECT",
      switchEquivalentGroup: null,
      rateLimitPerMinute: null,
      policyVersion: "zhipu-peak-reject-v1",
      priority: 1,
    });
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    }));
    let now = Date.parse("2026-07-30T05:59:59.000Z");
    const app = await buildApp(
      async () => ({
        priceMultiplier: "1",
        remainingQuotaRatio: 0.9,
        forecastExhaustRisk: false,
      }),
      () => now,
    );
    const send = () => app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: {
        model: "ql-glm-5.2",
        messages: [{ role: "user", content: "boundary" }],
      },
    });
    const sendMessages = () => app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: authHeader(),
      payload: {
        model: "ql-glm-5.2",
        messages: [{ role: "user", content: "boundary" }],
        max_tokens: 20,
      },
    });
    const sendResponses = () => app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", input: "boundary" },
    });

    try {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const beforePeak = await send();
    expect(beforePeak.statusCode, beforePeak.body).toBe(200);
    expect(stub.calls).toHaveLength(1);
    const quotaBeforePeak = await db
      .selectFrom("quota_counter")
      .select("used_value")
      .executeTakeFirstOrThrow();

    now = Date.parse("2026-07-30T06:00:00.000Z");
    vi.setSystemTime(new Date(now));
    const atStart = await send();
    expect(atStart.statusCode).toBe(403);
    expect(atStart.json().error).toEqual(expect.objectContaining({
      message: "高峰时段暂停使用；策略时段 工作日 14:00-18:00 Asia/Shanghai；2026-07-30T10:00:00.000Z 后恢复",
      code: "dispatch_rejected",
      retryable: false,
      policy_window: "工作日 14:00-18:00 Asia/Shanghai",
      reset_at: "2026-07-30T10:00:00.000Z",
      attempt_count: 0,
      usage_created: false,
      charged: false,
      dispatch: {
        final_action: "REJECT",
        reason_code: "REJECTED",
        policy_version: "zhipu-peak-reject-v1",
        unavailable_window: {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5],
          start_time: "14:00:00",
          end_time: "18:00:00",
        },
      },
    }));
    const messagesAtStart = await sendMessages();
    expect(messagesAtStart.statusCode).toBe(403);
    expect(messagesAtStart.json()).toEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({
        type: "api_error",
        code: "dispatch_rejected",
        dispatch: expect.objectContaining({
          policy_version: "zhipu-peak-reject-v1",
          unavailable_window: expect.objectContaining({
            timezone: "Asia/Shanghai",
            start_time: "14:00:00",
            end_time: "18:00:00",
          }),
        }),
      }),
    }));
    const responsesAtStart = await sendResponses();
    expect(responsesAtStart.statusCode).toBe(403);
    expect(responsesAtStart.json().error).toEqual(expect.objectContaining({
      type: "server_error",
      code: "dispatch_rejected",
      dispatch: expect.objectContaining({
        policy_version: "zhipu-peak-reject-v1",
        unavailable_window: expect.objectContaining({
          timezone: "Asia/Shanghai",
          start_time: "14:00:00",
          end_time: "18:00:00",
        }),
      }),
    }));
    expect(stub.calls).toHaveLength(1);

    now = Date.parse("2026-07-30T09:59:59.000Z");
    expect((await send()).statusCode).toBe(403);
    expect(stub.calls).toHaveLength(1);
    const quotaAfterPeak = await db
      .selectFrom("quota_counter")
      .select("used_value")
      .executeTakeFirstOrThrow();
    expect(quotaAfterPeak.used_value).toBe(quotaBeforePeak.used_value);
    const blockedRequestId = String(atStart.headers["x-request-id"]);
    expect(await db.selectFrom("upstream_attempt")
      .select("id").where("ai_request_id", "=", blockedRequestId).execute()).toHaveLength(0);
    expect(await db.selectFrom("usage_event")
      .select("id").where("ai_request_id", "=", blockedRequestId).execute()).toHaveLength(0);
    expect(await db.selectFrom("ledger_line")
      .select("id").where("ai_request_id", "=", blockedRequestId).execute()).toHaveLength(0);

    const decision = await dispatchRepo.getDecision(blockedRequestId);
    expect(decision).toEqual(expect.objectContaining({
      matched_policy_id: policyId,
      matched_policy_version: "zhipu-peak-reject-v1",
      final_action: "REJECT",
      reason_code: "REJECTED",
    }));
    expect(decision!.dispatch_input).toEqual(expect.objectContaining({
      matchedTimezone: "Asia/Shanghai",
      matchedDaysOfWeek: [1, 2, 3, 4, 5],
      matchedStartTime: "14:00:00",
      matchedEndTime: "18:00:00",
      executedResourceIds: [],
      usageEvidence: null,
      actualPricingEvidence: [],
      savingCalculationVersion: "pool-021-v1",
    }));

    now = Date.parse("2026-07-30T10:00:00.000Z");
    vi.setSystemTime(new Date(now));
    expect((await send()).statusCode).toBe(200);
    expect(stub.calls).toHaveLength(2);

    now = Date.parse("2026-08-01T06:00:00.000Z"); // 周六 14:00（Asia/Shanghai）
    vi.setSystemTime(new Date(now));
    expect((await send()).statusCode).toBe(200);
    expect(stub.calls).toHaveLength(3);
    expect(
      await dispatchRepo.transitionStatus(ENT_ID, policyId, "PUBLISHED", "RETIRED"),
    ).toBe(true);
    } finally { vi.useRealTimers(); await app.close(); }
  });
});
