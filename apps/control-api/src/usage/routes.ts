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
import {
  UsageOverviewRepository,
  UsageOverviewSubjectNotFoundError,
  type UsageOverviewPeriod,
  type UsageOverviewSubjectType,
} from "@qianliu/database";

const UsageListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    search: z.string().trim().max(255).optional(),
    principal_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
    subject_type: z.enum(["EMPLOYEE", "PROJECT", "employee", "project"]).optional(),
    client_id: z.string().trim().min(1).max(64).optional(),
    agent_family: z.enum(["WORKBUDDY", "CODEX", "ZCODE", "CLAUDE_CODE", "QIANLIU_IDE", "OTHER", "UNKNOWN"]).optional(),
    provider_id: z.string().uuid().optional(),
    provider_resource_id: z.string().uuid().optional(),
    unified_model: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    to_exclusive: z.string().datetime({ offset: true }).optional(),
    overage_only: z.enum(["true", "false"]).optional(),
    settled_only: z.enum(["true", "false"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.to && value.to_exclusive) {
      ctx.addIssue({ code: "custom", path: ["to_exclusive"], message: "to 与 to_exclusive 不能同时使用" });
    }
    const upper = value.to_exclusive ?? value.to;
    if (value.from && upper && new Date(value.from) > new Date(upper)) {
      ctx.addIssue({ code: "custom", path: [value.to_exclusive ? "to_exclusive" : "to"], message: "结束时间不能早于 from" });
    }
  });

export function registerUsageRoutes(
  app: FastifyInstance,
  options: { overviewV2?: boolean } = {},
): void {
  const ExpectedAgentFamilySchema = z.enum(["WORKBUDDY", "CODEX", "ZCODE", "CLAUDE_CODE", "QIANLIU_IDE"]);
  const UsageOverviewQuerySchema = z.object({
    subject_type: z.enum(["EMPLOYEE", "PROJECT", "employee", "project"]).default("EMPLOYEE"),
    subject_id: z.string().uuid().optional(),
    period: z.enum(["TODAY", "WEEK", "MONTH", "today", "week", "month"]).default("MONTH"),
    anchor: z.string().datetime({ offset: true }).optional(),
  });

  if (options.overviewV2 !== false) app.get("/usage/overview", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = UsageOverviewQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    try {
      return await new UsageOverviewRepository(app.db).getOverview({
        enterpriseId: req.admin!.enterpriseId,
        subjectType: parsed.data.subject_type.toUpperCase() as UsageOverviewSubjectType,
        subjectId: parsed.data.subject_id,
        period: parsed.data.period.toUpperCase() as UsageOverviewPeriod,
        anchor: parsed.data.anchor ? new Date(parsed.data.anchor) : new Date(),
      });
    } catch (error) {
      if (error instanceof UsageOverviewSubjectNotFoundError) {
        return reply.code(404).send({ error: "not_found", message: "用量主体不存在" });
      }
      throw error;
    }
  });

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
      subjectType: q.subject_type?.toUpperCase() as UsageQuery["subjectType"],
      clientId: q.client_id,
      agentFamily: q.agent_family,
      providerId: q.provider_id,
      providerResourceId: q.provider_resource_id,
      unifiedModel: q.unified_model,
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      toExclusive: q.to_exclusive ? new Date(q.to_exclusive) : undefined,
      overageOnly: q.overage_only === "true",
      settledOnly: q.settled_only === "true",
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
    const body = z.object({ agent_families: z.array(ExpectedAgentFamilySchema).max(5) }).safeParse(req.body);
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
