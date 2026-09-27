import Fastify from "fastify";
import { sendPipelineResponse } from "./pipeline-response.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";
import { describe, expect, it } from "vitest";
import type { Outcome, RequestShapeSummary, UpstreamErrorEvidence } from "@qianliu/contracts";
import { createOpenAiCompatibleCaller, SecretValue } from "@qianliu/provider-adapters";
import {
  attemptDiagnosticUpdate,
  northboundFailurePresentation,
} from "./upstream-error-diagnostic.js";

describe("POOL20-054 safe client image error", () => {
  it("shows explicit image error for a Zhipu Chinese response and preserves its safe code", async () => {
    const caller = createOpenAiCompatibleCaller({ fetch: async () => ({ ok: false, status: 400, text: async () => "", body: null,
      json: async () => ({ error: { code: 1210, message: "该模型不支持图片输入 private-canary" } }) }) });
    const outcome = await caller({ providerCode: "zhipu", upstreamModel: "unknown-model", resourceId: "test",
      mode: "CODING_PLAN", concurrencyLimit: 0, secret: new SecretValue("test-only") },
    { requestId: "test", unifiedModel: "custom-alias", capability: "chat", stream: false,
      body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }] } }, 1);
    const result = northboundFailurePresentation(outcome, "智谱", false);
    expect(result.message).toBe("模型不支持图片");
    expect(result.diagnosticExtension).toMatchObject({ diagnostic: { upstream_code: "1210", category: "MODEL_IMAGE_UNSUPPORTED" } });
    expect(JSON.stringify(result)).not.toContain("private-canary");
    const app = Fastify();
    app.get("/", async (_request, reply) => sendPipelineResponse(
      { reply, capability: "responses", traceId: "trace", requestId: "test", streamWriter: null } as PipelineContext,
      { finalOutcome: outcome, finalOutcomeProviderCode: "zhipu" } as PipelineExecutionState,
    ));
    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: "model_image_unsupported", message: "模型不支持图片", retryable: false,
        diagnostic: { upstream_code: "1210" } });
      expect(response.body).not.toContain("private-canary");
    } finally { await app.close(); }

  });
  it.each(["model_image_unsupported", "image_input_unsupported"])("shows a clear local error for %s", (error) => {
    const result = northboundFailurePresentation({ status: 400, error } as Outcome, "智谱", false);
    expect(result.message).toMatch(/模型不支持图片|图片输入格式不受支持/);
  });
  it("CQA-03 identifies Responses input when image conversion is unsupported", async () => {
    const app = Fastify();
    app.get("/", async (_request, reply) => sendPipelineResponse(
      { reply, capability: "responses", traceId: "trace", requestId: "test", streamWriter: null } as PipelineContext,
      { finalOutcome: { status: 400, error: "image_input_unsupported" }, finalOutcomeProviderCode: "zhipu" } as PipelineExecutionState,
    ));
    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: "image_input_unsupported", param: "input", retryable: false });
    } finally { await app.close(); }
  });

});

const safeShape: RequestShapeSummary = {
  topLevelFields: ["messages", "model"], messageCount: 1, messageRoles: { user: 1 },
  contentKinds: ["string"], contentBlockTypes: [], assistantToolCallCount: 0,
  toolResultCount: 0, unmatchedAssistantToolCallCount: 0, unmatchedToolResultCount: 0,
  toolCount: 0, functionToolCount: 0, invalidToolCount: 0, toolSchemaIssueCounts: {},
  toolTypes: [], schemaKeywords: [], schemaMaxDepth: 0, schemaNodeCount: 0,
  schemaPropertyCount: 0, toolChoiceKind: null, stream: false,
  streamOptionsIncluded: false, countOverflowed: false,
};

describe("attemptDiagnosticUpdate", () => {
  it("保留 401 脱敏诊断证据供请求账本审计", () => {
    const evidence: UpstreamErrorEvidence = {
      httpStatus: 401, type: "authentication_error", code: "expired_token", param: null,
      messageCategory: "CREDENTIAL_EXPIRED", diagnosticHash: "a".repeat(64),
    };
    expect(attemptDiagnosticUpdate({
      status: 401, committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      upstreamErrorEvidence: evidence, requestShapeSummary: safeShape,
    })).toEqual({ upstream_error_evidence: evidence, request_shape_summary: safeShape });
  });
});

describe("统一 300 秒空闲超时北向错误合同", () => {
  const idleTimeoutOutcome: Outcome = {
    status: 504,
    committed: false,
    error: "upstream_timeout",
    failureLayer: "STREAM_IDLE_TIMEOUT",
    usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
  };

  it("仅 STREAM_IDLE_TIMEOUT 返回统一中文提示（未提交 HTTP 504 路径）", async () => {
    const app = Fastify();
    app.post("/", async (_request, reply) => sendPipelineResponse(
      { reply, capability: "chat", traceId: "trace", requestId: "ai-req-1", streamWriter: null } as PipelineContext,
      { finalOutcome: idleTimeoutOutcome, finalOutcomeProviderCode: "deepseek" } as PipelineExecutionState,
    ));
    try {
      const response = await app.inject({ method: "POST", url: "/" });
      expect(response.statusCode).toBe(504);
      expect(response.json().error).toMatchObject({
        message: "上游模型响应中断，等待超时。请稍后重试，或切换其他模型。",
        code: "upstream_timeout",
        failure_layer: "STREAM_IDLE_TIMEOUT",
        request_id: "ai-req-1",
      });
    } finally { await app.close(); }
  });

  it.each([
    ["FIRST_BYTE_TIMEOUT", "upstream_timeout"],
    ["REQUEST_TIMEOUT", "upstream_timeout"],
  ] as const)("其他超时失败层 %s 不套用空闲超时提示", async (failureLayer, error) => {
    const result = northboundFailurePresentation({
      status: 504, committed: false, error, failureLayer,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
    } as Outcome, "DeepSeek ", false);
    expect(result.message).not.toBe("上游模型响应中断，等待超时。请稍后重试，或切换其他模型。");
  });

  it("已提交流内错误同样携带统一提示与真实请求 ID", () => {
    const result = northboundFailurePresentation({
      ...idleTimeoutOutcome,
      committed: true,
    }, "DeepSeek ", false);
    expect(result.message).toBe("上游模型响应中断，等待超时。请稍后重试，或切换其他模型。");
  });
});
