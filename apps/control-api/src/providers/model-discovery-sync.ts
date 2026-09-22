/**
 * 模型同步与探针证据落库（自 model-discovery-routes.ts 拆出，体量门禁 P1）。
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  type ModelProbeRunInput,
} from "@qianliu/database";
import {
  builtinProviderModelDiscovery,
  capabilityConfiguredEndpoints,
  credentialFingerprint,
  decryptCredential,
  discoverProviderModels,
  officialSourceConfig,
  providerModelDiscoveryDescriptor,
  ProviderModelDiscoveryError,
  resolveProviderEndpoint,
  type EncryptedCredential,
  type ModelDiscoveryResult,
} from "@qianliu/provider-adapters";
import {
  isProviderCode,
  publicDiscovery,
  publicStoredDiscovery,
  sendDiscoveryError,
} from "./contracts.js";
import { probeRequestHash } from "./probe-evidence.js";

const SYNC_CACHE_TTL_MS = 60_000;

export async function syncResourceModels(
  app: FastifyInstance,
  enterpriseId: string,
  adminUserId: string,
  resourceId: string,
  reply: { code(status: number): { send(body: unknown): unknown } },
): Promise<Record<string, unknown>> {
  const resource = await app.providerRepo.getResourceForModelDiscovery(enterpriseId, resourceId);
  if (!resource || !isProviderCode(resource.provider_code) || !resource.credential_ciphertext) {
    const isolated = await app.db.selectFrom("provider_resource").select("id")
      .where("id", "=", resourceId).where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "CREDENTIAL_INVALID").executeTakeFirst();
    if (isolated) return reply.code(409).send({ error: "credential_isolated",
      message: "资源因 Chat 鉴权失败已隔离，请先在供给与健康中验证当前凭证" }) as Record<string, unknown>;
    return reply.code(404).send({ error: "not_found", message: "资源不存在或没有可用凭证" }) as Record<string, unknown>;
  }
  const latest = await app.providerRepo.latestModelDiscovery(enterpriseId, resource.id);
  const lastChecked = latest?.successful_discovery?.source_checked_at ?? null;
  const hasIncompatibleItems = latest?.items?.some((item) => !item.compatible);
  if (latest?.successful_discovery && !latest.successful_discovery.stale && lastChecked && Date.now() - lastChecked.getTime() < SYNC_CACHE_TTL_MS && !hasIncompatibleItems) {
    const states = await app.providerRepo.modelIntegrationStates(enterpriseId, resource.id, latest.items.map((item) => item.upstream_model));
    return publicStoredDiscovery({
      discovery: latest.successful_discovery,
      items: latest.items,
      itemsStale: false,
      integrationStates: states,
      reused: true,
    });
  }
  try {
    // P2：统一抽取 base_url + endpoints[mode]。
    const configured = capabilityConfiguredEndpoints(
      (resource as { provider_capability_set?: unknown }).provider_capability_set,
    );
    const baseUrl = configured.base_url ?? undefined;
    const credential = decryptResourceCredential(resource.credential_ciphertext, app.credentialKek);
    const discovery = await discoverProviderModels({
      providerCode: resource.provider_code,
      mode: resource.mode,
      credential,
      baseUrl,
      endpoints: configured.endpoints ?? undefined,
      cacheKey: `${enterpriseId}:${resource.id}`,
      forceRefresh: true,
      officialSourceOverrides: officialSourceOverridesFromEnv(),
      probePermissions: true,
    });
    const saved = await app.providerRepo.recordModelDiscovery(enterpriseId, resource.id, discovery);
    // WP04：资源同步探针证据落库（脱敏）。
    await persistProbeRun(app, {
      enterpriseId,
      providerId: resource.provider_id,
      providerResourceId: resource.id,
      providerCode: resource.provider_code,
      mode: resource.mode,
      capabilitySet: (resource as { provider_capability_set?: unknown }).provider_capability_set,
      credential,
      discovery,
    });
    const states = await app.providerRepo.modelIntegrationStates(enterpriseId, resource.id, discovery.models.map((model) => model.id));
    const catalogDiff = saved.catalogDiff ?? { added: [], retained: [], notAdvertised: [] };
    await app.auditRepo.write({
      enterprise_id: enterpriseId, admin_user_id: adminUserId,
      action: "provider_resource.models_sync", target_type: "provider_resource", target_id: resource.id,
      change_summary: {
        source: discovery.source, parser_version: discovery.parserVersion,
        source_url: discovery.sourceUrl, source_content_hash: discovery.sourceContentHash,
        added: catalogDiff.added.length, retained: catalogDiff.retained.length,
        not_advertised: catalogDiff.notAdvertised.length, reused: discovery.reused,
      }, result: "SUCCESS",
    });
    return publicDiscovery({ ...discovery, catalogDiff, integrationStates: states });
  } catch (cause) {
    if (!(cause instanceof ProviderModelDiscoveryError)) throw cause;
    const descriptor = providerModelDiscoveryDescriptor(resource.provider_code, resource.mode);
    const sourceConfig = officialSourceConfig(resource.provider_code, resource.mode, officialSourceOverridesFromEnv());
    const failed = await app.providerRepo.recordModelDiscoveryFailure(enterpriseId, resource.id, {
      ...descriptor,
      sourceUrl: descriptor.source === "OFFICIAL_DOCUMENTATION" ? sourceConfig.coreUrl : null,
      sourceEtag: null,
      sourceLastModified: null,
      sourceContentHash: null,
      sourceCheckedAt: new Date(),
      discoveredAt: new Date(),
      failureCode: cause.code,
    });
    await app.auditRepo.write({
      enterprise_id: enterpriseId, admin_user_id: adminUserId,
      action: "provider_resource.models_sync", target_type: "provider_resource", target_id: resource.id,
      change_summary: { discovery_id: failed.id, failure_code: cause.code, parser_version: cause.parserVersion ?? descriptor.parserVersion },
      result: "FAILURE",
    });
    if (["RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "OFFICIAL_SOURCE_UNAVAILABLE", "OFFICIAL_SOURCE_TOO_LARGE"].includes(cause.code)) {
      const successful = latest?.successful_discovery;
      if (successful && latest.items.length > 0) {
        const states = await app.providerRepo.modelIntegrationStates(enterpriseId, resource.id, latest.items.map((item) => item.upstream_model));
        return publicStoredDiscovery({
          discovery: { ...successful, source: "LAST_SUCCESSFUL_SNAPSHOT", stale: true },
          items: latest.items,
          itemsStale: true,
          integrationStates: states,
          failureCode: cause.code,
        });
      }
      const fallback = builtinProviderModelDiscovery({ providerCode: resource.provider_code, mode: resource.mode });
      if (fallback) {
        fallback.failureCode = cause.code;
        const saved = await app.providerRepo.recordModelDiscovery(enterpriseId, resource.id, fallback);
        const states = await app.providerRepo.modelIntegrationStates(enterpriseId, resource.id, fallback.models.map((model) => model.id));
        return publicDiscovery({ ...fallback, catalogDiff: saved.catalogDiff, integrationStates: states });
      }
    }
    return sendDiscoveryError(reply, cause) as Record<string, unknown>;
  }
}

export function decryptResourceCredential(raw: string, kek: Buffer): string {
  const encrypted = (typeof raw === "string" ? JSON.parse(raw) : raw) as EncryptedCredential;
  return decryptCredential(encrypted, kek);
}

export function officialSourceOverridesFromEnv() {
  return {};
}

/**
 * WP04：将本次权限探针的脱敏证据持久化到 provider_model_probe_run/item。
 * - request_hash 覆盖 凭证 fingerprint + endpoint scope/host + 官方目录哈希 + 模型集，
 *   Key、模式化端点或官方目录任一变化都会使旧探针结果失效；
 * - reused（缓存/singleflight 复用）的发现结果按 discovered_at 幂等，不重复落库；
 * - 写入失败不影响发现快照（仓储层已兜底返回 null）。
 */
