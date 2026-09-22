import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  ModelValidationInProgressError,
} from "@qianliu/database";
import {
  capabilityConfiguredEndpoints,
  canonicalProviderCode,
  credentialFingerprint,
  discoverProviderModels,
  encryptCredential,
  ProviderModelDiscoveryError,
  validateProviderModel,
  type DiscoveredProviderModel,
  type HttpFetch,
} from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  decryptResourceCredential,
  officialSourceOverridesFromEnv,
  persistProbeRun,
  syncResourceModels,
} from "./model-discovery-sync.js";
import {
  applyProbeEvidenceOverlay,
  currentAvailableModelIds,
  evaluateProbeEvidenceIdentity,
  probeEndpointIdentity,
} from "./probe-evidence.js";import {
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

const syncFlights = new Map<string, Promise<Record<string, unknown>>>();

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
    // F-P2-13：端点身份公式收敛到 probeEndpointIdentity（与 persistProbeRun/
    // 证据身份校验同源），不再本地复制兜底逻辑。
    const { endpointScope, endpointHost } = probeEndpointIdentity({
      providerCode: provider.code,
      mode: parsed.data.mode,
      capabilitySet: provider.capability_set,
    });
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
      // F-P2-9：资源行改用仓储方法 getResourceForModelDiscovery——与
      // confirm/sync 同一过滤口径（校验 provider/resource 状态），替换原先
      // 内联手写 Kysely join 的胖路由查询（原实现不校验状态且逻辑重复）。
      const resourceRow = await app.providerRepo.getResourceForModelDiscovery(
        req.admin!.enterpriseId, req.params.id,
      );
      if (!resourceRow) return reply.code(404).send({ error: "not_found", message: "资源不存在或当前不可用" });
      const probeRun = await app.providerRepo.latestModelProbeRun(req.admin!.enterpriseId, req.params.id);
      let probeEvidence: Record<string, unknown> | null = null;
      if (probeRun) {
        const identity = evaluateProbeEvidenceIdentity({
          providerCode: resourceRow.provider_code,
          mode: resourceRow.mode as "API" | "CODING_PLAN",
          capabilitySet: resourceRow.provider_capability_set,
          credentialFingerprint: resourceRow.credential_fingerprint,
          discoverySourceHash: snapshot.source_content_hash ?? null,
          modelIds: currentAvailableModelIds(latest.items),
          probeRun,
        });
        probeEvidence = identity.valid
          ? applyProbeEvidenceOverlay(publicResult, probeRun)
          : { status: "MODEL_VALIDATION_STALE", reason: identity.reason, requires: "SYNC_OR_PROBE" };
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
          modelIds: currentAvailableModelIds(latest.items),
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
              // F-P2-4：证据携带 run 冻结的端点 scope/host。
              endpointScope: probeRun!.run.endpoint_scope,
              endpointHost: probeRun!.run.endpoint_host,
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
        // 审核修复（P1）：生产历史 code 可能为 "Zhipu"，严格比较会丢失
        // glm-5.3 专属的 reasoning_effort=max 与工具真实验证。统一规范化后比较。
        const validationProviderCode = canonicalProviderCode(target.provider_code);
        const isGlm53 = validationProviderCode === "zhipu" && req.params.upstreamModel === "glm-5.3";
        evidence = await validateProviderModel({
          providerCode: target.provider_code,
          mode: target.mode,
          resourceId: req.params.resourceId,
          upstreamModel: req.params.upstreamModel,
          credential,
          baseUrl: configured.base_url ?? undefined,
          endpoints: configured.endpoints ?? undefined,
          reasoningEffort: isGlm53 ? "max" : undefined,
          runToolCheck: isGlm53,
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

