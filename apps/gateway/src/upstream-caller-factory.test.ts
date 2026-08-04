import { describe, expect, it, vi } from "vitest";
import type { AdapterResource, OpenAiCompatibleCallerOptions, UpstreamCaller } from "@qianliu/provider-adapters";
import { createProductionCallerOptions, createProductionUpstreamCaller } from "./upstream-caller-factory.js";

const resource = (providerCode: AdapterResource["providerCode"]): AdapterResource => ({
  providerCode,
  mode: "CODING_PLAN",
  resourceId: providerCode,
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
    expect(options.streamIdleTimeoutMs).toBe(50_000);
    expect(options.requestTimeoutMs).toBe(700_000);
  });

  it("生产入口将完整选项交给真实 Caller 工厂", () => {
    const caller = vi.fn() as unknown as UpstreamCaller;
    const factory = vi.fn((_options: OpenAiCompatibleCallerOptions) => caller);

    expect(createProductionUpstreamCaller({}, factory)).toBe(caller);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![0]).toMatchObject({ streamIdleTimeoutMs: 45_000, requestTimeoutMs: 600_000 });
  });

  it("空的流式与总超时配置回退生产默认值", () => {
    expect(createProductionCallerOptions({
      GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "",
      GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "",
    })).toMatchObject({ streamIdleTimeoutMs: 45_000, requestTimeoutMs: 600_000 });
  });

  it.each([
    ["GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS", "0"],
    ["GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS", "1.5"],
  ])("启动时拒绝非法生产超时配置 %s", (name, value) => {
    expect(() => createProductionCallerOptions({ [name]: value }))
      .toThrow(`${name} 必须是正整数毫秒`);
  });
});
