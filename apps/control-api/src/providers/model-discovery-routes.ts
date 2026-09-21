import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  ModelValidationInProgressError,
  type ModelProbeRunInput,
} from "@qianliu/database";
import {
  builtinProviderModelDiscovery,
  capabilityConfiguredEndpoints,
  credentialFingerprint,
  decryptCredential,
  discoverProviderModels,
  encryptCredential,
  officialSourceConfig,
  providerModelDiscoveryDescriptor,
  ProviderModelDiscoveryError,
  resolveProviderEndpoint,
  validateProviderModel,
  type DiscoveredProviderModel,
  type EncryptedCredential,
  type HttpFetch,
  type ModelDiscoveryResult,
} from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";
import { evaluateProbeEvidenceIdentity, probeRequestHash } from "./probe-evidence.js";
import {
  ConfirmDiscoveredModelsSchema,
  ModelDiscoverySchema,
  ModelValidationSchema,
  OnboardResourceSchema,
  financeManagedOperatingSnapshotError,
  isProviderCode,
  onboardingRequestFingerprint,
  operatingSnapshotModeError,
  publicDiscovery,
  publicStoredDiscovery,
  selectReadyModels,
  sendDiscoveryError,
  toOperatingSnapshotInput,
} from "./contracts.js";

const SYNC_CACHE_TTL_MS = 60_000;
const syncFlights = new Map<string, Promise<Record<string, unknown>>>();

/**
 * WP04：将本次权限探针的脱敏证据持久化到 provider_model_probe_run/item。
 * - request_hash 覆盖 凭证 fingerprint + endpoint scope/host + 官方目录哈希 + 模型集，
 *   Key、模式化端点或官方目录任一变化都会使旧探针结果失效；
 * - reused（缓存/singleflight 复用）的发现结果按 discovered_at 幂等，不重复落库；
 * - 写入失败不影响发现快照（仓储层已兜底返回 null）。
 */
async function persistProbeRun(
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
    } as never);
  } catch (cause) {
    // P2：写入失败不再静默吞掉（原仓储层 catch(() => null)）。发现快照不受
    // 影响，但错误必须可观测；仅记录错误消息与 request_hash，不含凭证/正文。
    app.log?.warn?.({
      err: cause instanceof Error ? cause.message : String(cause),
      request_hash: requestHash,
    }, "model_probe_run_persist_failed");
  }
}

