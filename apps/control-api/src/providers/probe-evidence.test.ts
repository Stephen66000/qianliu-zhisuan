import { describe, expect, it } from "vitest";

import {
  currentAvailableModelIds,
  evaluateProbeEvidenceIdentity,
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
