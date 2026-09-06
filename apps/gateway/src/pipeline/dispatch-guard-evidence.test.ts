import { expect, it, vi } from "vitest";
import type { BillingRule, DispatchPolicy, RoutingCandidateInput } from "@qianliu/domain";
import { attemptDispatchGuard } from "./attempt-dispatch-guard.js";
import { finalizeDispatchCheckFailure } from "./dispatch-check-failure.js";
import { finalizeRejectedAttemptBeforeUpstream } from "./attempt-usage-settlement.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

const at = Date.parse("2026-09-06T00:00:00Z");
const candidate: RoutingCandidateInput = { resourceId: "current", upstreamModel: "up", providerCode: "deepseek",
  mode: "API", status: "ACTIVE", priority: 1, weight: 1, probe: false };
const rule: BillingRule = { id: "price", ruleType: "API_PRICE", ruleVersion: "price-v1", pricingMode: "MULTIPLIER",
  providerResourceId: "current", upstreamModel: "up", effectiveFrom: 0, effectiveTo: null,
  timezone: null, daysOfWeek: null, startTime: null, endTime: null, timeWindows: null, multiplier: "3",
  cacheHitPrice: "0.001", cacheMissPrice: "0.002", outputPrice: "0.004", currency: "CNY", priority: 1 };
function policy(patch: Partial<DispatchPolicy> = {}): DispatchPolicy {
  return { id: "policy", status: "PUBLISHED", policyVersion: "v1", priority: 1,
    matchUnifiedModel: null, matchResourceMode: null, matchProviderResourceId: null, matchTimezone: null,
    matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null, matchPriceMultiplierMin: null,
    matchRemainingQuotaRatioMax: null, matchForecastExhaustRisk: null, matchPrincipalScope: null,
    action: "SWITCH", switchEquivalentGroup: ["current", "other"], rateLimitPerMinute: 1, ...patch };
}
function fixture(policies: DispatchPolicy[] = []) {
  const update = vi.fn().mockResolvedValue(undefined), finalize = vi.fn().mockResolvedValue(undefined);
  const operating = vi.fn().mockResolvedValue({ priceMultiplier: "99", remainingQuotaRatio: 0.5, forecastExhaustRisk: false });
  const release = vi.fn().mockResolvedValue(undefined), error = vi.fn();
  const reply = { code: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() };
  // Only persistence/transport boundaries are doubles; the guard and Domain decision remain real.
  const context = { principal: { enterpriseId: "enterprise" }, principalId: "principal", requestId: "request",
    traceId: "trace", body: { model: "model" }, request: { log: { error } }, reply,
    deps: { dispatchRepo: { resolveResourceOperatingInput: operating, listPublishedPolicies: vi.fn().mockResolvedValue(policies) },
      ledgerRepo: { updateAttemptResult: update, finalizeRejectedAttemptSettlementIfAbsent: finalize },
      poolRepo: { releaseHalfOpenProbe: release } } } as unknown as PipelineContext;
  const state = { attemptNo: 1, routeEligibleCandidates: [candidate, { ...candidate, resourceId: "other" }],
    triedResourceIds: new Set<string>(), pendingQuotaSettlements: [], pendingLeaseIds: [],
    requestOverage: false, deferredResourceEffects: [] } as unknown as PipelineExecutionState;
  return { context, state, update, finalize, operating, release, error, reply };
}

it("无调度仓储时不读策略、不写假证据", async () => {
  const f = fixture(); f.context.deps.dispatchRepo = undefined;
  expect(await attemptDispatchGuard(f.context, f.state, candidate, rule, at, "attempt")).toBeNull();
  expect(f.operating).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
});

it.each(["REJECT", "RATE_LIMIT", "SWITCH", "ALLOW", "ALLOW_OVERAGE"] as const)("%s 按冻结价格决策并保存完整凭据", async action => {
  const f = fixture([policy({ action })]);
  const decision = await attemptDispatchGuard(f.context, f.state, candidate, rule, at, "attempt");
  if (action === "ALLOW" || action === "ALLOW_OVERAGE") expect(decision).toBeNull();
  else expect(decision?.finalAction).toBe(action);
  expect(f.operating).toHaveBeenCalledWith("enterprise", "current", at, "up");
  expect(f.update).toHaveBeenCalledWith("attempt", { dispatch_check: {
    checkedAt: new Date(at).toISOString(), resourceId: "current", upstreamModel: "up",
    ruleId: "price", ruleVersion: "price-v1", priceMultiplier: "3", policyId: "policy", policyVersion: "v1",
    action, reason: action === "REJECT" ? "REJECTED" : action === "RATE_LIMIT" ? "RATE_LIMITED"
      : action === "SWITCH" ? "SWITCH_WITHIN_GROUP" : action === "ALLOW" ? "ALLOW_MATCHED" : "ALLOW_OVERAGE_MATCHED",
    switchTargetResourceId: action === "SWITCH" ? "other" : null,
  } });
});

