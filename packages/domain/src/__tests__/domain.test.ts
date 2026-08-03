import { describe, it, expect } from "vitest";
import {
  DOMAIN_VERSION,
  RETRYABLE_UPSTREAM_STATUS,
  LOG_WHITELIST_FIELDS,
  DEFAULT_CONTENT_RETENTION_MODE,
  ERROR_CLASSIFICATION,
  isSwitchable,
} from "../index.js";
import type { ErrorClassification } from "../index.js";

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

  it("仅允许提交前可恢复的上游错误切换路由", () => {
    const switchable = new Set<ErrorClassification>([
      ERROR_CLASSIFICATION.UPSTREAM_CREDENTIAL_INVALID,
      ERROR_CLASSIFICATION.UPSTREAM_RATE_LIMITED,
      ERROR_CLASSIFICATION.UPSTREAM_TEMPORARY,
      ERROR_CLASSIFICATION.UPSTREAM_BILLING_BLOCKED,
      ERROR_CLASSIFICATION.TRANSPORT_ERROR,
    ]);
    const fixed = Object.values(ERROR_CLASSIFICATION).filter((item) => !switchable.has(item));

    expect([...switchable].every(isSwitchable)).toBe(true);
    expect(fixed.some(isSwitchable)).toBe(false);
  });
});
