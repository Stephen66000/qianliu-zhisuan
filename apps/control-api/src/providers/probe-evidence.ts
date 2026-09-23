/**
 * 终审整改一：READY 探针证据身份校验（MODEL_VALIDATION_STALE 门禁）。
 *
 * GET /models 与 confirm models 只接受与"当前资源 + 当前成功发现"身份
 * 完全一致的 READY 探针证据。身份五要素（与 persistProbeRun 的
 * request_hash 同源同式）：
 *   1. 凭证指纹（credential_fingerprint）——Key 轮换即失效；
 *   2. 解析端点 scope/host——capability base_url / endpoints[mode] 变更即失效；
 *   3. 官方目录内容哈希（discovery_source_hash）——上游目录变化即失效；
 *   4. 模型集——目录增删模型即失效；
 *   5. 新鲜度——run 开始时间早于 TTL 视为过期。
 * 任一不满足即拒绝：GET 不再回填 READY 证据（模型不可选），
 * confirm 返回 409 MODEL_VALIDATION_STALE，要求重新同步或重新检测。
 */
import { createHash } from "node:crypto";
import { capabilityConfiguredEndpoints, resolveProviderEndpoint } from "@qianliu/provider-adapters";
import type { ProbeRunEndpointScope } from "@qianliu/database";

/** 证据新鲜期：超过该时长的 run 不再作为 READY 依据（每次 sync 会生成新 run）。 */
export const MODEL_PROBE_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

export type ProbeEvidenceStaleReason =
  | "EVIDENCE_EXPIRED"
  | "CREDENTIAL_FINGERPRINT_MISMATCH"
  | "ENDPOINT_MISMATCH"
  | "DISCOVERY_SOURCE_HASH_MISMATCH"
  | "MODEL_SET_MISMATCH";

export interface ProbeEvidenceIdentityInput {
  providerCode: string;
  mode: "API" | "CODING_PLAN";
  capabilitySet: unknown;
  /** 当前资源凭证指纹（provider_resource.credential_fingerprint）。 */
  credentialFingerprint: string | null;
  /** 当前成功发现快照的 source_content_hash。 */
  discoverySourceHash: string | null;
  /** 当前成功发现的模型集（provider_model_discovery_item.upstream_model）。 */
  modelIds: string[];
  probeRun: {
    run: {
      started_at: Date | string;
      request_hash: string;
      credential_fingerprint: string | null;
      endpoint_scope: string;
      endpoint_host: string;
      discovery_source_hash: string | null;
    };
    items: ReadonlyArray<{ upstream_model: string }>;
  };
  now?: Date;
}

/**
 * 与 persistProbeRun 完全同式的探针请求哈希——五要素中前四项的复合身份。
 * 双方必须使用同一实现，禁止复制粘贴公式。
 */
export function probeRequestHash(input: {
  providerCode: string;
  mode: string;
  credentialFingerprint: string;
  endpointScope: string;
  endpointHost: string;
  discoverySourceHash: string | null;
  modelIds: ReadonlyArray<string>;
}): string {
  return createHash("sha256").update([
    input.providerCode, input.mode, input.credentialFingerprint,
    input.endpointScope, input.endpointHost,
    input.discoverySourceHash ?? "",
    [...input.modelIds].sort().join(","),
  ].join("|")).digest("hex");
}

/**
 * F-P2-13：探针端点身份唯一实现——解析失败时的兜底公式（歧义 scope +
 * unresolved/歧义 host）历史上在 probe-evidence/routes/persistProbeRun
 * 三处复制粘贴，漂移即静默击穿身份门禁，收敛于此，禁止再复制。
 */
export function probeEndpointIdentity(input: {
  providerCode: string;
  mode: "API" | "CODING_PLAN";
  capabilitySet: unknown;
  env?: NodeJS.ProcessEnv;
}): { endpointScope: ProbeRunEndpointScope; endpointHost: string } {
  const endpoint = resolveProviderEndpoint({
    providerCode: input.providerCode,
    resourceMode: input.mode,
    operation: "MODEL_PERMISSION_PROBE",
    configuredEndpoints: capabilityConfiguredEndpoints(input.capabilitySet),
    env: input.env ?? process.env,
  });
  return {
    endpointScope: endpoint.ok ? endpoint.scope : "ENDPOINT_SCOPE_AMBIGUOUS",
    endpointHost: endpoint.ok ? endpoint.host : (endpoint.host ?? "unresolved"),
  };
}

/**
 * 校验最近一次探针 run 是否仍可代表当前资源与当前成功发现。
 * 返回 valid=false 时 reason 给出第一个不匹配的维度（诊断用）。
 */
