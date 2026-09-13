import { describe, expect, it } from "vitest";
import { mapToClassification } from "./runtime-controls.js";

describe("mapToClassification", () => {
  it("HTTP 401 归类为 UPSTREAM_CREDENTIAL_INVALID，保留账号级熔断保护", () => {
    const classification = mapToClassification({
      status: 401,
      error: "upstream_http_401",
      committed: false,
      upstreamErrorKind: "UNKNOWN",
    });
    expect(classification).toBe("UPSTREAM_CREDENTIAL_INVALID");
  });

  it("HTTP 403 且 unifiedAvailabilitySignal 为 MODEL_UNAUTHORIZED 时归类为 CLIENT_INVALID，不熔断资源", () => {
    const classification = mapToClassification({
      status: 403,
      error: "upstream_http_403",
      committed: false,
      upstreamErrorKind: "UNKNOWN",
      unifiedAvailabilitySignal: "MODEL_UNAUTHORIZED",
    });
    expect(classification).toBe("CLIENT_INVALID");
  });

  it("HTTP 403 且 upstreamCode 包含 permission 或 model 时归类为 CLIENT_INVALID", () => {
    const classification = mapToClassification({
      status: 403,
      error: "upstream_http_403",
      committed: false,
      upstreamErrorKind: "UNKNOWN",
      upstreamCode: "permission_denied",
    });
    expect(classification).toBe("CLIENT_INVALID");
  });

  it("普通未知 403 依然保留 UPSTREAM_CREDENTIAL_INVALID，防止凭证被上游封禁", () => {
    const classification = mapToClassification({
      status: 403,
      error: "upstream_http_403",
      committed: false,
      upstreamErrorKind: "UNKNOWN",
      upstreamCode: "forbidden",
    });
    expect(classification).toBe("UPSTREAM_CREDENTIAL_INVALID");
  });
});
