/** P1 整改：READY 是唯一可用/可选口径（取代 compatible）。 */
import { describe, expect, it } from "vitest";
import type { DiscoveredProviderModel } from "@qianliu/provider-adapters";
import { publicDiscovery, publicStoredDiscovery, selectReadyModels } from "./contracts.js";

function model(overrides: Partial<DiscoveredProviderModel> = {}): DiscoveredProviderModel {
  return {
    id: "k3", displayName: "k3", modelType: "CHAT", capabilities: ["chat", "stream"],
    source: "OFFICIAL_DOCUMENTATION", compatible: true, unavailableReason: null,
    facts: { modalities: ["text"], protocols: ["OPENAI_CHAT_COMPLETIONS"], contextWindow: null,
      maxOutputTokens: null, reasoning: null, clientVariants: [], fieldEvidence: {} },
    ...overrides,
  };
}

const READY = { status: "READY" as const, httpStatus: 200, errorCode: null, retryable: false, checkedAt: "2026-09-21T00:00:00Z" };
const NOT_ENTITLED = { status: "PLAN_NOT_ENTITLED" as const, httpStatus: 403, errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", retryable: false, checkedAt: "2026-09-21T00:00:00Z" };

describe("selectReadyModels（READY 门槛）", () => {
  it("仅 READY 模型可被确认；未探针（无 credentialValidation）与非 READY 一律拒绝", () => {
    const models = [
      model({ id: "k3", credentialValidation: READY }),
      model({ id: "k3-256k", compatible: false, unavailableReason: "403", credentialValidation: NOT_ENTITLED }),
      model({ id: "kimi-for-coding", credentialValidation: null }), // 未探针
      model({ id: "kimi-embedding", modelType: "EMBEDDING", compatible: false, credentialValidation: null }),
    ];
    expect(selectReadyModels(models, ["k3"])?.map((m) => m.id)).toEqual(["k3"]);
    expect(selectReadyModels(models, ["k3-256k"])).toBeNull();
    expect(selectReadyModels(models, ["kimi-for-coding"])).toBeNull(); // 无证据不可确认
    expect(selectReadyModels(models, ["k3", "kimi-for-coding"])).toBeNull(); // 混选整体拒绝
  });

  it("所选 id 不在发现列表时整体拒绝", () => {
    expect(selectReadyModels([model({ credentialValidation: READY })], ["ghost"])).toBeNull();
  });
});

describe("publicDiscovery / publicStoredDiscovery 的 selectable 口径", () => {
  it("toPublicModel：selectable 与废弃 compatible 均等价于 credentialValidation.status === READY", () => {
    const result = publicDiscovery({
      source: "OFFICIAL_DOCUMENTATION", sourceVersion: "v1", parserVersion: null, sourceUrl: null,
      sourceEtag: null, sourceLastModified: null, sourceContentHash: null,
      sourceCheckedAt: new Date(), discoveredAt: new Date(), stale: false, reused: false,
      models: [
        model({ id: "k3", compatible: true, credentialValidation: READY }),
        model({ id: "k3-256k", compatible: false, unavailableReason: "403", credentialValidation: NOT_ENTITLED }),
        model({ id: "kimi-for-coding", compatible: true, credentialValidation: null }), // 探针上限外：compatible=true 但无证据
      ],
      catalogDiff: null, integrationStates: [],
    } as never);
    const [k3, k3256k, unprobed] = result.models as Array<Record<string, unknown>>;
    expect(k3?.selectable).toBe(true);
    expect(k3?.compatible).toBe(true);
    expect(k3256k?.selectable).toBe(false);
    expect(k3256k?.compatible).toBe(false);
    // 关键回归：compatible=true 但 credential_validation=null 不允许被选/被旧客户端确认。
    expect(unprobed?.selectable).toBe(false);
    expect(unprobed?.compatible).toBe(false);
    expect((result.summary as { credential_ready: number }).credential_ready).toBe(1);
  });

  it("publicStoredDiscovery：无探针证据列的快照行 selectable 一律 false", () => {
    const result = publicStoredDiscovery({
      discovery: { source: "OFFICIAL_DOCUMENTATION", source_version: "v1", parser_version: null,
        source_url: null, source_etag: null, source_last_modified: null, source_content_hash: null,
        source_checked_at: new Date(), discovered_at: new Date(), stale: false, status: "SUCCESS", failure_code: null },
      items: [
        { upstream_model: "k3", display_name: "k3", model_type: "CHAT", capabilities: ["chat"],
          source: "OFFICIAL_DOCUMENTATION", compatible: true, unavailable_reason: null, facts: {},
          availability_status: "AVAILABLE" },
        { upstream_model: "k3-256k", display_name: "k3-256k", model_type: "CHAT", capabilities: ["chat"],
          source: "OFFICIAL_DOCUMENTATION", compatible: false, unavailable_reason: "403", facts: {},
          availability_status: "REMOVED" },
      ],
      itemsStale: false,
    });
    for (const item of result.models as Array<{ selectable: boolean; credential_validation: unknown }>) {
      expect(item.selectable).toBe(false);
      expect(item.credential_validation).toBeNull();
    }
  });
});
