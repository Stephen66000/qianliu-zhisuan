/**
 * 用量账本路由（W18）—— 只读查询，分页 + 多维筛选。
 *
 * 依据：PRD §10.3（用量账本，行 426-458）、TRD §11.2（/usage 端点）。
 * 路由过程下钻（候选/Attempt/调度决策）在 W20 的 /gateway-requests/{id} 子路由。
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";
import type { UsageQuery } from "@qianliu/database";

export function registerUsageRoutes(app: FastifyInstance): void {
  // GET /usage —— 用量账本列表（分页 + 筛选）
  app.get("/usage", { preHandler: [requireAuth] }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Number(q.limit) : 50;
    const offset = q.offset ? Number(q.offset) : 0;
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;

    const query: UsageQuery = {
      enterpriseId: req.admin!.enterpriseId,
      principalId: q.principal_id,
      clientId: q.client_id,
      unifiedModel: q.unified_model,
      status: q.status,
      from,
      to,
      overageOnly: q.overage_only === "true",
      limit,
      offset,
    };
    return app.usageRepo.list(query);
  });
}
