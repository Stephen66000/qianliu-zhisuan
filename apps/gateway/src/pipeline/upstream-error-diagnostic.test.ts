import { describe, expect, it } from "vitest";
import type { Outcome, RequestShapeSummary, UpstreamErrorEvidence } from "@qianliu/contracts";

import { attemptDiagnosticUpdate } from "./upstream-error-diagnostic.js";

const safeShape: RequestShapeSummary = {
  topLevelFields: ["messages", "model"],
  messageCount: 1,
  messageRoles: { user: 1 },
  contentKinds: ["string"],
  contentBlockTypes: [],
  assistantToolCallCount: 0,
  toolResultCount: 0,
  unmatchedAssistantToolCallCount: 0,
  unmatchedToolResultCount: 0,
  toolCount: 0,
  functionToolCount: 0,
  invalidToolCount: 0,
  toolSchemaIssueCounts: {},
  toolTypes: [],
  schemaKeywords: [],
  schemaMaxDepth: 0,
  schemaNodeCount: 0,
  schemaPropertyCount: 0,
  toolChoiceKind: null,
  stream: false,
  streamOptionsIncluded: false,
  countOverflowed: false,
};

describe("attemptDiagnosticUpdate", () => {
  it("保留 401 脱敏诊断证据供请求账本审计", () => {
    const evidence: UpstreamErrorEvidence = {
      httpStatus: 401,
      type: "authentication_error",
      code: "expired_token",
      param: null,
      messageCategory: "CREDENTIAL_EXPIRED",
      diagnosticHash: "a".repeat(64),
    };
    expect(attemptDiagnosticUpdate({
      status: 401,
      committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      upstreamErrorEvidence: evidence,
      requestShapeSummary: safeShape,
    } as Outcome)).toEqual({
      upstream_error_evidence: evidence,
      request_shape_summary: safeShape,
    });
  });
});
