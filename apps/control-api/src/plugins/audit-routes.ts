/**
 * 审计路由 —— 查询操作日志（W02）。
 *
 * 依据：TRD §11.2 L715 /operation-logs。
 * 只读；所有查询带 enterprise_id 边界。
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "./auth-guard.js";

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get("/operation-logs", { preHandler: [requireAuth] }, async (req) => {
    const query = req.query as {
      limit?: string;
      target_type?: string;
      target_id?: string;
    };
    const limit = query.limit ? Math.min(Number(query.limit), 500) : 100;
    const logs = await app.auditRepo.list(req.admin!.enterpriseId, {
      limit,
      targetType: query.target_type,
      targetId: query.target_id,
    });
    return { logs };
  });
}
