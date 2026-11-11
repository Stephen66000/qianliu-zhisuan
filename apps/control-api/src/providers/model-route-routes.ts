/**
 * 统一模型与模型路由路由（W04 / WT-10）：
 * /unified-models、/model-routes、/unified-models/:modelId/routes、
 * /provider-resources/:id/routes 及其 retire/restore（一键下架/恢复上架）。
 * 由 routes.ts registerProviderRoutes 编排注册，注册顺序与拆分前逐字一致。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EnterpriseReferenceError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import { CreateRouteSchema, CreateUnifiedModelSchema } from "./contracts.js";

export function registerModelRouteRoutes(app: FastifyInstance): void {
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

  // 资源下模型路由列表（含统一模型与生效计价状态，供厂商资源管理模型）
  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>(
    "/provider-resources/:id/routes",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const archived = z.enum(["exclude", "only", "all"]).default("all").safeParse(req.query.archived);
      if (!archived.success) {
        return reply.code(400).send({ error: "invalid_request", message: "归档筛选无效" });
      }
      const routes = await app.providerRepo.listRoutesByResource(
        req.admin!.enterpriseId,
        req.params.id,
        archived.data,
      );
      return { routes };
    },
  );

  // 一键下架指定厂商资源下的模型路由：单事务完成停用路由+归档计价规则+（若无其他路由）归档统一模型+撤销员工规则
  app.post<{ Params: { id: string; routeId: string } }>(
    "/provider-resources/:id/routes/:routeId/retire",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      try {
        const result = await app.providerRepo.retireResourceModelRoute(
          req.admin!.enterpriseId,
          req.params.id,
          req.params.routeId,
          req.admin!.adminUserId,
        );
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.retire_model",
          target_type: "model_route",
          target_id: result.routeId,
          change_summary: {
            resource_id: req.params.id,
            upstream_model: result.upstreamModel,
            unified_model_id: result.unifiedModelId,
            unified_model_archived: result.unifiedModelArchived,
            billing_rules_archived_count: result.billingRulesArchivedCount,
          },
          result: "SUCCESS",
        });
        return reply.code(200).send({ result });
      } catch (error) {
        return reply.code(400).send({
          error: "retire_failed",
          message: error instanceof Error ? error.message : "模型下架失败",
        });
      }
    },
  );

  // 恢复上架已下架的模型路由：恢复路由（保持停用待配计价）+ 恢复统一模型（若因下架被归档）+ 加回资源模型清单
  app.post<{ Params: { id: string; routeId: string } }>(
    "/provider-resources/:id/routes/:routeId/restore",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      try {
        const result = await app.providerRepo.restoreResourceModelRoute(
          req.admin!.enterpriseId,
          req.params.id,
          req.params.routeId,
          req.admin!.adminUserId,
        );
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.restore_model",
          target_type: "model_route",
          target_id: result.routeId,
          change_summary: {
            resource_id: req.params.id,
            upstream_model: result.upstreamModel,
            unified_model_id: result.unifiedModelId,
            unified_model_restored: result.unifiedModelRestored,
          },
          result: "SUCCESS",
        });
        return reply.code(200).send({ result });
      } catch (error) {
        return reply.code(400).send({
          error: "restore_failed",
          message: error instanceof Error ? error.message : "模型恢复上架失败",
        });
      }
    },
  );
}
