import { describe, it, expect } from "vitest";
import {
  CONTRACTS_VERSION,
  NORTHBOUND_ENDPOINTS,
  CAPABILITY_MATRIX,
  UNSUPPORTED_POST_PATHS,
  parseUpstreamErrorEvidence,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ErrorEnvelope,
} from "../index.js";

describe("@qianliu/contracts baseline", () => {
  it("exposes version", () => {
    expect(CONTRACTS_VERSION).toBe("0.3.0");
  });

  it("北向对外端点包含官方 Codex Responses", () => {
    expect(NORTHBOUND_ENDPOINTS).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/messages",
      "POST /v1/responses",
    ]);
  });

  it("W23：协议能力矩阵冻结——启用集与拒绝集稳定，单一事实源", () => {
    // 原生：models + chat/messages 非流式/流式
    const native = CAPABILITY_MATRIX.filter((c) => c.support === "NATIVE");
    expect(native.map((c) => c.endpoint)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/chat/completions#stream",
      "POST /v1/messages",
      "POST /v1/messages#stream",
    ]);
    expect(CAPABILITY_MATRIX.filter((c) => c.support === "TRANSFORMED")).toEqual([
      { endpoint: "POST /v1/responses", support: "TRANSFORMED" },
      { endpoint: "POST /v1/responses#stream", support: "TRANSFORMED" },
    ]);
    // 拒绝（UNSUPPORTED）：Embeddings/count_tokens(POST) + WebSocket
    const unsupported = CAPABILITY_MATRIX.filter((c) => c.support === "UNSUPPORTED");
    expect(unsupported.length).toBe(3);
    // POST 拒绝路径派生正确（gateway unsupported 路由用）
    expect(UNSUPPORTED_POST_PATHS).toEqual([
      "/v1/embeddings",
      "/v1/messages/count_tokens",
    ]);
  });

  it("POOL20-048：400 envelope 只允许脱敏诊断扩展", () => {
    const envelope: ErrorEnvelope = {
      error: {
        message: "上游拒绝请求：INVALID_TOOL_SCHEMA；诊断 0123456789ab",
        type: "invalid_request_error",
        code: "invalid_request_error",
        param: null,
        retryable: false,
        diagnostic: {
          category: "INVALID_TOOL_SCHEMA",
          upstream_type: "invalid_request_error",
          upstream_code: "invalid_request_error",
          param: null,
          hash: "0".repeat(64),
          request_issues: [],
        },
      },
    };
    expect(envelope.error.diagnostic?.category).toBe("INVALID_TOOL_SCHEMA");
    expect(parseUpstreamErrorEvidence({
      httpStatus: 429, type: "rate_limit_error", code: "rate_limit_exceeded",
      param: null, messageCategory: "UNCLASSIFIED", diagnosticHash: "0".repeat(64),
    })).toBeNull();
    expect(parseUpstreamErrorEvidence({
      httpStatus: 401, type: "authentication_error", code: "expired_token",
      param: null, messageCategory: "CREDENTIAL_EXPIRED", diagnosticHash: "1".repeat(64),
    })).toMatchObject({ httpStatus: 401, code: "expired_token" });
  });

  it("OpenAI-compatible Chat 合同覆盖推理字段、工具调用及顶层控制字段", () => {
    const request: ChatCompletionRequest = {
      model: "ql-deepseek-v4-flash",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      thinking: { type: "enabled", clear_thinking: false },
      tool_stream: false,
      messages: [{
        role: "assistant",
        content: null,
        reasoning_content: "reasoning",
        reasoning_details: [{ type: "reasoning.summary" }],
        reasoning: { trace: "native" },
        tool_calls: [{ id: "call_1" }],
      }, { role: "tool", content: "ok", tool_call_id: "call_1" }],
    };
    const response: ChatCompletionResponse = {
      id: "chatcmpl-contract",
      object: "chat.completion",
      created: 1,
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "reasoning",
          tool_calls: [{ id: "call_2" }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const chunk: ChatCompletionChunk = {
      id: "chatcmpl-contract",
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [{
        index: 0,
        delta: { reasoning_content: "reasoning", tool_calls: [{ id: "call_2" }] },
        finish_reason: "tool_calls",
      }],
      usage: null,
    };

    expect(request.tool_stream).toBe(false);
    expect(response.choices[0]?.message.reasoning_content).toBe("reasoning");
    expect(chunk.choices[0]?.delta.reasoning_content).toBe("reasoning");
  });
});
