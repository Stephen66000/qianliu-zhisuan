import { describe, expect, it, vi } from "vitest";
import type { AdapterResource, OpenAiCompatibleCallerOptions, UpstreamCaller } from "@qianliu/provider-adapters";
import {
  createProductionCallerOptions,
  createProductionUpstreamCaller,
  createProductionUpstreamRuntime,
} from "./upstream-caller-factory.js";

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
  it("冻结 main.ts 实际使用的厂商首字节门限、统一空闲门限和总门限", () => {
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
    // 统一 300 秒空闲门限：显式配置仍生效，但厂商/模式覆盖已移除。
    expect(options.streamIdleTimeoutMsForResource?.(resource("deepseek", "API"))).toBe(50_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("kimi", "CODING_PLAN"))).toBe(50_000);
    expect(options.requestTimeoutMs).toBe(700_000);
  });

  it("统一空闲门限：智谱 Coding Plan 特例与厂商覆盖全部失效，默认 300000", () => {
    const options = createProductionCallerOptions({
      GATEWAY_ZHIPU_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS: "130000",
      GATEWAY_KIMI_STREAM_IDLE_TIMEOUT_MS: "90000",
    });
    expect(options.streamIdleTimeoutMsForResource?.(resource("zhipu", "CODING_PLAN"))).toBe(300_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("zhipu", "API"))).toBe(300_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("deepseek", "API"))).toBe(300_000);
    expect(options.streamIdleTimeoutMsForResource?.(resource("kimi", "CODING_PLAN"))).toBe(300_000);
  });

  it("旧空闲覆盖变量产生脱敏弃用提示", () => {
    const seen: string[] = [];
    createProductionCallerOptions({
      GATEWAY_ZHIPU_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS: "130000",
    }, { onLegacyOverride: (name) => seen.push(name) });
    expect(seen).toEqual(["GATEWAY_ZHIPU_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS"]);
  });

  it("生产入口将完整选项交给真实 Caller 工厂", () => {
    const caller = vi.fn() as unknown as UpstreamCaller;
    const factory = vi.fn((_options: OpenAiCompatibleCallerOptions) => caller);

    expect(createProductionUpstreamCaller({}, factory)).toBe(caller);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![0]).toMatchObject({ requestTimeoutMs: 600_000 });
    expect(typeof factory.mock.calls[0]![0].streamIdleTimeoutMsForResource).toBe("function");
  });

  it("700000ms 总超时从同一生产配置派生 60000ms 余量的探针租期", () => {
    const runtime = createProductionUpstreamRuntime({
      GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "700000",
    });

    expect(runtime.requestTimeoutMs).toBe(700_000);
    expect(runtime.halfOpenProbeLeaseMs).toBe(760_000);
  });

  it("并发租约 TTL 与总调用时限同源派生并覆盖 60000ms 安全余量", () => {
    const runtime = createProductionUpstreamRuntime({
      GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "700000",
    });
    expect(runtime.concurrencyLeaseTtlMs).toBe(760_000);

    const defaults = createProductionUpstreamRuntime({});
    expect(defaults.concurrencyLeaseTtlMs).toBe(660_000);
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

  it("启动时拒绝无法安全增加探针余量的超大总超时", () => {
    expect(() => createProductionUpstreamRuntime({
      GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
    })).toThrow("无法增加 60000ms 探针安全余量");
  });
});
