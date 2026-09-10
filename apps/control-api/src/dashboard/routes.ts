/**
 * 首页看板路由（W18）—— 只读聚合 API。
 *
 * 依据：TRD §12 首页口径（行 733-746）、PRD §10.2 首页看板。
 * 口径在后端 DashboardRepository 聚合，前端只展示，不重算（M5 集成点约束）。
 * 所有查询带 enterprise_id 边界（多租户隔离）。
 */
import type { FastifyInstance } from "fastify";
import { getStandardHomeSummary, UsageOverviewRepository } from "@qianliu/database";
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

  // GET /dashboard/home —— 标准版首页两分区聚合（HOME-STANDARD-20260910 WP02）。
  // 四指标与目的页同源：费用直接取经营账单 getBill 快照；其余口径见
  // V4/Evidence/HOME-STANDARD-20260910/C1/contract.md。
  app.get("/dashboard/home", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const asOf = new Date();
    const [bill, financeRead] = await Promise.all([
      app.operatingBillRepo.getBill(enterpriseId, shanghaiMonthAt(asOf)),
      financeReadModelEnabled(app.providerFinanceMode, app.providerFinanceRepo, enterpriseId),
    ]);
    return getStandardHomeSummary(app.db, {
      enterpriseId,
      asOf,
      bill,
      financeRead,
    });
  });
}
