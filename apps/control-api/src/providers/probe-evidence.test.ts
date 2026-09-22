import { describe, expect, it } from "vitest";

import {
  applyProbeEvidenceOverlay,
  currentAvailableModelIds,
  evaluateProbeEvidenceIdentity,
  probeEndpointIdentity,
  probeRequestHash,
} from "./probe-evidence.js";

const BASE_RUN = {
  started_at: new Date("2026-09-22T03:00:00Z"),
  request_hash: "",
  credential_fingerprint: "fp-1",
  endpoint_scope: "MODE_DEFAULT",
  endpoint_host: "api.kimi.com",
  discovery_source_hash: "sha256:catalog-1",
};

function runWith(modelIds: string[], overrides: Record<string, unknown> = {}) {
  const requestHash = probeRequestHash({
    providerCode: "kimi", mode: "CODING_PLAN", credentialFingerprint: "fp-1",
    endpointScope: "MODE_DEFAULT", endpointHost: "api.kimi.com",
    discoverySourceHash: "sha256:catalog-1", modelIds,
  });
  return { run: { ...BASE_RUN, request_hash: requestHash, ...overrides }, items: modelIds.map((m) => ({ upstream_model: m })) };
}

describe("审核修复（P1）：证据身份比对过滤 REMOVED 快照行", () => {
  it("currentAvailableModelIds 剔除 REMOVED 行", () => {
    expect(currentAvailableModelIds([
      { upstream_model: "k3", availability_status: "AVAILABLE" },
      { upstream_model: "k2", availability_status: "REMOVED" },
      { upstream_model: "kimi-for-coding" },
    ])).toEqual(["k3", "kimi-for-coding"]);
  });

  it("官方下架模型（REMOVED 行保留在快照）不使新鲜证据被判 STALE", () => {
    // 探针 run 针对当时在列模型集 [k3, kimi-for-coding]。
    const probeRun = runWith(["k3", "kimi-for-coding"]);
    // 当次同步后快照：k2 下架（REMOVED 行保留），其余在列。
    const identity = evaluateProbeEvidenceIdentity({
      providerCode: "kimi",
      mode: "CODING_PLAN",
      capabilitySet: null,
      credentialFingerprint: "fp-1",
      discoverySourceHash: "sha256:catalog-1",
      modelIds: currentAvailableModelIds([
        { upstream_model: "k2", availability_status: "REMOVED" },
        { upstream_model: "k3", availability_status: "AVAILABLE" },
        { upstream_model: "kimi-for-coding", availability_status: "AVAILABLE" },
      ]),
      probeRun,
      now: new Date("2026-09-22T04:00:00Z"),
    });
    expect(identity).toEqual({ valid: true, reason: null });
  });

  it("不过滤 REMOVED 的模型集仍会正确判 STALE（对照）", () => {
    const probeRun = runWith(["k3", "kimi-for-coding"]);
    const identity = evaluateProbeEvidenceIdentity({
      providerCode: "kimi",
      mode: "CODING_PLAN",
      capabilitySet: null,
      credentialFingerprint: "fp-1",
      discoverySourceHash: "sha256:catalog-1",
      modelIds: ["k2", "k3", "kimi-for-coding"],
      probeRun,
      now: new Date("2026-09-22T04:00:00Z"),
    });
    expect(identity).toEqual({ valid: false, reason: "MODEL_SET_MISMATCH" });
  });
});

describe("F-P2-13：端点身份公式唯一实现（probeEndpointIdentity）", () => {
  it("解析成功返回策略 scope/host；歧义返回 ENDPOINT_SCOPE_AMBIGUOUS + unresolved", () => {
    expect(probeEndpointIdentity({ providerCode: "kimi", mode: "CODING_PLAN", capabilitySet: null, env: {} }))
      .toEqual({ endpointScope: "MODE_DEFAULT", endpointHost: "api.kimi.com" });
    expect(probeEndpointIdentity({
      providerCode: "kimi", mode: "CODING_PLAN",
      capabilitySet: { base_url: "https://unknown.example/v1" }, env: {},
    })).toEqual({ endpointScope: "ENDPOINT_SCOPE_AMBIGUOUS", endpointHost: "unknown.example" });
    expect(probeEndpointIdentity({ providerCode: "deepseek", mode: "API", capabilitySet: null, env: {} }))
      .toEqual({ endpointScope: "MODE_DEFAULT", endpointHost: "api.deepseek.com" });
  });
});

describe("F-P2-4/F-P2-10：GET 证据回填携带端点身份且 NOT_RUN 不计失败", () => {
  it("overlay 写入 endpoint_scope/endpoint_host，failed 计数排除 NOT_RUN", () => {
    const publicResult = {
      models: [
        { id: "k3", credential_validation: null },
        { id: "k3-256k", credential_validation: null },
        { id: "embed-1", credential_validation: null },
      ],
      summary: { credential_ready: 0, credential_failed: 0 },
    };
    const probeRun = {
      run: {
        finished_at: new Date("2026-09-22T03:01:00Z"),
        started_at: new Date("2026-09-22T03:00:00Z"),
        endpoint_scope: "MODE_DEFAULT",
        endpoint_host: "api.kimi.com",
      },
      items: [
        { upstream_model: "k3", validation_status: "READY", http_status: 200, error_code: null, retryable: false, checked_at: new Date("2026-09-22T03:01:00Z") },
        { upstream_model: "k3-256k", validation_status: "NOT_RUN", http_status: null, error_code: "MODEL_PROBE_NOT_RUN", retryable: true, checked_at: new Date("2026-09-22T03:01:00Z") },
      ],
    };
    const evidence = applyProbeEvidenceOverlay(publicResult, probeRun);
    expect(evidence.status).toBe("CURRENT");
    const models = publicResult.models;
    expect(models[0]!.credential_validation).toMatchObject({
      status: "READY", endpoint_scope: "MODE_DEFAULT", endpoint_host: "api.kimi.com",
    });
    expect(models[1]!.credential_validation).toMatchObject({ status: "NOT_RUN", endpoint_host: "api.kimi.com" });
    expect(publicResult.summary).toEqual({ credential_ready: 1, credential_failed: 0 });
  });
});
