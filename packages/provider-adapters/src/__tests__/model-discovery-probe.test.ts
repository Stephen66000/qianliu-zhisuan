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
