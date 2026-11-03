import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestDrilldown } from "./RequestDrilldown.js";

const clipboardWrite = vi.fn();
const costProjection = vi.hoisted(() => ({
  total: "0.00100000" as string | null,
  line: "0.00100000" as string | null,
  status: undefined as string | undefined,
  currency: undefined as string | undefined,
  sourceStatus: undefined as string | undefined,
}));

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
        totalReasoningTokens: "0", totalDeductedQuota: "0", totalApiCost: costProjection.total,
        apiCostStatus: costProjection.status,
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
        deductedQuota: null, apiCost: costProjection.line, apiCostStatus: costProjection.status, usageQuality: "PROVIDER_REPORTED",
        billingRuleId: "rule-1", ruleVersion: "deepseek-v1", multiplier: null,
        billingRuleSnapshot: {
          ruleType: "API_PRICE", effectiveFrom: "2026-08-01T00:00:00.000Z",
          cacheHitPrice: "0.000001", cacheMissPrice: "0.000002", outputPrice: "0.000004",
          currency: costProjection.currency,
          sourceStatus: costProjection.sourceStatus,
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
    costProjection.total = "0.00100000";
    costProjection.line = "0.00100000";
    costProjection.status = undefined;
    costProjection.currency = undefined;
    costProjection.sourceStatus = undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    clipboardWrite.mockResolvedValue(undefined);
  });

  it("结算与原始计量明细一致说明费用未记录且不计入", () => {
    costProjection.total = "0.00000000";
    costProjection.line = null;
    costProjection.status = "EXCLUDED_NO_RECORDED_COST";
    render(<RequestDrilldown requestId="request-1" />);
    expect(screen.getAllByText("未记录费用，不计入")).toHaveLength(2);
    expect(screen.queryByText("未知")).not.toBeInTheDocument();
  });

  // ACE-01（WP4-S2 合同 5）：结算汇总改"API费用估算"；settlement 无行内币种字段 → 回退 ¥。
  it("结算汇总使用 API费用估算 命名并在无币种时回退 ¥", () => {
    render(<RequestDrilldown requestId="request-1" />);
    expect(screen.getByText("API费用估算")).toBeInTheDocument();
    expect(screen.getByText("¥0.00")).toBeInTheDocument();
    expect(screen.queryByText("API 费用")).not.toBeInTheDocument();
  });

  // ACE-02 场景 3＋WP4-S2 合同 5：行内币种字段消费 + 价格依据待核实角标
  // （billing_rule_snapshot.sourceStatus 随结算冻结，旧快照缺省按 UNVERIFIED 解释）。
  it("计量明细与计价决策消费行内币种，UNVERIFIED 显示价格依据待核实", () => {
    costProjection.currency = "USD";
    costProjection.sourceStatus = "UNVERIFIED";
    render(<RequestDrilldown requestId="request-1" />);
    expect(screen.getAllByText(/USD 0.00（价格依据待核实）/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("估算费用")).toBeInTheDocument();
  });

  it("VERIFIED 规则计价的金额不显示价格依据待核实角标", () => {
    costProjection.sourceStatus = "VERIFIED";
    render(<RequestDrilldown requestId="request-1" />);
    expect(screen.queryByText(/价格依据待核实/)).not.toBeInTheDocument();
    expect(screen.getByText(/估算 ¥0.00/)).toBeInTheDocument();
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
