import { describe, expect, it } from "vitest";
import { configuredWebOrigins, isCrossSiteMutation } from "./origin-policy.js";

describe("origin policy", () => {
  it("支持逗号分隔的精确 Origin", () => {
    expect(configuredWebOrigins({ WEB_ORIGIN: "https://a.example, http://127.0.0.1:8080" })).toEqual([
      "https://a.example",
      "http://127.0.0.1:8080",
    ]);
  });

  it("拒绝包含路径或非 HTTP 协议的配置", () => {
    expect(() => configuredWebOrigins({ WEB_ORIGIN: "https://a.example/admin" })).toThrow();
    expect(() => configuredWebOrigins({ WEB_ORIGIN: "file:///tmp/web" })).toThrow();
  });

  it("只拦截跨站写请求，不影响同源或服务端调用", () => {
    const allowedOrigins = ["https://admin.example"];
    expect(isCrossSiteMutation({ method: "POST", origin: "https://evil.example", allowedOrigins })).toBe(true);
    expect(isCrossSiteMutation({ method: "POST", origin: "https://admin.example", allowedOrigins })).toBe(false);
    expect(isCrossSiteMutation({ method: "POST", allowedOrigins })).toBe(false);
    expect(isCrossSiteMutation({ method: "GET", origin: "https://evil.example", allowedOrigins })).toBe(false);
  });
});
