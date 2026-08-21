import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestDrilldown } from "./RequestDrilldown";

const state = vi.hoisted(() => ({ withEvidence: true }));
const CANARY = "POOL048_PRIVATE_WEB_CANARY";

vi.mock("../api/hooks", () => ({
  useGatewayRequest: () => ({
    isLoading: false, error: null, refetch: vi.fn(),
    data: {
      request: {
        id: "request-048", principalId: "principal-1", protocol: "chat",
        unifiedModel: "ql-deepseek-v4-flash", stream: true, status: "FAILED",
        clientId: "WorkBuddy/5.3.14", startedAt: "2026-08-21T09:31:46.000Z",
        finishedAt: "2026-08-21T09:31:47.000Z",
        errorClassification: "CLIENT_INVALID", errorCode: "invalid_request_error",
      },
      settlement: {
        totalInputTokens: "0", totalOutputTokens: "0", totalCacheTokens: "0",
        totalReasoningTokens: "0", totalDeductedQuota: "0", totalApiCost: "0.00000000",
        usageQuality: "UNKNOWN", attemptCount: 1, status: "SETTLED",
      },
    },
  }),
  useRouteCandidates: () => ({ isLoading: false, data: { candidates: [] } }),
  useAttempts: () => ({
    isLoading: false,
    data: {
      attempts: [{
        attemptNo: 1, providerResourceId: "resource-1", upstreamModel: "deepseek-v4-flash",
        startedAt: "2026-08-21T09:31:46.000Z", firstByteAt: null,
        finishedAt: "2026-08-21T09:31:47.000Z", httpStatus: 400,
        errorClassification: "CLIENT_INVALID", errorCode: "invalid_request_error",
        failureLayer: "UPSTREAM_HTTP", responseCommitted: false, switchReason: null,
        upstreamErrorEvidence: state.withEvidence ? {
          httpStatus: 400, type: "invalid_request_error", code: "invalid_request_error",
          param: "tools[].function.parameters.properties.*",
          messageCategory: "INVALID_TOOL_SCHEMA", diagnosticHash: "3".repeat(64),
        } : null,
        requestShapeSummary: state.withEvidence ? {
          topLevelFields: ["messages", "model", "stream", "stream_options", "tools"],
          messageCount: 3, messageRoles: { system: 1, user: 2 }, contentKinds: ["string"],
          contentBlockTypes: [], assistantToolCallCount: 0, toolResultCount: 0,
          unmatchedAssistantToolCallCount: 0, unmatchedToolResultCount: 0,
          toolCount: 2, functionToolCount: 2, invalidToolCount: 1,
          toolSchemaIssueCounts: { FUNCTION_NAME_INVALID: 1 },
          toolTypes: ["function"], schemaKeywords: ["properties", "required", "type"],
          schemaMaxDepth: 4, schemaNodeCount: 12, schemaPropertyCount: 5,
          toolChoiceKind: "auto", stream: true, streamOptionsIncluded: true,
          countOverflowed: false,
        } : null,
        metering: [],
      }],
      ledgerLines: [],
    },
  }),
  useDispatchDecision: () => ({ isLoading: false, data: { decision: null } }),
}));

describe("POOL20-048 请求下钻脱敏诊断", () => {
  beforeEach(() => {
    state.withEvidence = true;
  });

  it("展示 category/type/code/param/hash 和固定结构 issue，不显示正文", () => {
    const { container } = render(<RequestDrilldown requestId="request-048" />);
    expect(screen.getByText(/工具 Schema 不兼容/)).toBeInTheDocument();
    expect(screen.getByText(/type invalid_request_error/)).toBeInTheDocument();
    expect(screen.getByText(/code invalid_request_error/)).toBeInTheDocument();
    expect(screen.getByText(/字段 tools\[\]\.function\.parameters\.properties\.\*/)).toBeInTheDocument();
    expect(screen.getByText(/诊断 333333333333/)).toBeInTheDocument();
    expect(screen.getByText(/FUNCTION_NAME_INVALID:1/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(CANARY);
  });

  it("历史 null 证据不新增诊断块", () => {
    state.withEvidence = false;
    render(<RequestDrilldown requestId="request-048" />);
    expect(screen.queryByText(/上游拒绝/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Schema 问题/)).not.toBeInTheDocument();
  });
});
