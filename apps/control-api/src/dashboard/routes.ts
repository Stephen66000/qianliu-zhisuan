/**
 * 首页看板路由（W18）—— 只读聚合 API。
 *
 * 依据：TRD §12 首页口径（行 733-746）、PRD §10.2 首页看板。
 * 口径在后端 DashboardRepository 聚合，前端只展示，不重算（M5 集成点约束）。
 * 所有查询带 enterprise_id 边界（多租户隔离）。
 */
import type { FastifyInstance } from "fastify";
import { getStandardHomeMonthlyCost, getStandardHomeMtdComparison, getStandardHomeOverview, getStandardHomeSummary, UsageOverviewRepository } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  financeReadModelEnabled,
  projectDashboardFinance,
  shanghaiMonthAt,
} from "../provider-finance/dashboard-projection.js";

export function registerDashboardRoutes(
  app: FastifyInstance,
  options: { usageOverviewV2?: boolean } = {},
): void {
  // GET /dashboard —— 首页八项口径聚合（TRD §12）
  app.get("/dashboard", { preHandler: [requireAuth] }, async (req) => {
    const anchor = new Date();
    const enterpriseId = req.admin!.enterpriseId;
    const financeRead = await financeReadModelEnabled(
      app.providerFinanceMode, app.providerFinanceRepo, enterpriseId,
    );
    const [legacySummary, financeSummary] = await Promise.all([
      app.dashboardRepo.getSummary(enterpriseId, anchor.getTime()),
      !financeRead ? null
        : app.providerFinanceRepo.getMonthlyFinanceSummary(enterpriseId, shanghaiMonthAt(anchor)),
    ]);
    const summary = financeSummary
      ? projectDashboardFinance(legacySummary, financeSummary) : legacySummary;
    if (options.usageOverviewV2 === false) return summary;
    const employeeUsageOverview = await new UsageOverviewRepository(app.db).getOverview({
      enterpriseId: req.admin!.enterpriseId,
      subjectType: "EMPLOYEE",
      period: "TODAY",
      anchor,
    });
    return { ...summary, employeeUsageOverview };
  });

  app.get<{ Querystring: { scope?: string; as_of?: string } }>("/dashboard/home", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const now = new Date();
    if (req.query.scope === "overview") return getStandardHomeOverview(app.db, enterpriseId, now);
    const requested = req.query.scope === "cost" ? Date.parse(req.query.as_of ?? "") : NaN;
    const asOf = Number.isFinite(requested) && requested <= now.getTime() ? new Date(requested) : now;
    const financeRead = await financeReadModelEnabled(app.providerFinanceMode, app.providerFinanceRepo, enterpriseId);
    if (req.query.scope === "cost" && financeRead) {
      return { mtdComparison: await getStandardHomeMtdComparison(app.db, enterpriseId, asOf) };
    }
    const options = { enterpriseId, asOf, financeRead, bill: app.operatingBillRepo.getBill(enterpriseId, shanghaiMonthAt(asOf)) };
    return req.query.scope === "cost"
      ? getStandardHomeMonthlyCost(app.db, options)
      : getStandardHomeSummary(app.db, options);
  });
}
