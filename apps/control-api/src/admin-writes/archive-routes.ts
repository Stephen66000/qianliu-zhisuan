import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";
import { ArchiveLifecycleSchema } from "./contracts.js";

export function registerAdminArchiveRoutes(app: FastifyInstance): void {
  registerUnifiedModelArchiveRoute(app);
  registerModelRouteArchiveRoute(app);
  registerBillingRuleArchiveRoute(app);
}

function registerUnifiedModelArchiveRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string; action: string } }>(
    "/unified-models/:id/:action", { preHandler: [requireAuth] }, async (req, reply) => {
      const action = z.enum(["archive", "unarchive"]).safeParse(req.params.action);
      const parsed = ArchiveLifecycleSchema.safeParse(req.body);
      if (!action.success) return reply.code(404).send({ error: "not_found", message: "未知归档操作" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const archived = action.data === "archive";
      const updated = await app.adminWriteRepo.setUnifiedModelArchived(
        req.admin!.enterpriseId, req.params.id, parsed.data.expected_version,
        archived, req.admin!.adminUserId,
      );
      if (!updated) return reply.code(409).send({
        error: "invalid_state",
        message: archived ? "统一模型必须先停用，且版本未被修改，才能归档" : "统一模型未归档或版本已变化",
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: `unified_model.${action.data}`, target_type: "unified_model", target_id: updated.id,
        change_summary: { archived_at: updated.archived_at, status: updated.status }, result: "SUCCESS",
      });
      return { model: updated };
    },
  );
}

function registerModelRouteArchiveRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string; action: string } }>(
    "/model-routes/:id/:action", { preHandler: [requireAuth] }, async (req, reply) => {
      const action = z.enum(["archive", "unarchive"]).safeParse(req.params.action);
      const parsed = ArchiveLifecycleSchema.safeParse(req.body);
      if (!action.success) return reply.code(404).send({ error: "not_found", message: "未知归档操作" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const archived = action.data === "archive";
      const updated = await app.adminWriteRepo.setModelRouteArchived(
        req.admin!.enterpriseId, req.params.id, parsed.data.expected_version,
        archived, req.admin!.adminUserId,
      );
      if (!updated) return reply.code(409).send({
        error: "invalid_state",
        message: archived ? "Model Route 必须先停用，且版本未被修改，才能归档" : "Model Route 未归档或版本已变化",
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: `model_route.${action.data}`, target_type: "model_route", target_id: updated.id,
        change_summary: { archived_at: updated.archived_at, enabled: updated.enabled }, result: "SUCCESS",
      });
      return { route: updated };
    },
  );
}

function registerBillingRuleArchiveRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string; action: string } }>(
    "/billing-rules/:id/:action", { preHandler: [requireAuth] }, async (req, reply) => {
      const action = z.enum(["archive", "unarchive"]).safeParse(req.params.action);
      const parsed = ArchiveLifecycleSchema.safeParse(req.body);
      if (!action.success) return reply.code(404).send({ error: "not_found", message: "未知归档操作" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const archived = action.data === "archive";
      const updated = await app.adminWriteRepo.setBillingRuleArchived(
        req.admin!.enterpriseId, req.params.id, parsed.data.expected_version,
        archived, req.admin!.adminUserId,
      );
      if (!updated) return reply.code(409).send({
        error: "invalid_state",
        message: archived ? "计价规则必须先停用，且版本未被修改，才能归档" : "计价规则未归档或版本已变化",
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: `billing_rule.${action.data}`, target_type: "billing_rule", target_id: updated.id,
        change_summary: { archived_at: updated.archived_at, enabled: updated.enabled }, result: "SUCCESS",
      });
      return { rule: updated };
    },
  );
}
