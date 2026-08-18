import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestDrilldown } from "./RequestDrilldown.js";

const clipboardWrite = vi.fn();

vi.mock("../api/hooks", () => ({
  useGatewayRequest: () => ({
    isLoading: false,
    error: null,
    data: {
      request: {
        id: "request-1", principalId: "principal-1", protocol: "chat", unifiedModel: "ql-deepseek",
        stream: false, status: "SUCCEEDED", clientId: "codex", startedAt: "2026-08-18T01:00:00.000Z",
        finishedAt: "2026-08-18T01:00:01.000Z", errorClassification: null, errorCode: null,
      },
      settlement: {
        totalInputTokens: "100", totalOutputTokens: "20", totalCacheTokens: "10",
        totalReasoningTokens: "0", totalDeductedQuota: "0", totalApiCost: "0.00100000",
        usageQuality: "PROVIDER_REPORTED", attemptCount: 1, status: "SETTLED",
      },
    },
  }),
  useRouteCandidates: () => ({ isLoading: false, data: { candidates: [{
    providerResourceId: "resource-1", upstreamModel: "deepseek-chat", priority: 1, weight: 1,
    selected: true, scoreFactors: null, totalScore: "1", reasonCode: "SELECTED",
  }] } }),
  useAttempts: () => ({ isLoading: false, data: {
    attempts: [{
      attemptNo: 1, providerResourceId: "resource-1", upstreamModel: "deepseek-chat",
      startedAt: "2026-08-18T01:00:00.000Z", firstByteAt: null,
      finishedAt: "2026-08-18T01:00:01.000Z", httpStatus: 200,
      errorClassification: null, errorCode: null, failureLayer: null,
      responseCommitted: false, switchReason: null,
      metering: [{
        inputTokens: "100", outputTokens: "20", cacheTokens: "10", reasoningTokens: "0",
        deductedQuota: null, apiCost: "0.00100000", usageQuality: "PROVIDER_REPORTED",
        billingRuleId: "rule-1", ruleVersion: "deepseek-v1", multiplier: null,
        billingRuleSnapshot: {
          ruleType: "API_PRICE", effectiveFrom: "2026-08-01T00:00:00.000Z",
          cacheHitPrice: "0.000001", cacheMissPrice: "0.000002", outputPrice: "0.000004",
        },
      }],
    }],
    ledgerLines: [{ attemptId: "attempt-1" }],
  } }),
  useDispatchDecision: () => ({ isLoading: false, data: { decision: {
    dispatchInput: {
      selectedResourceId: "resource-1", unifiedModel: "ql-deepseek",
      principalId: "principal-sensitive-id", remainingQuotaRatio: null,
    },
    finalAction: "ALLOW", reasonCode: "ALLOW_NO_POLICY", reasonDetail: null,
    matchedPolicyId: null, matchedPolicyVersion: null, matchedPolicyAction: null,
    switchTargetResourceId: null, counterfactualCost: null, actualCost: "0.00100000",
    dispatchSaving: null, savingCalculable: false, notCalculableReason: "NO_SWITCH",
  } } }),
}));

describe("POOL20-031/032 请求决策详情", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    clipboardWrite.mockResolvedValue(undefined);
  });

  it("拆分调度与计价，默认摘要展示并折叠可复制的技术详情", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<RequestDrilldown requestId="request-1" />);

    expect(screen.getByRole("heading", { name: "调度决策" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "计价决策" })).toBeInTheDocument();
    expect(screen.getByText("未命中调度策略，默认允许")).toBeInTheDocument();
    expect(screen.getAllByText("deepseek-v1").length).toBeGreaterThan(0);
    expect(screen.getByText("API_PRICE")).toBeInTheDocument();

    const summary = screen.getByText("技术详情（调度输入快照）");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
    await user.click(summary);
    await user.click(screen.getByRole("button", { name: "复制技术详情" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("principal-sensitive-id"));
  });
});
