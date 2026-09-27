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

describe("acquireConcurrencyLeaseWithWait 并发租约 TTL", () => {
  it("显式传入的 leaseTtlMs 透传给仓储 acquireLease，不再依赖 60 秒默认值", async () => {
    const { acquireConcurrencyLeaseWithWait } = await import("./runtime-controls.js");
    const seen: Array<Record<string, unknown>> = [];
    const quotaRepo = {
      acquireLease: async (input: Record<string, unknown>) => {
        seen.push(input);
        return "lease-1";
      },
    } as never;

    const leaseId = await acquireConcurrencyLeaseWithWait({
      quotaRepo,
      enterpriseId: "ent-1",
      providerResourceId: "res-1",
      aiRequestId: "ai-req-1",
      waitMs: 0,
      pollMs: 10,
      leaseTtlMs: 660_000,
      cancelled: () => false,
    });

    expect(leaseId).toBe("lease-1");
    expect(seen[0]).toMatchObject({ leaseTtlMs: 660_000 });
  });

  it("未传 leaseTtlMs 时不注入字段，仓储保持既有默认行为", async () => {
    const { acquireConcurrencyLeaseWithWait } = await import("./runtime-controls.js");
    const seen: Array<Record<string, unknown>> = [];
    const quotaRepo = {
      acquireLease: async (input: Record<string, unknown>) => {
        seen.push(input);
        return "lease-2";
      },
    } as never;

    await acquireConcurrencyLeaseWithWait({
      quotaRepo,
      enterpriseId: "ent-1",
      providerResourceId: "res-1",
      aiRequestId: "ai-req-2",
      waitMs: 0,
      pollMs: 10,
      cancelled: () => false,
    });

    expect(seen[0]).not.toHaveProperty("leaseTtlMs");
  });
});
