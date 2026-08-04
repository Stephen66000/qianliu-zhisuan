import { describe, expect, it } from "vitest";
import { SecretValue, type AdapterResource } from "@qianliu/provider-adapters";
import { createFirstByteTimeoutPolicy } from "./upstream-timeout-policy.js";

function resource(
  providerCode: AdapterResource["providerCode"],
  mode: AdapterResource["mode"],
): AdapterResource {
  return {
    providerCode,
    mode,
    resourceId: `${providerCode}-${mode}`,
    upstreamModel: "test-model",
    concurrencyLimit: 1,
    secret: new SecretValue("test-secret"),
  };
}

describe("Gateway 首字节超时策略", () => {
  it("默认仅将 Kimi 提高到 120 秒，DeepSeek 与智谱保持 30 秒", () => {
    const policy = createFirstByteTimeoutPolicy({});

    expect(policy(resource("deepseek", "API"))).toBe(30_000);
    expect(policy(resource("zhipu", "CODING_PLAN"))).toBe(30_000);
    expect(policy(resource("kimi", "API"))).toBe(120_000);
    expect(policy(resource("kimi", "CODING_PLAN"))).toBe(120_000);
  });

  it("按模式覆盖厂商值，厂商值覆盖全局值", () => {
    const policy = createFirstByteTimeoutPolicy({
      GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "45000",
      GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS: "100000",
      GATEWAY_KIMI_CODING_PLAN_FIRST_BYTE_TIMEOUT_MS: "150000",
    });

    expect(policy(resource("deepseek", "API"))).toBe(45_000);
    expect(policy(resource("kimi", "API"))).toBe(100_000);
    expect(policy(resource("kimi", "CODING_PLAN"))).toBe(150_000);
  });

  it.each(["deepseek", "zhipu", "kimi"] as const)(
    "%s 的 API/CODING_PLAN 覆盖均按统一优先级解析",
    (provider) => {
      const prefix = `GATEWAY_${provider.toUpperCase()}`;
      const policy = createFirstByteTimeoutPolicy({
        GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "40000",
        [`${prefix}_FIRST_BYTE_TIMEOUT_MS`]: "60000",
        [`${prefix}_API_FIRST_BYTE_TIMEOUT_MS`]: "70000",
        [`${prefix}_CODING_PLAN_FIRST_BYTE_TIMEOUT_MS`]: "80000",
      });

      expect(policy(resource(provider, "API"))).toBe(70_000);
      expect(policy(resource(provider, "CODING_PLAN"))).toBe(80_000);
    },
  );

  it("空配置视为未配置并回退安全默认值", () => {
    const policy = createFirstByteTimeoutPolicy({
      GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "",
      GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS: "",
    });
    expect(policy(resource("deepseek", "API"))).toBe(30_000);
    expect(policy(resource("kimi", "API"))).toBe(120_000);
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])(
    "启动时拒绝任意厂商或模式的无效门限 %s",
    (value) => {
    expect(() => createFirstByteTimeoutPolicy({
      GATEWAY_ZHIPU_CODING_PLAN_FIRST_BYTE_TIMEOUT_MS: value,
    })).toThrow("GATEWAY_ZHIPU_CODING_PLAN_FIRST_BYTE_TIMEOUT_MS 必须是正整数毫秒");
    },
  );
});
