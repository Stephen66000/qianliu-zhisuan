/**
 * 用量账本路由（W18）—— 只读查询，分页 + 多维筛选。
 *
 * 依据：PRD §10.3（用量账本，行 426-458）、TRD §11.2（/usage 端点）。
 * 路由过程下钻（候选/Attempt/调度决策）在 W20 的 /gateway-requests/{id} 子路由。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";
import type { UsageQuery } from "@qianliu/database";

const UsageListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    search: z.string().trim().max(255).optional(),
    principal_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
    client_id: z.string().trim().min(1).max(64).optional(),
    agent_family: z.enum(["WORKBUDDY", "CODEX", "ZCODE", "CLAUDE_CODE", "QIANLIU_IDE", "OTHER", "UNKNOWN"]).optional(),
    provider_id: z.string().uuid().optional(),
    provider_resource_id: z.string().uuid().optional(),
    unified_model: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    overage_only: z.enum(["true", "false"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to 不能早于 from" });
    }
  });

export function registerUsageRoutes(app: FastifyInstance): void {
  const AgentFamilySchema = z.enum(["WORKBUDDY", "CODEX", "ZCODE", "CLAUDE_CODE", "QIANLIU_IDE", "OTHER", "UNKNOWN"]);
  // GET /usage —— 用量账本列表（分页 + 筛选）
  app.get("/usage", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = UsageListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const q = parsed.data;

    const query: UsageQuery = {
      enterpriseId: req.admin!.enterpriseId,
      search: q.search,
      principalId: q.principal_id,
      projectId: q.project_id,
      clientId: q.client_id,
      agentFamily: q.agent_family,
      providerId: q.provider_id,
      providerResourceId: q.provider_resource_id,
      unifiedModel: q.unified_model,
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      overageOnly: q.overage_only === "true",
      limit: q.limit,
      offset: q.offset,
    };
    return app.usageRepo.list(query);
  });

  app.get("/principals/:id/agent-usage", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const principal = await app.principalRepo.findById(req.admin!.enterpriseId, parsed.data.id);
    if (!principal) return reply.code(404).send({ error: "not_found" });
    return {
      agents: await app.usageRepo.summarizePrincipalAgents(req.admin!.enterpriseId, parsed.data.id),
      expectedAgentFamilies: await app.usageRepo.listExpectedAgentFamilies(req.admin!.enterpriseId, parsed.data.id),
    };
  });

  app.patch("/principals/:id/agent-expectations", { preHandler: [requireAuth] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ agent_families: z.array(AgentFamilySchema).max(8) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const principal = await app.principalRepo.findById(req.admin!.enterpriseId, params.data.id);
    if (!principal) return reply.code(404).send({ error: "not_found" });
    const expectedAgentFamilies = await app.usageRepo.replaceExpectedAgentFamilies(
      req.admin!.enterpriseId, params.data.id, body.data.agent_families,
    );
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "principal.agent_expectations.update",
      target_type: "principal",
      target_id: params.data.id,
      change_summary: { expected_agent_families: expectedAgentFamilies },
      result: "SUCCESS",
    });
    return { expectedAgentFamilies };
  });
}
