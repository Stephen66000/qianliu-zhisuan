import { describe, expect, it } from "vitest";
import { readRequestBodyLimit } from "./server.js";

describe("Gateway 入站请求体上限 readRequestBodyLimit", () => {
  it("未设置环境变量时返回默认 10MB", () => {
    expect(readRequestBodyLimit({})).toBe(10 * 1024 * 1024);
    expect(readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "" })).toBe(10 * 1024 * 1024);
  });

  it("合法正整数字节值直接采用", () => {
    expect(readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "1048576" })).toBe(1_048_576);
    expect(readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "52428800" })).toBe(52_428_800);
  });

  it("非法值启动期抛错（避免静默回落到不安全默认）", () => {
    expect(() => readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "abc" })).toThrow();
    expect(() => readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "0" })).toThrow();
    expect(() => readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "-1" })).toThrow();
    expect(() => readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "1.5" })).toThrow();
    expect(() => readRequestBodyLimit({ GATEWAY_REQUEST_BODY_LIMIT_BYTES: "NaN" })).toThrow();
  });
});
