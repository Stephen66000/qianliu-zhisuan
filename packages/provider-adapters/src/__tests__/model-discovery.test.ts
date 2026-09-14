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
