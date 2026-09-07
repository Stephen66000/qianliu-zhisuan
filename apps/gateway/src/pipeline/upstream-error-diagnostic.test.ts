import Fastify from "fastify";
import { sendPipelineResponse } from "./pipeline-response.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";
import { describe, expect, it } from "vitest";
import type { Outcome } from "@qianliu/contracts";
import { createOpenAiCompatibleCaller, SecretValue } from "@qianliu/provider-adapters";
import { northboundFailurePresentation } from "./upstream-error-diagnostic.js";

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
