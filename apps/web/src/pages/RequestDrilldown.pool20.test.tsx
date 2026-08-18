import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestDrilldown } from "./RequestDrilldown";

vi.mock("../api/hooks", () => ({
  useGatewayRequest: () => ({
    isLoading: false, error: null, refetch: vi.fn(),
    data: {
      request: {
        id: "request-1", principalId: "principal-1", protocol: "chat", unifiedModel: "ql-glm",
        stream: false, status: "FAILED", clientId: null, startedAt: "2026-08-18T06:00:00.000Z",
        finishedAt: "2026-08-18T06:00:00.010Z", errorClassification: "dispatch_rejected",
        errorCode: "dispatch_rejected",
      },
      settlement: null,
    },
  }),
  useRouteCandidates: () => ({ isLoading: false, data: { candidates: [] } }),
  useAttempts: () => ({ isLoading: false, data: { attempts: [], ledgerLines: [] } }),
  useDispatchDecision: () => ({
    isLoading: false,
    data: { decision: {
      dispatchInput: {
        policyWindow: "工作日 14:00-18:00 Asia/Shanghai",
        policyResetAt: "2026-08-18T10:00:00.000Z",
      },
      finalAction: "REJECT", reasonCode: "REJECTED", reasonDetail: null,
      matchedPolicyId: "policy-1", matchedPolicyVersion: "peak-v1", matchedPolicyAction: "REJECT",
      switchTargetResourceId: null, counterfactualCost: null, actualCost: null,
      dispatchSaving: null, savingCalculable: false,
      notCalculableReason: "dispatch_terminated_before_attempt",
    } },
  }),
}));

describe("POOL20-030 拒绝证据", () => {
  it("用业务提示展示策略时段、重置时间和零 Attempt/Usage/扣费", () => {
    render(<RequestDrilldown requestId="request-1" />);
    expect(screen.getByText("高峰时段暂停使用；Attempt 0 · 无 Usage · 无额度扣减 · 无 API 费用")).toBeInTheDocument();
    expect(screen.getByText("工作日 14:00-18:00 Asia/Shanghai")).toBeInTheDocument();
    expect(screen.getByText("2026-08-18T10:00:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("无尝试记录")).toBeInTheDocument();
  });
});
