import { describe, expect, it, vi } from "vitest";
import type { AdapterResource } from "../index.js";
import { resolveFirstByteTimeoutMs, resolveStreamIdleTimeoutMs } from "../resource-timeout-policy.js";

const resource = { providerCode: "kimi", mode: "CODING_PLAN" } as AdapterResource;

describe("Provider Adapter 首字节门限解析", () => {
  it("无资源解析器时使用全局门限", () => {
    expect(resolveFirstByteTimeoutMs(resource, 30_000)).toBe(30_000);
  });

  it("资源解析器覆盖全局门限并收到当前资源", () => {
    const resolver = vi.fn(() => 120_000);
    expect(resolveFirstByteTimeoutMs(resource, 30_000, resolver)).toBe(120_000);
    expect(resolver).toHaveBeenCalledWith(resource);
  });
});

describe("Provider Adapter 流式空闲门限解析", () => {
  it("无资源解析器时使用全局门限", () => {
    expect(resolveStreamIdleTimeoutMs(resource, 45_000)).toBe(45_000);
  });

  it("资源解析器覆盖全局门限并收到当前资源", () => {
    const resolver = vi.fn(() => 120_000);
    expect(resolveStreamIdleTimeoutMs(resource, 45_000, resolver)).toBe(120_000);
    expect(resolver).toHaveBeenCalledWith(resource);
  });
});
