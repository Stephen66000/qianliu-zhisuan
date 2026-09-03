import type { FastifyInstance } from "fastify";

import { requireAuth } from "../plugins/auth-guard.js";
import { financeReadModelEnabled, shanghaiMonthAt } from "../provider-finance/dashboard-projection.js";
import { projectFinanceUsageOverview } from "./finance-usage-overview.js";

/** 厂商资源用量总览；仅在 /resources 的“用量总览”Tab 激活时调用。 */
export function registerProviderUsageOverviewRoutes(app: FastifyInstance): void {
  app.get("/provider-resources/usage-overview", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const now = new Date();
    const financeRead = await financeReadModelEnabled(
      app.providerFinanceMode, app.providerFinanceRepo, enterpriseId,
    );
    const [overview, finance] = await Promise.all([
      app.dashboardRepo.getResourceUsageOverview(enterpriseId, now.getTime()),
      !financeRead ? []
        : app.providerFinanceRepo.listResourceFinanceViews(
          enterpriseId, shanghaiMonthAt(now), now,
        ),
    ]);
    return finance.length > 0 ? projectFinanceUsageOverview(overview, finance) : overview;
  });
}
