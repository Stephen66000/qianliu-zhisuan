import { describe, expect, it } from "vitest";

import { mapProbeOutcome } from "../model-discovery-probe.js";
import type { DiscoveredProviderModel } from "../model-discovery-contract.js";

function model(): DiscoveredProviderModel {
  return {
    id: "k3", displayName: "K3", modelType: "CHAT", capabilities: [], source: "OFFICIAL_DOCUMENTATION",
    compatible: true, unavailableReason: null, facts: null,
  } as unknown as DiscoveredProviderModel;
}

describe("审核修复（P1）：探针映射区分本侧配置错误与上游故障", () => {
  it("端点歧义/缺失：不合成上游 HTTP 状态，不可重试", () => {
    for (const upstreamCode of ["upstream_endpoint_ambiguous", "upstream_base_url_missing"]) {
      const m = model();
      mapProbeOutcome(m, { status: 0, upstreamCode });
      expect(m.compatible).toBe(false);
      expect(m.credentialValidation).toMatchObject({
        status: "REQUEST_REJECTED",
        httpStatus: null,
        errorCode: "MODEL_PROBE_CONFIGURATION_ERROR",
        retryable: false,
      });
      expect(m.unavailableReason).toContain("本侧");
    }
  });

  it("凭证未配置同样归入本侧配置错误", () => {
    const m = model();
    mapProbeOutcome(m, { status: 0, upstreamCode: "upstream_credential_missing" });
    expect(m.credentialValidation).toMatchObject({
      status: "REQUEST_REJECTED", errorCode: "MODEL_PROBE_CONFIGURATION_ERROR", retryable: false,
    });
  });

  it("真实上游 5xx 仍是可重试的 UPSTREAM_UNAVAILABLE，不被误伤", () => {
    const m = model();
    mapProbeOutcome(m, { status: 503, upstreamCode: null });
    expect(m.credentialValidation).toMatchObject({
      status: "UPSTREAM_UNAVAILABLE", httpStatus: 503, retryable: true,
    });
    expect(m.unavailableReason).toContain("上游暂不可用");
  });

  it("传输层失败（无配置错误标记）仍是可重试的 NETWORK_FAILED", () => {
    const m = model();
    mapProbeOutcome(m, { status: 0, upstreamCode: "transport_error" });
    expect(m.credentialValidation).toMatchObject({
      status: "NETWORK_FAILED", retryable: true,
    });
  });
});

describe("F-P2-3：401 按上游脱敏语义细分 AUTH_FAILED / PLAN_NOT_ENTITLED", () => {
  it.each([
    { upstreamCode: "invalid_api_key", kind: "UNKNOWN" },
    { upstreamCode: "unauthorized", kind: "UNKNOWN" },
    { upstreamCode: "upstream_http_401", kind: null },
  ])("纯鉴权语义（$upstreamCode）保持 AUTH_FAILED", ({ upstreamCode, kind }) => {
    const m = model();
    mapProbeOutcome(m, { status: 401, upstreamCode, upstreamErrorKind: kind });
    expect(m.credentialValidation).toMatchObject({
      status: "AUTH_FAILED", httpStatus: 401, errorCode: "MODEL_PROBE_AUTH_FAILED", retryable: false,
    });
    expect(m.unavailableReason).toContain("凭证鉴权失败");
  });

  it.each([
    { upstreamCode: "plan_not_entitled", kind: "UNKNOWN" },
    { upstreamCode: "quota_exhausted", kind: "UNKNOWN" },
    { upstreamCode: "subscription_required", kind: "UNKNOWN" },
    { upstreamCode: "upstream_http_401", kind: "QUOTA_EXHAUSTED" },
    { upstreamCode: "upstream_http_401", kind: "PLAN_EXPIRED" },
  ])("套餐/额度语义（$upstreamCode/$kind）映射 PLAN_NOT_ENTITLED，不再误报凭证鉴权失败", ({ upstreamCode, kind }) => {
    const m = model();
    mapProbeOutcome(m, { status: 401, upstreamCode, upstreamErrorKind: kind });
    expect(m.credentialValidation).toMatchObject({
      status: "PLAN_NOT_ENTITLED", httpStatus: 401, errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", retryable: false,
    });
    expect(m.unavailableReason).toContain("套餐");
  });
});

describe("测试矩阵缺口：状态映射补钉", () => {
  it("404 模型不存在：REQUEST_REJECTED 且保留 httpStatus", () => {
    const m = model();
    mapProbeOutcome(m, { status: 404, upstreamCode: "upstream_http_404" });
    expect(m.credentialValidation).toMatchObject({
      status: "REQUEST_REJECTED", httpStatus: 404, retryable: false,
    });
    expect(m.unavailableReason).toContain("404");
  });

  it("caller 层超时（504/upstream_timeout）：可重试的 UPSTREAM_UNAVAILABLE", () => {
    const m = model();
    mapProbeOutcome(m, { status: 504, upstreamCode: "upstream_timeout" });
    expect(m.credentialValidation).toMatchObject({
      status: "UPSTREAM_UNAVAILABLE", httpStatus: 504, retryable: true,
    });
    const m2 = model();
    mapProbeOutcome(m2, { status: 0, upstreamCode: "upstream_timeout" });
    expect(m2.credentialValidation).toMatchObject({
      status: "UPSTREAM_UNAVAILABLE", httpStatus: null, retryable: true,
    });
  });

  it("未知状态保留原 HTTP 状态，不转空列表不判定可用", () => {
    const m = model();
    mapProbeOutcome(m, { status: 418, upstreamCode: "upstream_http_418" });
    expect(m.credentialValidation).toMatchObject({
      status: "REQUEST_REJECTED", httpStatus: 418, retryable: false,
    });
    expect(m.unavailableReason).toContain("418");
  });

  it("F-P2-4：证据携带端点 scope/host", () => {
    const m = model();
    mapProbeOutcome(m, { status: 200, endpointScope: "MODE_DEFAULT", endpointHost: "api.kimi.com" });
    expect(m.credentialValidation).toMatchObject({
      status: "READY", endpointScope: "MODE_DEFAULT", endpointHost: "api.kimi.com",
    });
  });
});
