import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  ModelValidationInProgressError,
} from "@qianliu/database";
import {
  builtinProviderModelDiscovery,
  credentialFingerprint,
  decryptCredential,
  discoverProviderModels,
  encryptCredential,
  officialSourceConfig,
  providerModelDiscoveryDescriptor,
  ProviderModelDiscoveryError,
  validateProviderModel,
  type DiscoveredProviderModel,
  type EncryptedCredential,
  type HttpFetch,
} from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";
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
  selectCompatibleModels,
  sendDiscoveryError,
  toOperatingSnapshotInput,
} from "./contracts.js";

const SYNC_CACHE_TTL_MS = 60_000;
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
    const capSet = provider.capability_set as Record<string, unknown> | null;
    const baseUrl = typeof capSet?.base_url === "string" ? capSet.base_url : undefined;
    try {
      return publicDiscovery(await discoverProviderModels({
        providerCode: provider.code,
        mode: parsed.data.mode,
        credential: parsed.data.credential_plaintext,
        baseUrl,
        officialSourceOverrides: officialSourceOverridesFromEnv(),
        probePermissions: true,
      }));
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
    const capSet = provider.capability_set as Record<string, unknown> | null;
    const baseUrl = typeof capSet?.base_url === "string" ? capSet.base_url : undefined;
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
        officialSourceOverrides: officialSourceOverridesFromEnv(),
        probePermissions: true,
      });
      const selected = selectCompatibleModels(discovery.models, selected_model_ids);
      if (!selected) {
        return reply.code(409).send({
          error: "model_selection_stale",
          message: "所选模型已不可用或与 Gateway 不兼容，请重新检测",
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
      return { ...publicResult, discovery: latest.discovery, items: latest.items, items_stale: latest.items_stale };
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
      const candidates = latest.items.map((item): DiscoveredProviderModel => ({
        id: item.upstream_model, displayName: item.display_name, modelType: item.model_type,
        capabilities: item.capabilities, source: item.source, compatible: item.compatible,
        unavailableReason: item.unavailable_reason, facts: item.facts as unknown as DiscoveredProviderModel["facts"],
      }));
      const selected = selectCompatibleModels(candidates, parsed.data.selected_model_ids);
      if (!selected) return reply.code(409).send({ error: "model_selection_stale", message: "所选模型不可用，请先同步" });
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
        const capSet = (target as { provider_capability_set?: unknown }).provider_capability_set as Record<string, unknown> | null;
        const baseUrl = typeof capSet?.base_url === "string" ? capSet.base_url : undefined;
        const credential = decryptResourceCredential(target.credential_ciphertext, app.credentialKek);
        evidence = await validateProviderModel({
          providerCode: target.provider_code,
          mode: target.mode,
          resourceId: req.params.resourceId,
          upstreamModel: req.params.upstreamModel,
          credential,
          baseUrl,
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
    const capSet = (resource as { provider_capability_set?: unknown }).provider_capability_set as Record<string, unknown> | null;
    const baseUrl = typeof capSet?.base_url === "string" ? capSet.base_url : undefined;
    const credential = decryptResourceCredential(resource.credential_ciphertext, app.credentialKek);
    const discovery = await discoverProviderModels({
      providerCode: resource.provider_code,
      mode: resource.mode,
      credential,
      baseUrl,
      cacheKey: `${enterpriseId}:${resource.id}`,
      forceRefresh: true,
      officialSourceOverrides: officialSourceOverridesFromEnv(),
      probePermissions: true,
    });
    const saved = await app.providerRepo.recordModelDiscovery(enterpriseId, resource.id, discovery);
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
