/**
 * Provider 生命周期路由（W04）：厂商创建/编辑/删除/归档/恢复，
 * 以及资源删除、归档、恢复（WT-01 凭证不入这些路径）。
 * 由 routes.ts registerProviderRoutes 编排注册，注册顺序与拆分前逐字一致。
 */
import type { FastifyInstance } from "fastify";
import { findKnownProvider } from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";
import { CreateProviderSchema, UpdateProviderSchema } from "./contracts.js";

export function registerProviderLifecycleRoutes(app: FastifyInstance): void {
  // ===== Provider =====
  app.get<{ Querystring: { archived?: string } }>("/providers", { preHandler: [requireAuth] }, async (req) => {
    const archiveFilter = req.query.archived === "only" ? "only" : req.query.archived === "all" ? "all" : "exclude";
    return { providers: await app.providerRepo.listProviders(req.admin!.enterpriseId, archiveFilter) };
  });

  app.post("/providers", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const lowerCode = parsed.data.code.toLowerCase();
    const preset = findKnownProvider(lowerCode);

    let capabilitySet = (parsed.data.capability_set as Record<string, unknown> | undefined) ?? {};
    if (preset && !capabilitySet.base_url) {
      capabilitySet = {
        ...capabilitySet,
        base_url: preset.defaultBaseUrl,
      };
    }

    let adapterType = parsed.data.adapter_type;
    if (adapterType === "deepseek") {
      if (lowerCode === "zhipu") adapterType = "zhipu";
      else if (lowerCode === "kimi") adapterType = "kimi";
    }

    try {
      const provider = await app.providerRepo.createProvider({
        enterprise_id: req.admin!.enterpriseId,
        ...parsed.data,
        adapter_type: adapterType,
        capability_set: Object.keys(capabilitySet).length > 0 ? capabilitySet : undefined,
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "provider.create",
        target_type: "provider",
        target_id: provider.id,
        change_summary: { code: provider.code, name: provider.name },
        result: "SUCCESS",
      });
      return reply.code(201).send({ provider });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string } | null;
      if (pgErr?.code === "23505" || pgErr?.message?.includes("provider_enterprise_code_idx")) {
        return reply.code(409).send({
          error: "provider_code_exists",
          message: `厂商代码 “${parsed.data.code}” 已存在，每个企业内每种厂商只能创建一次。请直接选择已有厂商。`,
        });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/providers/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = UpdateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const updated = await app.providerRepo.updateProvider(
      req.admin!.enterpriseId,
      req.params.id,
      parsed.data,
    );
    if (!updated) {
      return reply.code(404).send({ error: "not_found", message: "厂商不存在" });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider.update",
      target_type: "provider",
      target_id: updated.id,
      change_summary: { code: updated.code, name: updated.name },
      result: "SUCCESS",
    });
    return reply.code(200).send({ provider: updated });
  });

  app.delete<{ Params: { id: string } }>("/providers/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const result = await app.providerRepo.deleteProvider(
      req.admin!.enterpriseId,
      req.params.id,
    );
    if (!result.found) {
      return reply.code(404).send({ error: "not_found", message: "厂商不存在" });
    }
    if (!result.deleted) {
      return reply.code(409).send({ error: "provider_in_use", message: result.reason });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider.delete",
      target_type: "provider",
      target_id: req.params.id,
      change_summary: { code: result.provider?.code, name: result.provider?.name },
      result: "SUCCESS",
    });
    return reply.code(200).send({ deleted: true, provider: result.provider });
  });

  app.delete<{ Params: { id: string } }>("/provider-resources/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const result = await app.providerRepo.deleteResourceSafely(
      req.admin!.enterpriseId,
      req.params.id,
    );
    if (!result.found) {
      return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    }
    if (!result.deleted) {
      return reply.code(409).send({ error: "resource_has_history", message: result.reason });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.delete",
      target_type: "provider_resource",
      target_id: req.params.id,
      change_summary: { name: result.resource?.name, mode: result.resource?.mode },
      result: "SUCCESS",
    });
    return reply.code(200).send({ deleted: true, resource: result.resource });
  });

  app.post<{ Params: { id: string } }>("/providers/:id/archive", { preHandler: [requireAuth] }, async (req, reply) => {
    const result = await app.providerRepo.archiveProvider(req.admin!.enterpriseId, req.params.id);
    if (!result.found) {
      return reply.code(404).send({ error: "not_found", message: "厂商不存在" });
    }
    if (!result.archived) {
      return reply.code(409).send({ error: "provider_archive_blocked", message: result.reason ?? "厂商已归档或不可归档" });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider.archive",
      target_type: "provider",
      target_id: req.params.id,
      change_summary: { code: result.provider?.code, name: result.provider?.name },
      result: "SUCCESS",
    });
    return reply.code(200).send({ archived: true, provider: result.provider });
  });

  app.post<{ Params: { id: string } }>("/providers/:id/unarchive", { preHandler: [requireAuth] }, async (req, reply) => {
    const restored = await app.providerRepo.unarchiveProvider(req.admin!.enterpriseId, req.params.id);
    if (!restored) {
      return reply.code(404).send({ error: "not_found", message: "厂商不存在或未归档" });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider.unarchive",
      target_type: "provider",
      target_id: req.params.id,
      change_summary: { code: restored.code, name: restored.name },
      result: "SUCCESS",
    });
    return reply.code(200).send({ archived: false, provider: restored });
  });

  app.post<{ Params: { id: string } }>("/provider-resources/:id/archive", { preHandler: [requireAuth] }, async (req, reply) => {
    const archived = await app.providerRepo.archiveResource(req.admin!.enterpriseId, req.params.id);
    if (!archived) {
      return reply.code(404).send({ error: "not_found", message: "资源不存在或已归档" });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.archive",
      target_type: "provider_resource",
      target_id: req.params.id,
      change_summary: { name: archived.name, mode: archived.mode },
      result: "SUCCESS",
    });
    return reply.code(200).send({ archived: true, resource: { id: archived.id, name: archived.name, mode: archived.mode } });
  });

  app.post<{ Params: { id: string } }>("/provider-resources/:id/unarchive", { preHandler: [requireAuth] }, async (req, reply) => {
    const restored = await app.providerRepo.unarchiveResource(req.admin!.enterpriseId, req.params.id);
    if (!restored) {
      return reply.code(404).send({ error: "not_found", message: "资源不存在或未归档" });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.unarchive",
      target_type: "provider_resource",
      target_id: req.params.id,
      change_summary: { name: restored.name, mode: restored.mode },
      result: "SUCCESS",
    });
    return reply.code(200).send({ archived: false, resource: { id: restored.id, name: restored.name, mode: restored.mode } });
  });
}
