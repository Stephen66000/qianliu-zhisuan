/**
 * 首页看板路由（W18）—— 只读聚合 API。
 *
 * 依据：TRD §12 首页口径（行 733-746）、PRD §10.2 首页看板。
 * 口径在后端 DashboardRepository 聚合，前端只展示，不重算（M5 集成点约束）。
 * 所有查询带 enterprise_id 边界（多租户隔离）。
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";

export function registerDashboardRoutes(app: FastifyInstance): void {
  // GET /dashboard —— 首页八项口径聚合（TRD §12）
  app.get("/dashboard", { preHandler: [requireAuth] }, async (req) => {
    const summary = await app.dashboardRepo.getSummary(req.admin!.enterpriseId);
    return summary;
  });
}
