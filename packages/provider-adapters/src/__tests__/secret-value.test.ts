import { describe, it, expect } from "vitest";
import { SecretValue, PROVIDER_ADAPTERS_VERSION } from "../index.js";

describe("SecretValue 脱敏", () => {
  it("toString/toJSON 强制返回 [REDACTED]", () => {
    const sv = new SecretValue("sk-real-secret-12345");
    expect(sv.toString()).toBe("[REDACTED]");
    expect(sv.toJSON()).toBe("[REDACTED]");
    expect(JSON.stringify({ key: sv })).toBe('{"key":"[REDACTED]"}');
  });

  it("reveal 取明文", () => {
    const sv = new SecretValue("sk-real");
    expect(sv.reveal()).toBe("sk-real");
  });

  it("fingerprint 不泄露可还原信息", () => {
    const sv = new SecretValue("sk-real-secret-12345");
    const fp = sv.fingerprint();
    expect(fp).toContain("sk-r");
    expect(fp).not.toContain("secret");
    expect(fp).toContain("len=");
  });

  it("exposes version", () => {
    expect(PROVIDER_ADAPTERS_VERSION).toBe("0.3.0");
  });
});
