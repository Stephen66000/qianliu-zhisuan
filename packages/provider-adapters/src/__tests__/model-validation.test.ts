import { describe, expect, it, vi } from "vitest";
import { validateProviderModel } from "../model-validation.js";
import type { HttpFetch } from "../openai-compatible-types.js";

async function* streamBody() {
  yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  yield new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n');
  yield new TextEncoder().encode("data: [DONE]\n\n");
}

describe("W-MD-05 真实模型验证调用合同", () => {
  it("GLM-5.3 验证执行非流式、流式和工具三项，并只发送 max 思考策略", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn<HttpFetch>(async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      if (body.stream) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => "", body: streamBody() };
      }
      const message = Array.isArray(body.tools) ? {
        role: "assistant", content: null,
        tool_calls: [{ id: "call-validation", type: "function", function: { name: "qianliu_validation_echo", arguments: '{"value":"ok"}' } }],
      } : { role: "assistant", content: "ok" };
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ model: "glm-5.3", choices: [{ message }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        text: async () => "", body: null,
      };
    });
    const result = await validateProviderModel({
      providerCode: "zhipu", mode: "CODING_PLAN", resourceId: "resource-1", upstreamModel: "glm-5.3",
      credential: "secret", reasoningEffort: "max", runToolCheck: true,
      fetch, env: { ZHIPU_CODING_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4" },
      requestId: "mdv-test",
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.checks.map((check) => check.kind)).toEqual(["NON_STREAM", "STREAM", "TOOL"]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.model === "glm-5.3")).toBe(true);
    expect(requests.every((request) => request.reasoning_effort === "max")).toBe(true);
    expect(requests.every((request) => JSON.stringify(request).includes("thinking.type=disabled") === false)).toBe(true);
  });

  it("上游 401 只保存稳定错误码，不保存正文或凭证", async () => {
    const fetch = vi.fn<HttpFetch>(async () => ({
      ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: "secret upstream body" }),
      text: async () => "secret upstream body", body: null,
    }));
    const result = await validateProviderModel({
      providerCode: "zhipu", mode: "CODING_PLAN", resourceId: "resource-1", upstreamModel: "glm-5.3",
      credential: "super-secret", reasoningEffort: "max", runToolCheck: false, fetch,
      env: { ZHIPU_CODING_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4" },
    });
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("upstream_http_401");
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("secret upstream body");
  });
});
