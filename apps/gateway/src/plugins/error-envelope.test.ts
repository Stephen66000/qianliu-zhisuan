import { describe, expect, it } from "vitest";
import { fromClassification, GatewayError } from "./error-envelope.js";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";

describe("错误分类 → HTTP 映射", () => {
  it("PAYLOAD_TOO_LARGE 映射为 413 + invalid_request_error + 不可重试", () => {
    const ge = fromClassification(
      ERROR_CLASSIFICATION.PAYLOAD_TOO_LARGE,
      "payload_too_large",
      "请求体超过上限",
      "req-123",
    );
    expect(ge).toBeInstanceOf(GatewayError);
    expect(ge.status).toBe(413);
    expect(ge.type).toBe("invalid_request_error");
    expect(ge.retryable).toBe(false);
    expect(ge.code).toBe("payload_too_large");
    expect(ge.requestId).toBe("req-123");
  });

  it("已知分类稳定覆盖（回归基线）", () => {
    const cases: Array<[keyof typeof ERROR_CLASSIFICATION, number]> = [
      ["CLIENT_INVALID", 400],
      ["CAPABILITY_UNSUPPORTED", 422],
      ["PAYLOAD_TOO_LARGE", 413],
      ["DOWNSTREAM_AUTH_OR_QUOTA", 401],
      ["UPSTREAM_RATE_LIMITED", 429],
      ["UPSTREAM_TEMPORARY", 502],
    ];
    for (const [classification, status] of cases) {
      const ge = fromClassification(ERROR_CLASSIFICATION[classification], "x", "m");
      expect(ge.status).toBe(status);
    }
  });
});
