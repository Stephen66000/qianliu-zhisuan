import { describe, it, expect } from "vitest";
import {
  DOMAIN_VERSION,
  RETRYABLE_UPSTREAM_STATUS,
  LOG_WHITELIST_FIELDS,
  DEFAULT_CONTENT_RETENTION_MODE,
} from "../index.js";

describe("@qianliu/domain", () => {
  it("exposes version", () => {
    expect(DOMAIN_VERSION).toBe("0.3.0");
  });

  it("可重试状态码集合（PoC 迁移）", () => {
    expect(RETRYABLE_UPSTREAM_STATUS.has(429)).toBe(true);
    expect(RETRYABLE_UPSTREAM_STATUS.has(500)).toBe(true);
    expect(RETRYABLE_UPSTREAM_STATUS.has(503)).toBe(true);
    expect(RETRYABLE_UPSTREAM_STATUS.has(400)).toBe(false);
    expect(RETRYABLE_UPSTREAM_STATUS.has(401)).toBe(false);
  });

  it("日志白名单 11 字段", () => {
    expect(LOG_WHITELIST_FIELDS).toHaveLength(11);
    expect(LOG_WHITELIST_FIELDS).toContain("requestId");
    expect(LOG_WHITELIST_FIELDS).not.toContain("body");
    expect(LOG_WHITELIST_FIELDS).not.toContain("prompt");
  });

  it("默认 METADATA_ONLY", () => {
    expect(DEFAULT_CONTENT_RETENTION_MODE).toBe("METADATA_ONLY");
  });
});
