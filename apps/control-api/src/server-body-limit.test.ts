import { describe, expect, it } from "vitest";
import { readRequestBodyLimit } from "./server.js";

describe("control-api readRequestBodyLimit（H-1：与 gateway 共享 @qianliu/config 校验）", () => {
  it("未设 → 默认 10MB", () => {
    expect(readRequestBodyLimit({})).toBe(10 * 1024 * 1024);
    expect(readRequestBodyLimit({ CONTROL_API_REQUEST_BODY_LIMIT_BYTES: "" })).toBe(10 * 1024 * 1024);
  });

  it("合法正整数字节值直接采用", () => {
    expect(readRequestBodyLimit({ CONTROL_API_REQUEST_BODY_LIMIT_BYTES: "5242880" })).toBe(5_242_880);
  });

  it("非法值启动期抛错", () => {
    expect(() => readRequestBodyLimit({ CONTROL_API_REQUEST_BODY_LIMIT_BYTES: "abc" })).toThrow();
    expect(() => readRequestBodyLimit({ CONTROL_API_REQUEST_BODY_LIMIT_BYTES: "0" })).toThrow();
    expect(() => readRequestBodyLimit({ CONTROL_API_REQUEST_BODY_LIMIT_BYTES: "-1" })).toThrow();
    expect(() => readRequestBodyLimit({ CONTROL_API_REQUEST_BODY_LIMIT_BYTES: "1.5" })).toThrow();
  });
});