export function evaluateProbeEvidenceIdentity(
  input: ProbeEvidenceIdentityInput,
): { valid: boolean; reason: ProbeEvidenceStaleReason | null } {
  const run = input.probeRun.run;
  const now = input.now ?? new Date();
  // 5. 新鲜度：过期证据一律拒绝（先于身份比对，避免误导性原因）。
  if (now.getTime() - new Date(run.started_at).getTime() > MODEL_PROBE_EVIDENCE_TTL_MS) {
    return { valid: false, reason: "EVIDENCE_EXPIRED" };
  }
  // 1. 凭证指纹。
  if ((input.credentialFingerprint ?? "") !== (run.credential_fingerprint ?? "")) {
    return { valid: false, reason: "CREDENTIAL_FINGERPRINT_MISMATCH" };
  }
  // 2. 解析端点 scope/host（与 persistProbeRun 同一 operation/策略）。
  const identity = probeEndpointIdentity({
    providerCode: input.providerCode,
    mode: input.mode,
    capabilitySet: input.capabilitySet,
  });
  if (identity.endpointScope !== run.endpoint_scope || identity.endpointHost !== run.endpoint_host) {
    return { valid: false, reason: "ENDPOINT_MISMATCH" };
  }
  // 3. 官方目录内容哈希。
  if ((input.discoverySourceHash ?? "") !== (run.discovery_source_hash ?? "")) {
    return { valid: false, reason: "DISCOVERY_SOURCE_HASH_MISMATCH" };
  }
  // 4. 模型集 + 复合身份：用同一公式重算 request_hash 做权威比对。
  const expectedHash = probeRequestHash({
    providerCode: input.providerCode,
    mode: input.mode,
    credentialFingerprint: input.credentialFingerprint ?? "",
    endpointScope: identity.endpointScope,
    endpointHost: identity.endpointHost,
    discoverySourceHash: input.discoverySourceHash,
    modelIds: input.modelIds,
  });
  if (expectedHash !== run.request_hash) {
    return { valid: false, reason: "MODEL_SET_MISMATCH" };
  }
  return { valid: true, reason: null };
}

/**
 * 审核修复（P1）：证据身份比对只看当前官方目录仍在列的模型——
 * 快照为官方下架保留的 REMOVED 行不参与（否则下架当次同步的新鲜
 * 证据被立即误判 STALE）。GET 与 confirm 共用，禁止两处各自维护。
 */
export function currentAvailableModelIds(
  items: ReadonlyArray<{ upstream_model: string; availability_status?: string | null }>,
): string[] {
  return items
    .filter((item) => item.availability_status !== "REMOVED")
    .map((item) => item.upstream_model);
}

interface OverlayProbeRun {
  run: {
    finished_at: Date | string | null;
    started_at: Date | string;
    endpoint_scope: string;
    endpoint_host: string;
  };
  items: ReadonlyArray<{
    upstream_model: string;
    validation_status: string;
    http_status: number | null;
    error_code: string | null;
    retryable: boolean;
    checked_at: Date | string | null;
  }>;
}

/**
 * GET /models 的证据回填：身份有效时把 run 的脱敏模型级证据叠加到
 * 公开快照上（仅 READY 可选），并重算 credential_ready/failed 汇总。
 * F-P2-4：证据携带 run 冻结的端点 scope/host，回答"请求打到哪个 host"。
 * 返回 CURRENT 证据状态对象；无效身份由调用方走 STALE 分支。
 */
export function applyProbeEvidenceOverlay(
  publicResult: {
    models: Array<Record<string, unknown> & { id: string }>;
    summary: Record<string, unknown>;
  },
  probeRun: OverlayProbeRun,
): Record<string, unknown> {
  const byModel = new Map(probeRun.items.map((item) => [item.upstream_model, item]));
  publicResult.models = publicResult.models.map((model) => {
    const item = byModel.get(model.id);
    if (!item) return model;
    return {
      ...model,
      credential_validation: {
        status: item.validation_status,
        http_status: item.http_status,
        error_code: item.error_code,
        retryable: item.retryable,
        checked_at: new Date(item.checked_at ?? probeRun.run.finished_at ?? probeRun.run.started_at).toISOString(),
        endpoint_scope: probeRun.run.endpoint_scope,
        endpoint_host: probeRun.run.endpoint_host,
      },
      selectable: item.validation_status === "READY",
    };
  });
  publicResult.summary = {
    ...publicResult.summary,
    credential_ready: publicResult.models.filter((model) => (model.credential_validation as { status: string } | null)?.status === "READY").length,
    // F-P2-10：NOT_RUN（探针上限外未探针）不是失败，不计入 credential_failed。
    credential_failed: publicResult.models.filter((model) => model.credential_validation !== null
      && (model.credential_validation as { status: string } | null)?.status !== "READY"
      && (model.credential_validation as { status: string } | null)?.status !== "NOT_RUN").length,
  };
  return { status: "CURRENT" };
}