export function registerProviderModelDiscoveryRoutes(app: FastifyInstance): void {
  app.post("/provider-resources/model-discovery", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ModelDiscoverySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: "模型检测参数无效" });
    const provider = (await app.providerRepo.listProviders(req.admin!.enterpriseId))
      .find((item) => item.id === parsed.data.provider_id && item.status === "ACTIVE");
    if (!provider || !isProviderCode(provider.code)) {
      return reply.code(404).send({ error: "provider_not_found", message: "厂商不存在或不受支持" });
    }
    const configured = capabilityConfiguredEndpoints(provider.capability_set);
    const baseUrl = configured.base_url ?? undefined;
    // P2：cacheKey/singleflight 口径 = enterprise + provider + mode +
    // credential fingerprint + endpoint scope/host。同企业、同厂商、同模式、
    // 同凭证、同端点的并发/60s 内重复检测共享同一次发现与探针飞行，
    // 不重复打上游；Key、模式化端点或端点归属任一变化即产生新飞行。
    const fingerprint = credentialFingerprint(parsed.data.credential_plaintext);
    const endpoint = resolveProviderEndpoint({
      providerCode: provider.code,
      resourceMode: parsed.data.mode,
      operation: "MODEL_PERMISSION_PROBE",
      configuredEndpoints: configured,
      env: process.env,
    });
    const endpointScope = endpoint.ok ? endpoint.scope : "ENDPOINT_SCOPE_AMBIGUOUS";
    const endpointHost = endpoint.ok ? endpoint.host : (endpoint.host ?? "unresolved");
    const cacheKey = [
      req.admin!.enterpriseId, provider.id, parsed.data.mode,
      fingerprint, endpointScope, endpointHost,
    ].join(":");
    try {
      const discovery = await discoverProviderModels({
        providerCode: provider.code,
        mode: parsed.data.mode,
        credential: parsed.data.credential_plaintext,
        baseUrl,
        endpoints: configured.endpoints ?? undefined,
        cacheKey,
        officialSourceOverrides: officialSourceOverridesFromEnv(),
        probePermissions: true,
      });
      // P2：ad-hoc 检测同样落探针证据（未绑定资源 → provider_resource_id=null）。
      // reused 结果 discoveredAt 相同 → 同一 idempotency_key 幂等去重；
      // 落库内容仅指纹/scope/host/状态/HTTP/错误码/诊断哈希，无 Key、
      // Authorization、Prompt 或原始错误正文。
      await persistProbeRun(app, {
        enterpriseId: req.admin!.enterpriseId,
        providerId: provider.id,
        providerResourceId: null,
        providerCode: provider.code,
        mode: parsed.data.mode,
        capabilitySet: provider.capability_set,
        credential: parsed.data.credential_plaintext,
        discovery,
      });
      return publicDiscovery(discovery);
    } catch (cause) {
      return sendDiscoveryError(reply, cause);
    }
  });

  app.post("/provider-resources/onboard", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = OnboardResourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: "资源接入参数无效" });
    const provider = (await app.providerRepo.listProviders(req.admin!.enterpriseId))
      .find((item) => item.id === parsed.data.provider_id && item.status === "ACTIVE");
    if (!provider || !isProviderCode(provider.code)) {
      return reply.code(404).send({ error: "provider_not_found", message: "厂商不存在或不受支持" });
    }
    const configured = capabilityConfiguredEndpoints(provider.capability_set);
    const baseUrl = configured.base_url ?? undefined;
    const { credential_plaintext, operating_snapshot, selected_model_ids, idempotency_key, ...resource } = parsed.data;
    if (operating_snapshot) {
      const financeError = app.providerFinanceMode === "OFF" ? null
        : financeManagedOperatingSnapshotError(resource.mode, operating_snapshot);
      if (financeError) return reply.code(409).send({
        error: "finance_entry_moved", message: financeError,
      });
      const modeError = operatingSnapshotModeError(resource.mode, operating_snapshot);
      if (modeError) return reply.code(400).send({ error: "invalid_operating_mode", message: modeError });
    }
    try {
      const discovery = await discoverProviderModels({
        providerCode: provider.code,
        mode: resource.mode,
        credential: credential_plaintext,
        baseUrl,
        endpoints: configured.endpoints ?? undefined,
        officialSourceOverrides: officialSourceOverridesFromEnv(),
        probePermissions: true,
      });
      // P1：只有探针 READY 的模型可 onboard；fresh discovery 带 credentialValidation。
      const selected = selectReadyModels(discovery.models, selected_model_ids);
      if (!selected) {
        return reply.code(409).send({
          error: "model_selection_stale",
          message: "所选模型未通过凭证探针验证（仅 READY 可确认），请重新检测后再接入",
        });
      }
      const result = await app.providerRepo.onboardResourceModels({
        enterpriseId: req.admin!.enterpriseId,
        idempotencyKey: idempotency_key,
        requestFingerprint: onboardingRequestFingerprint({
          providerCode: provider.code,
          providerId: resource.provider_id,
          name: resource.name,
          mode: resource.mode,
          credentialType: resource.credential_type,
          credentialFingerprint: credentialFingerprint(credential_plaintext),
          concurrencyLimit: resource.concurrency_limit,
          operatingSnapshot: operating_snapshot,
          selectedModelIds: selected_model_ids,
        }),
        providerCode: provider.code,
        resource: {
          enterprise_id: req.admin!.enterpriseId,
          ...resource,
          credential_encrypted: encryptCredential(credential_plaintext, app.credentialKek),
          credential_fingerprint: credentialFingerprint(credential_plaintext),
          operating_snapshot: operating_snapshot
            ? toOperatingSnapshotInput(operating_snapshot, resource.mode) : undefined,
        },
        discovery,
        selectedModels: selected,
      });
      // WP04：接入后绑定 resource 的探针证据落库。
      await persistProbeRun(app, {
        enterpriseId: req.admin!.enterpriseId,
        providerId: provider.id,
        providerResourceId: result.resourceId,
        providerCode: provider.code,
        mode: resource.mode,
        capabilitySet: provider.capability_set,
        credential: credential_plaintext,
        discovery,
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "provider_resource.model_onboard", target_type: "provider_resource",
        target_id: result.resourceId, change_summary: { provider: provider.code, models: result.models.map((item) => item.upstreamModel) },
        result: "SUCCESS",
      });
      return reply.code(201).send({ result });
    } catch (cause) {
      if (cause instanceof ProviderModelDiscoveryError) return sendDiscoveryError(reply, cause);
      if (cause instanceof EnterpriseReferenceError) return reply.code(409).send({ error: "invalid_reference", message: "厂商不属于当前企业" });
      if (cause instanceof IdempotencyConflictError) return reply.code(409).send({ error: "idempotency_conflict", message: "该幂等键已用于另一组资源参数，请生成新的幂等键后重试" });
      throw cause;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/provider-resources/:id/models", { preHandler: [requireAuth] }, async (req, reply) => {
      const latest = await app.providerRepo.latestModelDiscovery(req.admin!.enterpriseId, req.params.id);
      if (!latest) return reply.code(404).send({ error: "not_found", message: "该资源尚无模型同步快照" });
      const snapshot = latest.successful_discovery ?? latest.discovery;
      const states = await app.providerRepo.modelIntegrationStates(
        req.admin!.enterpriseId, req.params.id, latest.items.map((item) => item.upstream_model),
      );
      const publicResult = publicStoredDiscovery({
        discovery: snapshot,
        items: latest.items,
        itemsStale: latest.items_stale,
        integrationStates: states,
        failureCode: latest.discovery.failure_code,
      });
      // 终审整改一：READY 探针证据必须与当前资源（凭证指纹 + 解析端点）
      // 和当前成功发现（目录哈希 + 模型集 + 新鲜度）身份一致才可回填；
      // 不一致即 MODEL_VALIDATION_STALE——不回填任何 READY 证据，
      // 页面模型全部不可选，要求重新同步或重新检测。
      const resourceRow = await app.db.selectFrom("provider_resource")
        .innerJoin("provider", "provider.id", "provider_resource.provider_id")
        .select([
          "provider_resource.credential_fingerprint",
          "provider_resource.mode",
          "provider.code as provider_code",
          "provider.capability_set as provider_capability_set",
        ])
        .where("provider_resource.id", "=", req.params.id)
        .where("provider_resource.enterprise_id", "=", req.admin!.enterpriseId)
        .where("provider.enterprise_id", "=", req.admin!.enterpriseId)
        .executeTakeFirst();
      const probeRun = await app.providerRepo.latestModelProbeRun(req.admin!.enterpriseId, req.params.id);
      let probeEvidence: Record<string, unknown> | null = null;
      if (probeRun) {
        const identity = evaluateProbeEvidenceIdentity({
          providerCode: resourceRow?.provider_code ?? "",
          mode: (resourceRow?.mode ?? "API") as "API" | "CODING_PLAN",
          capabilitySet: resourceRow?.provider_capability_set ?? null,
          credentialFingerprint: resourceRow?.credential_fingerprint ?? null,
          discoverySourceHash: snapshot.source_content_hash ?? null,
          modelIds: latest.items.map((item) => item.upstream_model),
          probeRun,
        });
        if (!identity.valid) {
          probeEvidence = { status: "MODEL_VALIDATION_STALE", reason: identity.reason,
            requires: "SYNC_OR_PROBE" };
        } else {
          probeEvidence = { status: "CURRENT" };
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
                checked_at: (item.checked_at ?? probeRun.run.finished_at ?? probeRun.run.started_at).toISOString(),
              },
              selectable: item.validation_status === "READY",
            };
          });
          publicResult.summary = {
            ...publicResult.summary,
            credential_ready: publicResult.models.filter((model) => model.credential_validation?.status === "READY").length,
            credential_failed: publicResult.models.filter((model) => model.credential_validation !== null && model.credential_validation.status !== "READY").length,
          };
        }
      }
      return { ...publicResult, probe_evidence: probeEvidence,
        discovery: latest.discovery, items: latest.items, items_stale: latest.items_stale };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/models/sync", { preHandler: [requireAuth] }, async (req, reply) => {
      const enterpriseId = req.admin!.enterpriseId;
      const key = `${enterpriseId}:${req.params.id}`;
      const existingFlight = syncFlights.get(key);
      if (existingFlight) return { ...(await existingFlight), reused: true };
      const flight = syncResourceModels(app, enterpriseId, req.admin!.adminUserId, req.params.id, reply);
      syncFlights.set(key, flight);
      try {
        return await flight;
      } finally {
        syncFlights.delete(key);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/models/confirm", { preHandler: [requireAuth] }, async (req, reply) => {
      const parsed = ConfirmDiscoveredModelsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: "请选择至少一个模型" });
      const [resource, latest] = await Promise.all([
        app.providerRepo.getResourceForModelDiscovery(req.admin!.enterpriseId, req.params.id),
        app.providerRepo.latestModelDiscovery(req.admin!.enterpriseId, req.params.id),
      ]);
      if (!resource || !latest || !isProviderCode(resource.provider_code)) {
        return reply.code(404).send({ error: "not_found", message: "资源或模型快照不存在" });
      }
      if (latest.items_stale) {
        return reply.code(409).send({ error: "model_discovery_stale", message: "最近一次模型同步失败或来源已过期，请同步成功后再确认接入" });
      }
      // P1：用最近一次探针运行回填模型级 credentialValidation，
      // 确认门槛与 GET /models 展示一致（仅 READY 可确认）。
      const probeRun = await app.providerRepo.latestModelProbeRun(req.admin!.enterpriseId, req.params.id);
      // 终审整改一：READY 证据身份必须与当前资源/当前成功发现一致，
      // 否则 409 MODEL_VALIDATION_STALE，要求重新同步或重新检测。
      if (probeRun) {
        const identity = evaluateProbeEvidenceIdentity({
          providerCode: resource.provider_code,
          mode: resource.mode as "API" | "CODING_PLAN",
          capabilitySet: resource.provider_capability_set,
          credentialFingerprint: resource.credential_fingerprint,
          discoverySourceHash: (latest.successful_discovery ?? latest.discovery).source_content_hash ?? null,
          modelIds: latest.items.map((item) => item.upstream_model),
          probeRun,
        });
        if (!identity.valid) {
          return reply.code(409).send({ error: "MODEL_VALIDATION_STALE", reason: identity.reason,
            message: "探针证据与当前凭证/端点/官方目录不一致或已过期，请重新同步模型或重新检测" });
        }
      }
      const evidenceByModel = new Map((probeRun?.items ?? []).map((item) => [item.upstream_model, item]));
      const candidates = latest.items.map((item): DiscoveredProviderModel => {
        const evidence = evidenceByModel.get(item.upstream_model);
        return {
          id: item.upstream_model, displayName: item.display_name, modelType: item.model_type,
          capabilities: item.capabilities, source: item.source, compatible: item.compatible,
          unavailableReason: item.unavailable_reason, facts: item.facts as unknown as DiscoveredProviderModel["facts"],
          ...(evidence ? {
            credentialValidation: {
              status: evidence.validation_status,
              httpStatus: evidence.http_status,
              errorCode: evidence.error_code,
              retryable: evidence.retryable,
              checkedAt: (evidence.checked_at ?? probeRun!.run.finished_at ?? probeRun!.run.started_at ?? new Date()).toISOString(),
            },
          } : {}),
        };
      });
      const selected = selectReadyModels(candidates, parsed.data.selected_model_ids);
      if (!selected) return reply.code(409).send({ error: "model_selection_stale",
        message: "所选模型未通过凭证探针验证（仅 READY 可确认），请先同步模型" });
      const models = await app.providerRepo.attachDiscoveredModels({
        enterpriseId: req.admin!.enterpriseId, providerCode: resource.provider_code,
        resourceId: resource.id, models: selected,
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "provider_resource.models_confirm", target_type: "provider_resource",
        target_id: resource.id, change_summary: { models: models.map((item) => item.upstreamModel) }, result: "SUCCESS",
      });
      return { models };
    },
  );

  app.post<{ Params: { resourceId: string; upstreamModel: string } }>(
    "/provider-resources/:resourceId/models/:upstreamModel/validate", { preHandler: [requireAuth] }, async (req, reply) => {
      const parsed = ModelValidationSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "validation_confirmation_required", message: "真实验证会消耗少量厂商额度，请确认后重试" });
      const enterpriseId = req.admin!.enterpriseId;
      const target = await app.providerRepo.validationTarget(enterpriseId, req.params.resourceId, req.params.upstreamModel);
      if (!target || !isProviderCode(target.provider_code) || !target.credential_ciphertext) {
        return reply.code(404).send({ error: "not_found", message: "模型路由不存在或资源没有可用凭证" });
      }
      const requestFingerprint = createHash("sha256").update(JSON.stringify({
        enterpriseId, resourceId: req.params.resourceId, upstreamModel: req.params.upstreamModel,
      })).digest("hex");
      let started;
      try {
        started = await app.providerRepo.beginModelValidation({
          enterpriseId, resourceId: req.params.resourceId, unifiedModelId: target.unified_model_id,
          upstreamModel: req.params.upstreamModel, idempotencyKey: parsed.data.idempotency_key, requestFingerprint,
        });
      } catch (cause) {
        if (cause instanceof ModelValidationInProgressError) return reply.code(409).send({ error: "MODEL_VALIDATION_IN_PROGRESS", message: "该模型正在验证中，请等待当前验证完成" });
        if (cause instanceof IdempotencyConflictError) return reply.code(409).send({ error: "idempotency_conflict", message: "该幂等键已用于另一组验证参数" });
        if (cause instanceof EnterpriseReferenceError) return reply.code(404).send({ error: "not_found", message: "模型路由不存在" });
        throw cause;
      }
      if (started.replay) {
        if (started.validation.status === "IN_PROGRESS") return reply.code(409).send({ error: "MODEL_VALIDATION_IN_PROGRESS", message: "该模型正在验证中，请等待当前验证完成" });
        return { validation: started.validation.result };
      }
      const validationId = started.validation.id;
      const requestId = `mdv-${randomUUID()}`;
      let evidence;
      try {
        // P2：统一抽取 base_url + endpoints[mode]，模式专属地址经同一策略生效。
        const configured = capabilityConfiguredEndpoints(
          (target as { provider_capability_set?: unknown }).provider_capability_set,
        );
        const credential = decryptResourceCredential(target.credential_ciphertext, app.credentialKek);
        evidence = await validateProviderModel({
          providerCode: target.provider_code,
          mode: target.mode,
          resourceId: req.params.resourceId,
          upstreamModel: req.params.upstreamModel,
          credential,
          baseUrl: configured.base_url ?? undefined,
          endpoints: configured.endpoints ?? undefined,
          reasoningEffort: target.provider_code === "zhipu" && req.params.upstreamModel === "glm-5.3" ? "max" : undefined,
          runToolCheck: target.provider_code === "zhipu" && req.params.upstreamModel === "glm-5.3",
          fetch: globalThis.fetch as unknown as HttpFetch,
          env: process.env,
          requestId,
        });
      } catch {
        const now = new Date().toISOString();
        evidence = {
          validationId,
          requestId,
          upstreamModel: req.params.upstreamModel,
          status: "FAILED" as const,
          checks: [],
          errorCode: "VALIDATION_EXECUTION_FAILED",
          startedAt: now,
          finishedAt: now,
        };
      }
      const result = { ...evidence, validationId };
      await app.providerRepo.finishModelValidation(enterpriseId, validationId, evidence.status, result);
      await app.auditRepo.write({
        enterprise_id: enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "provider_resource.model_validate", target_type: "model_route", target_id: target.route_id,
        change_summary: {
          upstream_model: req.params.upstreamModel,
          validation_id: validationId,
          status: evidence.status,
          request_id: evidence.requestId,
          error_code: evidence.errorCode,
        },
        result: evidence.status === "SUCCEEDED" ? "SUCCESS" : "FAILURE",
      });
      return { validation: result };
    },
  );
}

async function syncResourceModels(
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

function decryptResourceCredential(raw: string, kek: Buffer): string {
  const encrypted = (typeof raw === "string" ? JSON.parse(raw) : raw) as EncryptedCredential;
  return decryptCredential(encrypted, kek);
}

function officialSourceOverridesFromEnv() {
  return {};
}
