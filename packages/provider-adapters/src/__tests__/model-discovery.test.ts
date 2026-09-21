import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  builtinProviderModelDiscovery,
  clearProviderModelDiscoveryCache,
  discoverProviderModels,
} from "../model-discovery.js";
import type { ProviderModelDiscoveryError } from "../model-discovery.js";
import type { DiscoveryFetch } from "../model-discovery-contract.js";

function apiResponse(payload: unknown, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers, json: async () => payload };
}

function docResponse(text: string, url?: string, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers, url, text: async () => text };
}

const zhipuCore = `
| 模型 ID | context | output | thinking |
| \`glm-5.2\` | 256K | 128K | 始终思考 |
| \`glm-5.3\` | 1M | 128K | low / high / max |
<script>glm-99.9 should never be read</script>
`;

describe("W-MD 官方来源模型发现", () => {
  beforeEach(() => clearProviderModelDiscoveryCache());

  it("DeepSeek/Kimi API 继续只归一化正式 List Models，并过滤不兼容模型", async () => {
    const fetch = vi.fn(async () => apiResponse({ data: [{ id: "deepseek-v4-pro" }, { id: "embedding-3" }] }));
    const result = await discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret", fetch,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret" }), redirect: "error",
    }));
    expect(result.source).toBe("PROVIDER_API");
    expect(result.models).toEqual([
      expect.objectContaining({ id: "deepseek-v4-pro", compatible: true }),
      expect.objectContaining({ id: "embedding-3", compatible: false }),
    ]);
    expect(result.sourceContentHash).toMatch(/^sha256:/);
  });

  it("Qwen 官方预设自动匹配 DashScope 兼容接口并自动过滤非千问模型", async () => {
    const fetch = vi.fn(async () => apiResponse({ data: [
      { id: "qwen-plus" },
      { id: "qwen-max" },
      { id: "llama-3-70b-instruct" },
      { id: "text-embedding-v3" },
    ] }));
    const result = await discoverProviderModels({
      providerCode: "Qwen", mode: "API", credential: "qwen-secret", fetch,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(fetch).toHaveBeenCalledWith("https://dashscope.aliyuncs.com/compatible-mode/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer qwen-secret" }), redirect: "error",
    }));
    expect(result.source).toBe("PROVIDER_API");
    expect(result.models.map((m) => m.id)).toEqual(["qwen-max", "qwen-plus"]);
    expect(result.models.every((m) => m.compatible)).toBe(true);
  });

  it("自定义 Base URL 能够动态解析 models 端点", async () => {
    const fetch = vi.fn(async () => apiResponse({ data: [{ id: "custom-chat" }] }));
    const result = await discoverProviderModels({
      providerCode: "MyCustom", mode: "API", credential: "custom-secret",
      baseUrl: "https://my-gateway.internal/v1",
      fetch,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(fetch).toHaveBeenCalledWith("https://my-gateway.internal/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer custom-secret" }), redirect: "error",
    }));
    expect(result.models).toEqual([
      expect.objectContaining({ id: "custom-chat", compatible: true }),
    ]);
  });

  it("智谱核心官方页发现 GLM-5.3，保存字段 Evidence 和 [1m] 客户端变体", async () => {
    const fetch = vi.fn(async (url: string) => docResponse(zhipuCore, url, { etag: "zhipu-v1" }));
    const result = await discoverProviderModels({
      providerCode: "zhipu", mode: "CODING_PLAN", credential: "secret", fetch,
      officialSourceOverrides: { "zhipu:CODING_PLAN": { coreUrl: "https://docs.bigmodel.cn/test", supplementalUrls: [] } },
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ source: "OFFICIAL_DOCUMENTATION", parserVersion: "zhipu-docs-v1", sourceEtag: "zhipu-v1" });
    expect(result.models.map((model) => model.id)).toEqual(["glm-5.2", "glm-5.3"]);
    const glm53 = result.models.find((model) => model.id === "glm-5.3")!;
    expect(glm53.facts).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(glm53.facts.reasoning?.levels).toEqual(["low", "high", "max"]);
    expect(glm53.facts.clientVariants).toEqual([expect.objectContaining({ model: "glm-5.3[1m]", canonicalModel: "glm-5.3" })]);
    expect(glm53.facts.fieldEvidence.context_window?.[0]?.url).toBe("https://docs.bigmodel.cn/test");
    expect(result.models.some((model) => model.id === "glm-99.9")).toBe(false);
  });

  it("llms.txt 失败不影响核心页，核心页格式可独立工作", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("llms.txt")
      ? { ok: false, status: 503, text: async () => "" }
      : docResponse(zhipuCore, url));
    const result = await discoverProviderModels({
      providerCode: "zhipu", mode: "CODING_PLAN", credential: "secret", fetch,
      officialSourceOverrides: { "zhipu:CODING_PLAN": { coreUrl: "https://docs.bigmodel.cn/core", supplementalUrls: ["https://docs.bigmodel.cn/llms.txt"] } },
    });
    expect(result.models.map((model) => model.id)).toContain("glm-5.3");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("HTML 官方核心页允许受控 4 MiB 上限，文本补充源仍保持 512 KiB 上限", async () => {
    const fetch = vi.fn(async (url: string) => docResponse(
      zhipuCore,
      url,
      { "content-type": "text/html; charset=utf-8", "content-length": "600000" },
    ));
    const result = await discoverProviderModels({
      providerCode: "zhipu", mode: "CODING_PLAN", credential: "secret", fetch,
      officialSourceOverrides: { "zhipu:CODING_PLAN": { coreUrl: "https://docs.bigmodel.cn/test", supplementalUrls: [] } },
    });
    expect(result.models.map((model) => model.id)).toContain("glm-5.3");
  });

  it("Kimi Code 官方模型页解析四个 Model ID，不把 Coding Plan Key 发给开放平台", async () => {
    const fetch = vi.fn(async (url: string) => docResponse(`
      Model ID | \`k3\` | \`k3-256k\` | \`kimi-for-coding\` | \`kimi-for-coding-highspeed\`
      上下文窗口 | 1M | 256k | 256k | 256k
    `, url));
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "coding-plan-secret", fetch,
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ source: "OFFICIAL_DOCUMENTATION", parserVersion: "kimi-code-models-v1" });
    expect(result.models.map((model) => model.id)).toEqual(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]);
  });

  it("开启 probePermissions 时自动向候选模型发探针，403 超纲模型被自动置为不可用", async () => {
    const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        if (body.model === "k3-256k") {
          return {
            ok: false,
            status: 403,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ error: { code: "permission_denied", message: "Model not accessible" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chat-1",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        };
      }
      return docResponse(`
        Model ID | \`k3\` | \`k3-256k\`
        上下文窗口 | 1M | 256k
      `, url);
    });
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "coding-plan-secret", fetch: fetch as unknown as DiscoveryFetch,
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
      probePermissions: true,
    });
    const k3 = result.models.find((m) => m.id === "k3");
    const k3256k = result.models.find((m) => m.id === "k3-256k");
    expect(k3?.compatible).toBe(true);
    expect(k3?.unavailableReason).toBeNull();
    expect(k3256k?.compatible).toBe(false);
    expect(k3256k?.unavailableReason).toContain("HTTP 403");
    expect(k3256k?.credentialValidation).toMatchObject({ status: "PLAN_NOT_ENTITLED", httpStatus: 403, retryable: false });
  });

  it("WP04：探针请求固定最小形状（max_tokens=8），K3 系列附加 reasoning_effort=low", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        bodies.push(body);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chat-1", object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        };
      }
      return docResponse(`
        Model ID | \`k3\` | \`kimi-for-coding\`
        上下文窗口 | 1M | 256k
      `, url);
    });
    await discoverProviderModels({
      providerCode: "Kimi", mode: "CODING_PLAN", credential: "coding-plan-secret", fetch: fetch as unknown as DiscoveryFetch,
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
      probePermissions: true,
    });
    expect(bodies.length).toBe(2);
    for (const body of bodies) {
      expect(body.max_tokens).toBe(8);
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    }
    expect(bodies.find((b) => b.model === "k3")?.reasoning_effort).toBe("low");
    expect(bodies.find((b) => b.model === "kimi-for-coding")?.reasoning_effort).toBeUndefined();
  });

  it.each([
    { status: 400, expected: "REQUEST_REJECTED" },
    { status: 401, expected: "AUTH_FAILED" },
    { status: 429, expected: "RATE_LIMITED" },
    { status: 500, expected: "UPSTREAM_UNAVAILABLE" },
    { status: 503, expected: "UPSTREAM_UNAVAILABLE" },
  ])("WP04：探针 HTTP $status 映射为 $expected 且不原谅为兼容", async ({ status, expected }) => {
    const fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: false, status,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: { code: "upstream_error", message: "must-not-leak" } }),
        };
      }
      return docResponse("Model ID | `k3`\n上下文窗口 | 1M", url);
    });
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "secret", fetch: fetch as unknown as DiscoveryFetch,
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
      probePermissions: true,
    });
    const k3 = result.models.find((m) => m.id === "k3")!;
    expect(k3.compatible).toBe(false);
    expect(k3.credentialValidation).toMatchObject({ status: expected });
    expect(k3.unavailableReason).toBeTruthy();
  });

  it("WP04：探针超时/网络失败标记可重试状态，不再被原谅为兼容", async () => {
    const fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw new Error("network unreachable");
      return docResponse("Model ID | `k3` | `kimi-for-coding`\n上下文窗口 | 1M | 256k", url);
    });
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "secret", fetch: fetch as unknown as DiscoveryFetch,
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
      probePermissions: true,
    });
    for (const model of result.models) {
      expect(model.compatible).toBe(false);
      expect(model.credentialValidation).toMatchObject({ status: "NETWORK_FAILED", retryable: true });
    }
  });

  it("WP05：k3-256k 探针 2xx 时与其它模型一样可选，不再被无条件排除", async () => {
    const fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true, status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chat-1", object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        };
      }
      return docResponse("Model ID | `k3` | `k3-256k`\n上下文窗口 | 1M | 256k", url);
    });
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "secret", fetch: fetch as unknown as DiscoveryFetch,
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
      probePermissions: true,
    });
    expect(result.models.find((m) => m.id === "k3-256k")?.credentialValidation)
      .toMatchObject({ status: "READY", httpStatus: 200 });
  });

  it("WP01/RC-0：探针请求发往 Kimi Coding 端点，不被 Moonshot base_url 覆盖", async () => {
    const postedUrls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        postedUrls.push(url);
        return {
          ok: true, status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            id: "chat-1", object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        };
      }
      return docResponse("Model ID | `k3`\n上下文窗口 | 1M", url);
    });
    await discoverProviderModels({
      providerCode: "Kimi", mode: "CODING_PLAN", credential: "coding-plan-secret", fetch: fetch as unknown as DiscoveryFetch,
      baseUrl: "https://api.moonshot.cn/v1",
      officialSourceOverrides: { "kimi:CODING_PLAN": { coreUrl: "https://www.kimi.com/test", supplementalUrls: [] } },
      probePermissions: true,
    });
    expect(postedUrls.length).toBeGreaterThan(0);
    for (const url of postedUrls) {
      expect(url.startsWith("https://api.kimi.com/coding/v1")).toBe(true);
      expect(url.startsWith("https://api.moonshot.cn")).toBe(false);
    }
  });

  it("普通正文、实验语境和冲突语境拒绝，不静默采用", async () => {
    const fetch = vi.fn(async (url: string) => docResponse("The next model glm-5.3 may be experimental only.", url));
    await expect(discoverProviderModels({
      providerCode: "zhipu", mode: "CODING_PLAN", credential: "secret", fetch,
      officialSourceOverrides: { "zhipu:CODING_PLAN": { coreUrl: "https://docs.bigmodel.cn/test", supplementalUrls: [] } },
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({ code: "OFFICIAL_SOURCE_AMBIGUOUS", parserVersion: "zhipu-docs-v1" }));
  });

  it("URL 覆盖仍受 HTTPS 官方域名白名单约束", async () => {
    const fetch = vi.fn();
    await expect(discoverProviderModels({
      providerCode: "zhipu", mode: "CODING_PLAN", credential: "secret", fetch,
      officialSourceOverrides: { "zhipu:CODING_PLAN": { coreUrl: "https://evil.example/models", supplementalUrls: [] } },
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({ code: "OFFICIAL_SOURCE_UNAVAILABLE" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 429, code: "RATE_LIMITED" as const },
    { status: 503, code: "UPSTREAM_UNAVAILABLE" as const },
  ])("List Models HTTP $status 稳定映射为 $code", async ({ status, code }) => {
    await expect(discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret",
      fetch: async () => ({ ok: false, status, json: async () => ({ raw: "must-not-leak" }) }),
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({ code }));
  });

  it("60 秒缓存/singleflight 只执行一轮目录和版本读取，且响应标记 reused", async () => {
    let calls = 0;
    const fetch = vi.fn(async (_url: string) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return apiResponse({ data: [{ id: "deepseek-chat" }] });
    });
    const [first, second] = await Promise.all([
      discoverProviderModels({ providerCode: "deepseek", mode: "API", credential: "secret", fetch, cacheKey: "enterprise:resource" }),
      discoverProviderModels({ providerCode: "deepseek", mode: "API", credential: "secret", fetch, cacheKey: "enterprise:resource" }),
    ]);
    expect(calls).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => url === "https://api.deepseek.com/models")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url === "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/")).toHaveLength(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
  });

  it("保留内置目录作为首次离线兜底，但标记过期且不产生 VERSIONED_CATALOG 新结果", () => {
    const fallback = builtinProviderModelDiscovery({ providerCode: "zhipu", mode: "CODING_PLAN" });
    expect(fallback).toMatchObject({ source: "BUILTIN_FALLBACK", stale: true });
    expect(fallback?.models.map((model) => model.id)).toContain("glm-5.2");
  });
});
