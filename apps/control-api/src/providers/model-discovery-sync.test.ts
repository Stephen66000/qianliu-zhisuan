/**
 * 测试矩阵缺口补钉：persistProbeRun 写入失败不再静默——必须 app.log.warn
 * 记录（仅含错误消息与 request_hash，不含凭证/正文），且不向调用方抛出。
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelDiscoveryResult } from "@qianliu/provider-adapters";

import { persistProbeRun } from "./model-discovery-sync.js";

function discoveryWithEvidence(): ModelDiscoveryResult {
  const checkedAt = new Date().toISOString();
  return {
    source: "PROVIDER_API", sourceVersion: "kimi-list-models-v1", parserVersion: null,
    sourceUrl: "https://api.moonshot.cn/v1/models", sourceEtag: null, sourceLastModified: null,
    sourceContentHash: "sha256:catalog", sourceCheckedAt: new Date(), discoveredAt: new Date(),
    stale: false, reused: false, catalogDiff: null, integrationStates: [],
    models: [
      {
        id: "k3", displayName: "K3", modelType: "CHAT", capabilities: [], source: "PROVIDER_API",
        compatible: true, unavailableReason: null,
        facts: { modalities: [], protocols: [], contextWindow: null, maxOutputTokens: null, reasoning: null, clientVariants: [], fieldEvidence: {} },
        credentialValidation: { status: "READY", httpStatus: 200, errorCode: null, retryable: false, checkedAt, endpointScope: "MODE_DEFAULT", endpointHost: "api.kimi.com" },
      },
    ],
  } as unknown as ModelDiscoveryResult;
}

function appWith(record: () => Promise<string | null>) {
  return {
    providerRepo: { recordModelProbeRun: record },
    log: { warn: vi.fn() },
  };
}

describe("persistProbeRun 写入失败可观测（不静默、不抛出）", () => {
  it("仓储抛错时 warn 记录 request_hash 与错误消息，且不向调用方抛出", async () => {
    const app = appWith(() => Promise.reject(new Error("db connection reset")));
    await expect(persistProbeRun(app as never, {
      enterpriseId: "ent-1",
      providerId: "prov-1",
      providerResourceId: "res-1",
      providerCode: "kimi",
      mode: "CODING_PLAN",
      capabilitySet: null,
      credential: "sk-never-logged",
      discovery: discoveryWithEvidence(),
    })).resolves.toBeUndefined();
    const warn = vi.mocked(app.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]![0] as { err: string; request_hash: string };
    expect(payload.err).toBe("db connection reset");
    expect(payload.request_hash).toMatch(/^[0-9a-f]{64}$/);
    // 脱敏：错误对象与键均不得包含凭证明文。
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-never-logged");
  });

  it("写入成功不产生 warn", async () => {
    const record = vi.fn(() => Promise.resolve("run-1"));
    const app = appWith(record as () => Promise<string | null>);
    await persistProbeRun(app as never, {
      enterpriseId: "ent-1",
      providerResourceId: null,
      providerCode: "kimi",
      mode: "CODING_PLAN",
      capabilitySet: null,
      credential: "sk-x",
      discovery: discoveryWithEvidence(),
    });
    expect(record).toHaveBeenCalled();
    expect(app.log.warn).not.toHaveBeenCalled();
  });
});
