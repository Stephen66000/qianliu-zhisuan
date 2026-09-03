/**
 * Provider/Resource/Model/Route 路由（W04）。
 *
 * 依据：TRD §5.4、§11.2（/providers /provider-resources /unified-models /model-routes）。
 * WT-01：登记资源账号（凭证加密存储，列表只返回指纹）。
 * WT-10：统一模型路由详情（候选、优先级、权重）。
 *
 * 安全：上游凭证明文绝不入 DB、绝不返回 API。createResource 接收明文 → 加密 → 存密文+指纹。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  credentialFingerprint,
  encryptCredential,
} from "@qianliu/provider-adapters";
import { EnterpriseReferenceError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  CreateProviderSchema,
  CreateResourceSchema,
  CreateRouteSchema,
  CreateUnifiedModelSchema,
  financeManagedOperatingSnapshotError,
  operatingSnapshotModeError,
  toOperatingSnapshotInput,
} from "./contracts.js";
import { registerProviderModelDiscoveryRoutes } from "./model-discovery-routes.js";
import { registerProviderQuotaWindowRoutes } from "./quota-window-routes.js";
import { registerProviderHealthRoutes } from "./health-routes.js";
import { registerProviderUsageOverviewRoutes } from "./usage-overview-routes.js";
import { financeReadModelEnabled, shanghaiMonthAt } from "../provider-finance/dashboard-projection.js";

export function registerProviderRoutes(app: FastifyInstance): void {
  registerProviderModelDiscoveryRoutes(app);
  registerProviderQuotaWindowRoutes(app);
  registerProviderHealthRoutes(app);
  registerProviderUsageOverviewRoutes(app);
  // ===== Provider =====
  app.get("/providers", { preHandler: [requireAuth] }, async (req) => {
    return { providers: await app.providerRepo.listProviders(req.admin!.enterpriseId) };
  });

  app.post("/providers", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const provider = await app.providerRepo.createProvider({
      enterprise_id: req.admin!.enterpriseId,
      ...parsed.data,
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
  });

  // ===== Provider Resource（凭证加密存储）=====
  app.get("/provider-resources", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const now = new Date();
    const financeRead = await financeReadModelEnabled(
      app.providerFinanceMode, app.providerFinanceRepo, enterpriseId,
    );
    const [resources, snapshots, syncStates, financeViews] = await Promise.all([
      app.providerRepo.listResources(enterpriseId),
      app.providerRepo.listCurrentOperatingSnapshots(enterpriseId),
      app.providerRepo.listLatestOperatingSyncStates(enterpriseId),
      !financeRead ? []
        : app.providerFinanceRepo.listResourceFinanceViews(enterpriseId, shanghaiMonthAt(now), now),
    ]);
    const byResource = new Map(snapshots.map((snapshot) => [
      snapshot.provider_resource_id,
      snapshot,
    ]));
    const syncByResource = new Map(syncStates.map((state) => [state.provider_resource_id, state]));
    const financeByResource = new Map(financeViews.map((view) => [view.resourceId, view]));
    const staleBefore = Date.now() - 36 * 60 * 60 * 1_000;
    // 列表只返回指纹，绝不返回密文/明文
    return {
      resources: resources.map((r) => {
        const sync = syncByResource.get(r.id);
        const lastSuccessAt = sync?.last_success_data_at ?? null;
        return ({
        id: r.id,
        provider_id: r.provider_id,
        name: r.name,
        mode: r.mode,
        credential_type: r.credential_type,
        credential_fingerprint: r.credential_fingerprint,
        credential_version: r.credential_version,
        status: r.status,
        // POOL-031：资源健康详情字段（脱敏运行元数据，不含凭证/正文）。
        consecutive_failures: r.consecutive_failures,
        cooldown_until: r.cooldown_until?.toISOString() ?? null,
        last_probe_at: r.last_probe_at?.toISOString() ?? null,
        credential_refresh_status: r.credential_refresh_status,
        refresh_error_classification: r.refresh_error_classification ?? null,
        credential_expires_at: r.credential_expires_at?.toISOString() ?? null,
        resource_pool_id: r.resource_pool_id ?? null,
        upstream_models: r.upstream_models,
        concurrency_limit: r.concurrency_limit,
        version: r.version,
        monthly_budget_amount: r.monthly_budget_amount,
        monthly_budget_currency: r.monthly_budget_currency,
        created_at: r.created_at,
        updated_at: r.updated_at,
        operating_snapshot: byResource.get(r.id) ?? null,
        finance: financeByResource.get(r.id) ?? null,
        operating_sync: sync ? {
          balance_status: sync.balance_status,
          cost_status: sync.cost_status,
          data_status: !lastSuccessAt || lastSuccessAt.getTime() < staleBefore ? "STALE" : "FRESH",
          provider_data_at: sync.provider_data_at?.toISOString() ?? null,
          last_success_data_at: lastSuccessAt?.toISOString() ?? null,
          completed_at: sync.completed_at.toISOString(),
          next_sync_at: sync.next_sync_at.toISOString(),
          error_code: sync.error_code,
          failure_reason: sync.failure_reason,
          adapter_version: sync.adapter_version,
        } : {
          balance_status: "NOT_SUPPORTED",
          cost_status: "NOT_SUPPORTED",
          data_status: "STALE",
          provider_data_at: null,
          last_success_data_at: null,
          completed_at: null,
          next_sync_at: null,
          error_code: "SYNC_NOT_RUN",
          failure_reason: "尚未执行每日经营数据同步",
          adapter_version: null,
        },
      }); }),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/provider-resources/:id/operating-snapshots",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const limit = Number(req.query.limit ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({ error: "invalid_request", message: "limit 必须为 1-100" });
      }
      const resource = (await app.providerRepo.listResources(req.admin!.enterpriseId))
        .find((item) => item.id === req.params.id);
      if (!resource) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      return {
        snapshots: await app.providerRepo.listOperatingSnapshotHistory(
          req.admin!.enterpriseId,
          resource.id,
          limit,
        ),
      };
    },
  );

  app.post("/provider-resources", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const { credential_plaintext, operating_snapshot, ...rest } = parsed.data;
    if (operating_snapshot) {
      const financeError = app.providerFinanceMode === "OFF" ? null
        : financeManagedOperatingSnapshotError(rest.mode, operating_snapshot);
      if (financeError) return reply.code(409).send({
        error: "finance_entry_moved", message: financeError,
      });
      const modeError = operatingSnapshotModeError(rest.mode, operating_snapshot);
      if (modeError) {
        return reply.code(400).send({ error: "invalid_operating_mode", message: modeError });
      }
    }

    // 立即加密明文（绝不入库明文）
    const encrypted = encryptCredential(credential_plaintext, app.credentialKek);
    const fingerprint = credentialFingerprint(credential_plaintext);

    let resource;
    try {
      resource = await app.providerRepo.createResource({
        enterprise_id: req.admin!.enterpriseId,
        credential_encrypted: encrypted,
        credential_fingerprint: fingerprint,
        operating_snapshot: operating_snapshot
          ? toOperatingSnapshotInput(operating_snapshot, rest.mode)
          : undefined,
        ...rest,
      });
    } catch (error) {
      if (error instanceof EnterpriseReferenceError) {
        return reply.code(409).send({
          error: "invalid_reference",
          message: "厂商不存在、已停用或不属于当前企业",
        });
      }
      throw error;
    }

    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.create",
      target_type: "provider_resource",
      target_id: resource.id,
      change_summary: { name: resource.name, mode: resource.mode, credential_fingerprint: fingerprint },
      result: "SUCCESS",
    });

    // 响应只返回指纹（明文不回显）
    return reply.code(201).send({
      resource: {
        id: resource.id,
        provider_id: resource.provider_id,
        name: resource.name,
        mode: resource.mode,
        credential_type: resource.credential_type,
        credential_fingerprint: resource.credential_fingerprint,
        credential_version: resource.credential_version,
        status: resource.status,
        upstream_models: resource.upstream_models,
        concurrency_limit: resource.concurrency_limit,
        version: resource.version,
        monthly_budget_amount: resource.monthly_budget_amount,
        monthly_budget_currency: resource.monthly_budget_currency,
        created_at: resource.created_at,
        updated_at: resource.updated_at,
        operating_snapshot: operating_snapshot
          ? (await app.providerRepo.listCurrentOperatingSnapshots(req.admin!.enterpriseId))
              .find((snapshot) => snapshot.provider_resource_id === resource.id) ?? null
          : null,
      },
    });
  });

  // ===== Unified Model =====
  app.get<{ Querystring: { archived?: string } }>("/unified-models", { preHandler: [requireAuth] }, async (req, reply) => {
    const archived = z.enum(["exclude", "only", "all"]).default("exclude").safeParse(req.query.archived);
    if (!archived.success) {
      return reply.code(400).send({ error: "invalid_request", message: "归档筛选无效" });
    }
    return { models: await app.providerRepo.listUnifiedModels(req.admin!.enterpriseId, archived.data) };
  });

  app.post("/unified-models", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateUnifiedModelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const model = await app.providerRepo.createUnifiedModel(
      req.admin!.enterpriseId,
      parsed.data.alias,
      parsed.data.display_name,
      parsed.data.required_capabilities ?? null,
    );
    // W19 补齐：创建统一模型写操作日志（六要素 §11.2）
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "unified_model.create",
      target_type: "unified_model",
      target_id: model.id,
      change_summary: { alias: model.alias, display_name: model.display_name },
      result: "SUCCESS",
    });
    return reply.code(201).send({ model });
  });

  // ===== Model Route（WT-10 路由详情）=====
  app.post("/model-routes", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateRouteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    let route;
    try {
      route = await app.providerRepo.createRoute(
        req.admin!.enterpriseId,
        parsed.data.unified_model_id,
        parsed.data.provider_resource_id,
        parsed.data.upstream_model,
        { priority: parsed.data.priority, weight: parsed.data.weight, enabled: parsed.data.enabled },
      );
    } catch (error) {
      if (error instanceof EnterpriseReferenceError) {
        return reply.code(409).send({
          error: "invalid_reference",
          message: "统一模型或厂商资源不存在、未启用或不属于当前企业",
        });
      }
      throw error;
    }
    // W19 补齐：创建模型路由写操作日志（六要素 §11.2）
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "model_route.create",
      target_type: "model_route",
      target_id: route.id,
      change_summary: {
        unified_model_id: route.unified_model_id,
        provider_resource_id: route.provider_resource_id,
        upstream_model: route.upstream_model,
        priority: route.priority,
        weight: route.weight,
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({ route });
  });

  // 路由详情：候选、优先级、权重（WT-10）
  app.get<{ Params: { modelId: string }; Querystring: { archived?: string } }>(
    "/unified-models/:modelId/routes",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const archived = z.enum(["exclude", "only", "all"]).default("exclude").safeParse(req.query.archived);
      if (!archived.success) {
        return reply.code(400).send({ error: "invalid_request", message: "归档筛选无效" });
      }
      const routes = await app.providerRepo.listRoutesByModel(
        req.admin!.enterpriseId,
        req.params.modelId,
        archived.data,
      );
      return { routes };
    },
  );
}
