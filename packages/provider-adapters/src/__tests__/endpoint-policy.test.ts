import { describe, expect, it } from "vitest";
import {
  KIMI_API_MODE_DEFAULT_URL,
  KIMI_CODING_PLAN_DEFAULT_URL,
  KIMI_CODING_PLAN_QUOTA_URL,
  ZHIPU_CODING_PLAN_QUOTA_URL,
  resolveProviderEndpoint,
} from "../endpoint-policy.js";
import { canonicalProviderCode } from "../provider-code.js";

/** 计划 13.1：模式化端点与厂商代码矩阵。 */
describe("WP01 Mode-aware Endpoint Policy", () => {
  it("kimi/kimi/Kimi/KIMI 与前后空格进入同一 Kimi 策略", () => {
    for (const code of ["kimi", "Kimi", "KIMI", " Kimi "]) {
      const coding = resolveProviderEndpoint({
        providerCode: code, resourceMode: "CODING_PLAN", operation: "MODEL_PERMISSION_PROBE",
        configuredEndpoints: { base_url: "https://api.moonshot.cn/v1" },
      });
      const api = resolveProviderEndpoint({
        providerCode: code, resourceMode: "API", operation: "CHAT_COMPLETIONS",
        configuredEndpoints: { base_url: "https://api.moonshot.cn/v1" },
      });
      expect(coding.ok).toBe(true);
      expect(api.ok).toBe(true);
      if (coding.ok) expect(coding.url).toBe(KIMI_CODING_PLAN_DEFAULT_URL);
      if (api.ok) expect(api.url).toBe("https://api.moonshot.cn/v1");
    }
    expect(canonicalProviderCode("Kimi")).toBe("kimi");
    expect(canonicalProviderCode("  ZHIPU ")).toBe("zhipu");
    expect(canonicalProviderCode("DeepSeek")).toBe("deepseek");
  });

  it("RC-0：历史 Moonshot base_url 不得覆盖 Kimi Coding Plan 端点", () => {
    const resolved = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "CODING_PLAN", operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: "https://api.moonshot.cn/v1" },
      env: {},
    });
    expect(resolved).toMatchObject({ ok: true, url: KIMI_CODING_PLAN_DEFAULT_URL, scope: "MODE_DEFAULT", host: "api.kimi.com" });
  });

  it("Kimi CODING_PLAN 显式 Coding 端点优先；无任何配置走官方默认", () => {
    const explicit = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "CODING_PLAN", operation: "MODEL_PERMISSION_PROBE",
      configuredEndpoints: { endpoints: { CODING_PLAN: "https://api.kimi.com/coding/v1" } }, env: {},
    });
    expect(explicit).toMatchObject({ ok: true, url: "https://api.kimi.com/coding/v1", scope: "MODE_SCOPED_CONFIG" });
    const fallback = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "CODING_PLAN", operation: "CHAT_COMPLETIONS", env: {},
    });
    expect(fallback).toMatchObject({ ok: true, url: KIMI_CODING_PLAN_DEFAULT_URL, scope: "MODE_DEFAULT" });
  });

  it("Kimi CODING_PLAN 环境变量次之；未知自定义 base_url 歧义失败关闭", () => {
    const envResolved = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "CODING_PLAN", operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: "https://api.moonshot.cn/v1" },
      env: { KIMI_CODING_BASE_URL: "https://mirror.kimi.internal/coding/v1" },
    });
    expect(envResolved).toMatchObject({ ok: true, url: "https://mirror.kimi.internal/coding/v1", scope: "ENV" });
    const ambiguous = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "CODING_PLAN", operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: "https://gateway.corp.example/v1" }, env: {},
    });
    expect(ambiguous).toMatchObject({ ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS", host: "gateway.corp.example" });
  });

  it("Kimi API 业务调用走 Moonshot 平台地址；显式 base_url 继续生效", () => {
    const def = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "API", operation: "CHAT_COMPLETIONS", env: {},
    });
    expect(def).toMatchObject({ ok: true, url: KIMI_API_MODE_DEFAULT_URL, host: "api.moonshot.cn" });
    const custom = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "API", operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: "https://kimi-compat.internal/v1" }, env: {},
    });
    expect(custom).toMatchObject({ ok: true, url: "https://kimi-compat.internal/v1", scope: "LEGACY_BASE_URL" });
    // Coding 地址不能反向充当 API 模式业务地址。
    const reversed = resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "API", operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: "https://api.kimi.com/coding/v1" }, env: {},
    });
    expect(reversed).toMatchObject({ ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS" });
  });

  it("探针、真实验证、凭证恢复与 Gateway 业务调用解析结果一致", () => {
    const operations = ["MODEL_PERMISSION_PROBE", "CHAT_COMPLETIONS", "ANTHROPIC_MESSAGES"] as const;
    const results = operations.map((operation) => resolveProviderEndpoint({
      providerCode: "Kimi", resourceMode: "CODING_PLAN", operation,
      configuredEndpoints: { base_url: "https://api.moonshot.cn/v1" }, env: {},
    }));
    expect(new Set(results.map((r) => (r.ok ? r.url : "ambiguous")))).toEqual(new Set([KIMI_CODING_PLAN_DEFAULT_URL]));
  });

  it("额度同步端点按厂商区分；非 Coding Plan 厂商不支持", () => {
    expect(resolveProviderEndpoint({
      providerCode: "kimi", resourceMode: "CODING_PLAN", operation: "CODING_PLAN_QUOTA", env: {},
    })).toMatchObject({ ok: true, url: KIMI_CODING_PLAN_QUOTA_URL });
    expect(resolveProviderEndpoint({
      providerCode: "zhipu", resourceMode: "CODING_PLAN", operation: "CODING_PLAN_QUOTA", env: {},
    })).toMatchObject({ ok: true, url: ZHIPU_CODING_PLAN_QUOTA_URL });
    expect(resolveProviderEndpoint({
      providerCode: "deepseek", resourceMode: "CODING_PLAN", operation: "CODING_PLAN_QUOTA", env: {},
    })).toMatchObject({ ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS" });
  });

  it("非 Kimi 厂商保持既有行为：显式 base_url > 环境变量 > 默认", () => {
    const explicit = resolveProviderEndpoint({
      providerCode: "qwen", resourceMode: "API", operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: "https://qwen-proxy.internal/v1" }, env: {},
    });
    expect(explicit).toMatchObject({ ok: true, url: "https://qwen-proxy.internal/v1" });
    const envResolved = resolveProviderEndpoint({
      providerCode: "deepseek", resourceMode: "API", operation: "CHAT_COMPLETIONS",
      env: { DEEPSEEK_BASE_URL: "https://ds-mirror.internal" },
    });
    expect(envResolved).toMatchObject({ ok: true, url: "https://ds-mirror.internal", scope: "ENV" });
    const def = resolveProviderEndpoint({
      providerCode: "zhipu", resourceMode: "CODING_PLAN", operation: "CHAT_COMPLETIONS", env: {},
    });
    expect(def).toMatchObject({ ok: true, url: "https://open.bigmodel.cn/api/coding/paas/v4" });
    // 未知厂商无任何配置 → 明确失败，不猜测。
    const unknown = resolveProviderEndpoint({
      providerCode: "MysteryVendor", resourceMode: "API", operation: "CHAT_COMPLETIONS", env: {},
    });
    expect(unknown).toMatchObject({ ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS" });
  });
});
