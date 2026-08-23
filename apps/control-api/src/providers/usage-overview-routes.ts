import type { FastifyInstance } from "fastify";

import { requireAuth } from "../plugins/auth-guard.js";

/** 厂商资源用量总览；仅在 /resources 的“用量总览”Tab 激活时调用。 */
export function registerProviderUsageOverviewRoutes(app: FastifyInstance): void {
  app.get("/provider-resources/usage-overview", { preHandler: [requireAuth] }, async (req) =>
    app.dashboardRepo.getResourceUsageOverview(req.admin!.enterpriseId));
}
