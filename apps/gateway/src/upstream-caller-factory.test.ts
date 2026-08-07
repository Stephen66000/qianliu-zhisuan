import { describe, expect, it, vi } from "vitest";
import type { AdapterResource, OpenAiCompatibleCallerOptions, UpstreamCaller } from "@qianliu/provider-adapters";
import { createProductionCallerOptions, createProductionUpstreamCaller } from "./upstream-caller-factory.js";

const resource = (
  providerCode: AdapterResource["providerCode"],
  mode: AdapterResource["mode"] = "CODING_PLAN",
): AdapterResource => ({
  providerCode,
  mode,
  resourceId: `${providerCode}-${mode}`,
  upstreamModel: "test",
  concurrencyLimit: 1,
  secret: null as never,
});

describe("Gateway 生产上游 Caller 装配", () => {
  it("冻结 main.ts 实际使用的厂商门限、空闲门限和总门限", () => {
    const env = {
      GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "40000",
      GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS: "120000",
      GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "50000",
      GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "700000",
    };
    const options = createProductionCallerOptions(env);

    expect(options.env).toBe(env);
    expect(options.firstByteTimeoutMsForResource?.(resource("deepseek"))).toBe(40_000);
    expect(options.firstByteTimeoutMsForResource?.(resource("kimi"))).toBe(120_000);
    // 空闲门限为厂商/模式策略（POOL-034）：未覆盖的厂商回退全局 50 秒。
    expect(options.streamIdleTimeoutMsForResource?.(resource("deepseek", "API"))).toBe(50_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("kimi", "CODING_PLAN"))).toBe(50_000);
    expect(options.requestTimeoutMs).toBe(700_000);
  });

  it("智谱 Coding Plan 空闲门限默认放宽到 120 秒，智谱 API 与其他厂商仍为 45 秒", () => {
    const options = createProductionCallerOptions({});
    expect(options.streamIdleTimeoutMsForResource?.(resource("zhipu", "CODING_PLAN"))).toBe(120_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("zhipu", "API"))).toBe(45_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("deepseek", "API"))).toBe(45_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("kimi", "CODING_PLAN"))).toBe(45_000);
  });

  it("生产入口将完整选项交给真实 Caller 工厂", () => {
    const caller = vi.fn() as unknown as UpstreamCaller;
    const factory = vi.fn((_options: OpenAiCompatibleCallerOptions) => caller);

    expect(createProductionUpstreamCaller({}, factory)).toBe(caller);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![0]).toMatchObject({ requestTimeoutMs: 600_000 });
    expect(typeof factory.mock.calls[0]![0].streamIdleTimeoutMsForResource).toBe("function");
  });

  it("空的总超时配置回退生产默认值", () => {
    expect(createProductionCallerOptions({
      GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "",
    })).toMatchObject({ requestTimeoutMs: 600_000 });
  });

  it.each([
    ["GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS", "1.5"],
  ])("启动时拒绝非法生产超时配置 %s", (name, value) => {
    expect(() => createProductionCallerOptions({ [name]: value }))
      .toThrow(`${name} 必须是正整数毫秒`);
  });
});