it.each(["matched", "satisfied"] as const)("只去掉真正已经执行的%s切换，不忽略新版本/新策略/拒绝动作", async source => {
  for (const variant of ["same", "id", "version", "action", "target"]) {
    const next = policy(variant === "id" ? { id: "new-policy" } : variant === "version" ? { policyVersion: "v2" }
      : variant === "action" ? { action: "REJECT" } : {});
    const f = fixture([next]);
    const target = variant === "target" ? "elsewhere" : "current";
    if (source === "matched") { f.state.dispatchMatchedPolicy = policy(); f.state.dispatchSwitchTargetId = target; }
    else f.state.dispatchSatisfiedSwitch = { policyId: "policy", policyVersion: "v1", targetId: target };
    const result = await attemptDispatchGuard(f.context, f.state, candidate, rule, at, "attempt");
    if (variant === "same") expect(result).toBeNull();
    else expect(result?.finalAction).toBe(variant === "action" ? "REJECT" : "SWITCH");
  }
});

it("已经尝试的备选不能再次选择，经营快照倍率不能覆盖冻结价格", async () => {
  const f = fixture([policy()]); f.state.triedResourceIds.add("other");
  expect(await attemptDispatchGuard(f.context, f.state, candidate, rule, at, "attempt")).toBeNull();
  expect(f.update.mock.calls[0]![1].dispatch_check).toMatchObject({ action: "ALLOW", reason: "SWITCH_NO_TARGET" });
  const g = fixture([policy({ action: "REJECT", matchPriceMultiplierMin: "4" })]);
  expect(await attemptDispatchGuard(g.context, g.state, candidate, rule, at, "attempt")).toBeNull();
  expect(g.update.mock.calls[0]![1].dispatch_check).toMatchObject({ priceMultiplier: "3", action: "ALLOW", policyId: null });
});

it.each([false, true])("检查失败：探针释放错误=%s，凭据和500响应稳定且继续清理其余探针", async releaseFails => {
  const f = fixture(), before = new Date(1), current = new Date(2);
  f.state.deferredResourceEffects = [{ probeLease: { resourceId: "previous", acquiredAt: before } }, {}] as PipelineExecutionState["deferredResourceEffects"];
  if (releaseFails) f.release.mockRejectedValueOnce(new Error("release-test"));
  await finalizeDispatchCheckFailure(f.context, f.state, {
    candidate, attempt: { id: "attempt" } as Parameters<typeof finalizeDispatchCheckFailure>[2]["attempt"],
    grantId: null, reservedEstimate: 0n, leaseId: null, probeLease: { resourceId: "current", acquiredAt: current },
  });
  expect(f.finalize.mock.calls[0]![0]).toMatchObject({ error_classification: "INTERNAL", overage: false,
    error_code: "dispatch_check_failed_before_upstream", quota_settlements: [], release_lease_ids: [] });
  expect(f.release.mock.calls).toEqual([["previous", before], ["current", current]]);
  expect(f.error).toHaveBeenCalledTimes(releaseFails ? 2 : 1);
  expect(f.error.mock.calls[0]).toEqual([{ requestId: "request", attemptId: "attempt", errorCode: "dispatch_check_failed_before_upstream" },
    "final dispatch check failed before upstream invocation"]);
  if (releaseFails) expect(f.error.mock.calls[1]![0]).toMatchObject({ action: "release failed dispatch check probe" });
  expect(f.reply.code).toHaveBeenCalledWith(500); expect(f.reply.header).toHaveBeenCalledWith("x-request-id", "trace");
  expect(f.reply.send).toHaveBeenCalledWith({ error: { message: "当前尝试在访问厂商前调度检查失败，请稍后重试",
    type: "internal_error", code: "dispatch_check_failed_before_upstream", retryable: true, request_id: "request" } });
});

it("终态包装器省略overage时为false，保留真实错误类别而非硬编码授权错误", async () => {
  const f = fixture();
  await finalizeRejectedAttemptBeforeUpstream({ ledgerRepo: f.context.deps.ledgerRepo, requestId: "request",
    enterpriseId: "enterprise", principalId: "principal", attemptId: "attempt", attemptNo: 1,
    resourceId: "current", resourceMode: "API", errorCode: "blocked", quotaSettlements: [], releaseLeaseIds: [],
    attemptResult: { error_classification: "INTERNAL", error_code: "blocked", switch_reason: null, http_status: 500, response_committed: false, finished_at: new Date(at) } });
  expect(f.finalize.mock.calls[0]![0]).toMatchObject({ error_classification: "INTERNAL", overage: false,
    ledger_line: { api_cost: "0.00000000", api_cost_status: "CONFIRMED_ZERO_NO_UPSTREAM" } });
});
