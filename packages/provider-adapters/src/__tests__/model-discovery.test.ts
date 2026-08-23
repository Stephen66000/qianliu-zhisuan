import { describe, expect, it, vi } from "vitest";
import { discoverProviderModels } from "../model-discovery.js";
import type { ProviderModelDiscoveryError } from "../model-discovery.js";

describe("POOL-027 厂商模型发现", () => {
  it("DeepSeek/Kimi 只归一化服务端列表，并过滤不兼容模型", async () => {
    const fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "deepseek-v4-pro" }, { id: "embedding-3" }] }),
    }));
    const result = await discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret", fetch,
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
    expect(result.models).toEqual([
      expect.objectContaining({ id: "deepseek-v4-pro", compatible: true }),
      expect.objectContaining({ id: "embedding-3", compatible: false }),
    ]);
  });

  it("智谱 Coding Plan 使用版本化子集，不混入 API 向量模型", async () => {
    const result = await discoverProviderModels({
      providerCode: "zhipu", mode: "CODING_PLAN", credential: "secret",
    });
    expect(result.source).toBe("VERSIONED_CATALOG");
    expect(result.models.every((model) => model.modelType === "CHAT")).toBe(true);
    expect(result.models.map((model) => model.id)).toContain("glm-5.2");
  });

  it("Kimi Coding Plan 使用官方版本化目录，不把订阅 Key 发往开放平台", async () => {
    const fetch = vi.fn();
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "coding-plan-secret", fetch,
      now: new Date("2026-08-03T11:40:00.000Z"),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      source: "VERSIONED_CATALOG",
      sourceVersion: "kimi-coding-plan-2026-08-03",
    });
    expect(result.models.map((model) => model.id)).toEqual([
      "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed",
    ]);
  });

  it("Kimi API 资源仍使用开放平台 List Models", async () => {
    const fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ data: [{ id: "kimi-k2.6" }] }),
    }));
    const result = await discoverProviderModels({
      providerCode: "kimi", mode: "API", credential: "platform-secret", fetch,
    });
    expect(fetch).toHaveBeenCalledWith("https://api.moonshot.cn/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer platform-secret" }),
    }));
    expect(result).toMatchObject({ source: "PROVIDER_API", sourceVersion: "kimi-list-models-v1" });
  });

  it("401 只返回脱敏错误分类", async () => {
    const promise = discoverProviderModels({
      providerCode: "kimi", mode: "API", credential: "secret",
      fetch: async () => ({ ok: false, status: 401, json: async () => ({ raw: "must-not-leak" }) }),
    });
    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({
      code: "UNAUTHORIZED",
    }));
    await expect(promise).rejects.not.toThrow(/must-not-leak|secret/);
  });

  it.each([
    { status: 429, code: "RATE_LIMITED" },
    { status: 503, code: "UPSTREAM_UNAVAILABLE" },
  ] as const)("将厂商 HTTP $status 稳定映射为 $code", async ({ status, code }) => {
    await expect(discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret",
      fetch: async () => ({ ok: false, status, json: async () => ({}) }),
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({ code }));
  });

  it.each([
    { payload: {}, label: "缺少 data" },
    { payload: { data: [{ id: " " }, null, { id: 7 }] }, label: "没有有效模型 ID" },
  ])("拒绝厂商无效响应：$label", async ({ payload }) => {
    await expect(discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret",
      fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({
      code: "INVALID_RESPONSE",
    }));
  });

  it("将网络异常归类为上游不可用，并识别不兼容的生成类模型", async () => {
    await expect(discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret",
      fetch: async () => { throw new Error("socket closed"); },
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderModelDiscoveryError>>({
      code: "UPSTREAM_UNAVAILABLE",
    }));

    const result = await discoverProviderModels({
      providerCode: "deepseek", mode: "API", credential: "secret",
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({ data: [
          { id: "vision-gen-v1" },
          { id: "deepseek-v4-flash-vision-exp" },
          { id: "chat-v1" },
          { id: "chat-v1" },
        ] }),
      }),
    });
    expect(result.models).toEqual([
      expect.objectContaining({ id: "chat-v1", compatible: true }),
      expect.objectContaining({
        id: "deepseek-v4-flash-vision-exp",
        modelType: "CHAT",
        capabilities: ["chat", "stream", "vision"],
        compatible: true,
      }),
      expect.objectContaining({ id: "vision-gen-v1", modelType: "IMAGE", compatible: false }),
    ]);
  });
});