export async function persistProbeRun(
  app: { providerRepo: { recordModelProbeRun(input: ModelProbeRunInput): Promise<string | null> };
    log?: { warn?: (obj: unknown, msg: string) => void } },
  input: {
    enterpriseId: string;
    providerId?: string | null;
    providerResourceId?: string | null;
    providerCode: string;
    mode: "API" | "CODING_PLAN";
    capabilitySet: unknown;
    credential: string;
    discovery: ModelDiscoveryResult;
  },
): Promise<void> {
  const probed = input.discovery.models.filter((model) => model.credentialValidation);
  if (probed.length === 0) return;
  // P2：统一抽取 base_url + endpoints[mode]，与发现/验证/恢复/Gateway 同口径。
  const endpoint = resolveProviderEndpoint({
    providerCode: input.providerCode,
    resourceMode: input.mode,
    operation: "MODEL_PERMISSION_PROBE",
    configuredEndpoints: capabilityConfiguredEndpoints(input.capabilitySet),
    env: process.env,
  });
  const endpointScope = endpoint.ok ? endpoint.scope : "ENDPOINT_SCOPE_AMBIGUOUS";
  const endpointHost = endpoint.ok ? endpoint.host : (endpoint.host ?? "unresolved");
  const fingerprint = credentialFingerprint(input.credential);
  const modelIds = input.discovery.models.map((model) => model.id);
  // 终审整改一：request_hash 公式收敛到 probeRequestHash（与 GET/confirm
  // 证据身份校验同源同式，禁止两处各自维护）。
  const requestHash = probeRequestHash({
    providerCode: input.providerCode,
    mode: input.mode,
    credentialFingerprint: fingerprint,
    endpointScope,
    endpointHost,
    discoverySourceHash: input.discovery.sourceContentHash ?? null,
    modelIds,
  });
  // 复用缓存的发现结果时 discoveredAt 相同 → 同一 idempotency_key 不重复落库。
  // P2：idempotency_key 内嵌 request_hash——run 身份完全由 request_hash 派生。
  const idempotencyKey = `${requestHash}:${input.discovery.discoveredAt.toISOString()}`;
  try {
    await app.providerRepo.recordModelProbeRun({
      enterpriseId: input.enterpriseId,
      providerId: input.providerId ?? null,
      providerResourceId: input.providerResourceId ?? null,
      providerCode: input.providerCode,
      resourceMode: input.mode,
      credentialFingerprint: fingerprint,
      endpointScope,
      endpointHost,
      discoverySource: input.discovery.source,
      discoverySourceHash: input.discovery.sourceContentHash,
      parserVersion: input.discovery.parserVersion,
      idempotencyKey,
      requestHash,
      items: probed.map((model) => ({
        upstreamModel: model.id,
        validationStatus: model.credentialValidation!.status,
        httpStatus: model.credentialValidation!.httpStatus,
        errorCode: model.credentialValidation!.errorCode,
        errorCategory: model.credentialValidation!.status,
        retryable: model.credentialValidation!.retryable,
        diagnosticHash: createHash("sha256").update(`${model.id}:${model.credentialValidation!.status}:${model.credentialValidation!.httpStatus ?? ""}`).digest("hex"),
        checkedAt: new Date(model.credentialValidation!.checkedAt),
      })),
    });
  } catch (cause) {
    // P2：写入失败不再静默吞掉（原仓储层 catch(() => null)）。发现快照不受
    // 影响，但错误必须可观测；仅记录错误消息与 request_hash，不含凭证/正文。
    app.log?.warn?.({
      err: cause instanceof Error ? cause.message : String(cause),
      request_hash: requestHash,
    }, "model_probe_run_persist_failed");
  }
}

