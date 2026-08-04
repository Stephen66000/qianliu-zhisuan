import type { FastifyInstance } from "fastify";
import { EnterpriseReferenceError, IdempotencyConflictError } from "@qianliu/database";
import {
  credentialFingerprint,
  decryptCredential,
  discoverProviderModels,
  encryptCredential,
  providerModelDiscoveryDescriptor,
  ProviderModelDiscoveryError,
  type DiscoveredProviderModel,
  type EncryptedCredential,
} from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  ConfirmDiscoveredModelsSchema,
  ModelDiscoverySchema,
  OnboardResourceSchema,
  isProviderCode,
  onboardingRequestFingerprint,
  operatingSnapshotModeError,
  publicDiscovery,
  selectCompatibleModels,
  sendDiscoveryError,
  toOperatingSnapshotInput,
} from "./contracts.js";

export function registerProviderModelDiscoveryRoutes(app: FastifyInstance): void {
  app.post("/provider-resources/model-discovery", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ModelDiscoverySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: "模型检测参数无效" });
    const provider = (await app.providerRepo.listProviders(req.admin!.enterpriseId))
      .find((item) => item.id === parsed.data.provider_id && item.status === "ACTIVE");
    if (!provider || !isProviderCode(provider.code)) {
      return reply.code(404).send({ error: "provider_not_found", message: "厂商不存在或不受支持" });
    }
    try {
      return publicDiscovery(await discoverProviderModels({
        providerCode: provider.code, mode: parsed.data.mode, credential: parsed.data.credential_plaintext,
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
    const { credential_plaintext, operating_snapshot, selected_model_ids, idempotency_key, ...resource } = parsed.data;
    if (operating_snapshot) {
      const modeError = operatingSnapshotModeError(resource.mode, operating_snapshot);
      if (modeError) return reply.code(400).send({ error: "invalid_operating_mode", message: modeError });
    }
    try {
      const discovery = await discoverProviderModels({
        providerCode: provider.code, mode: resource.mode, credential: credential_plaintext,
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
        target_id: result.resourceId,
        change_summary: { provider: provider.code, models: result.models.map((item) => item.upstreamModel) },
        result: "SUCCESS",
      });
      return reply.code(201).send({ result });
    } catch (cause) {
      if (cause instanceof ProviderModelDiscoveryError) return sendDiscoveryError(reply, cause);
      if (cause instanceof EnterpriseReferenceError) {
        return reply.code(409).send({ error: "invalid_reference", message: "厂商不属于当前企业" });
      }
      if (cause instanceof IdempotencyConflictError) {
        return reply.code(409).send({
          error: "idempotency_conflict",
          message: "该幂等键已用于另一组资源参数，请生成新的幂等键后重试",
        });
      }
      throw cause;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/provider-resources/:id/models", { preHandler: [requireAuth] }, async (req, reply) => {
      const latest = await app.providerRepo.latestModelDiscovery(req.admin!.enterpriseId, req.params.id);
      return latest ?? reply.code(404).send({ error: "not_found", message: "该资源尚无模型同步快照" });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/models/sync", { preHandler: [requireAuth] }, async (req, reply) => {
      const resource = await app.providerRepo.getResourceForModelDiscovery(req.admin!.enterpriseId, req.params.id);
      if (!resource || !isProviderCode(resource.provider_code) || !resource.credential_ciphertext) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在或没有可用凭证" });
      }
      try {
        const credential = decryptCredential(
          JSON.parse(resource.credential_ciphertext) as EncryptedCredential, app.credentialKek,
        );
        const discovery = await discoverProviderModels({
          providerCode: resource.provider_code, mode: resource.mode, credential,
        });
        const saved = await app.providerRepo.recordModelDiscovery(
          req.admin!.enterpriseId, resource.id, discovery,
        );
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.models_sync", target_type: "provider_resource",
          target_id: resource.id, change_summary: { discoveryId: saved.discovery.id, count: saved.items.length },
          result: "SUCCESS",
        });
        return publicDiscovery(discovery);
      } catch (cause) {
        if (!(cause instanceof ProviderModelDiscoveryError)) throw cause;
        const descriptor = providerModelDiscoveryDescriptor(resource.provider_code, resource.mode);
        const failed = await app.providerRepo.recordModelDiscoveryFailure(
          req.admin!.enterpriseId,
          resource.id,
          { ...descriptor, discoveredAt: new Date(), failureCode: cause.code },
        );
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.models_sync",
          target_type: "provider_resource",
          target_id: resource.id,
          change_summary: { discoveryId: failed.id, failureCode: cause.code },
          result: "FAILURE",
        });
        return sendDiscoveryError(reply, cause);
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
        return reply.code(409).send({
          error: "model_discovery_stale", message: "最近一次模型同步失败，请同步成功后再确认接入",
        });
      }
      const candidates = latest.items.map((item): DiscoveredProviderModel => ({
        id: item.upstream_model, displayName: item.display_name, modelType: item.model_type,
        capabilities: item.capabilities, source: item.source, compatible: item.compatible,
        unavailableReason: item.unavailable_reason,
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
        target_id: resource.id, change_summary: { models: models.map((item) => item.upstreamModel) },
        result: "SUCCESS",
      });
      return { models };
    },
  );
}
