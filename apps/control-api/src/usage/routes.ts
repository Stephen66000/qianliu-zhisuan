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
    client_id: z.string().trim().min(1).max(64).optional(),
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
      clientId: q.client_id,
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
}
