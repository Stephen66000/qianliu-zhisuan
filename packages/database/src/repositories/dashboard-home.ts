/**
 * 标准版首页聚合组合器（HOME-STANDARD-20260910 WP02）—— 只读事实聚合，前端只格式化。
 *
 * 口径契约见 V4/Evidence/HOME-STANDARD-20260910/C1/contract.md。模块拆分：
 *   - dashboard-home-types.ts    响应契约类型；
 *   - dashboard-home-metrics.ts  同期窗口 + Token/员工/项目指标（与目的页同源）；
 *   - dashboard-home-providers.ts 接入资源区按厂商聚合（调用状态与同步状态分别判断）；
 *   - dashboard-home-costs.ts    上月同期费用（资金读模型 / 余额桥接两口径，真实窗口聚合）。
 * 不复制计价、分摊、健康判定算法。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { UsageOverviewRepository } from "./usage-overview-repository.js";
import type { OperatingBillSnapshot } from "./operating-bill-types.js";
import {
  previousShanghaiMonthWindow,
  shanghaiNaturalMonthRange,
  tokenTotalsForRange,
  countActiveProjectsRange,
  previousEmployeeWindow,
} from "./dashboard-home-metrics.js";
import { loadStandardHomeResources } from "./dashboard-home-providers.js";
import {
  bridgeIncompleteReason,
  bridgeKnownSpends,
  loadWindowBridgeCosts,
  loadWindowOperatingFinance,
} from "./dashboard-home-costs.js";
import type {
  StandardHomeOptions,
  StandardHomeSummary,
  StandardHomeWindow,
} from "./dashboard-home-types.js";

function billIncompleteReason(bill: OperatingBillSnapshot): string | null {
  const summary = bill.summary;
  if (summary.totalSpends.length > 0) return summary.apiSpendReason ?? null;
  return summary.apiSpendReason
    ?? (summary.packageCost === null ? "待补套餐费用" : "不可跨币种合计；已知项保留");
}

function windowToIso(window: { start: Date; end: Date; truncated: boolean }): StandardHomeWindow {
  return {
    rangeStart: window.start.toISOString(),
    rangeEndExclusive: window.end.toISOString(),
    truncated: window.truncated,
  };
}

export async function getStandardHomeSummary(
  db: Kysely<Database>,
  options: StandardHomeOptions,
): Promise<StandardHomeSummary> {
  const { enterpriseId, asOf, bill, financeRead } = options;
  const shanghaiMonth = shanghaiNaturalMonthRange(asOf);
  const prevShanghai = previousShanghaiMonthWindow(asOf);

  const [
    employeeOverview,
    tokenCurrent,
    tokenPrevious,
    projectsCurrent,
    projectsPrevious,
    employeePrevious,
    bridgeSummary,
    financeWindow,
    resources,
  ] = await Promise.all([
    new UsageOverviewRepository(db).getOverview({
      enterpriseId,
      subjectType: "EMPLOYEE",
      period: "MONTH",
      anchor: asOf,
    }),
    tokenTotalsForRange(db, enterpriseId, shanghaiMonth.start, shanghaiMonth.end),
    tokenTotalsForRange(db, enterpriseId, prevShanghai.start, prevShanghai.end),
    countActiveProjectsRange(db, enterpriseId, shanghaiMonth.start, shanghaiMonth.end),
    countActiveProjectsRange(db, enterpriseId, prevShanghai.start, prevShanghai.end),
    previousEmployeeWindow(db, enterpriseId, asOf),
    !financeRead
      ? loadWindowBridgeCosts(db, enterpriseId, prevShanghai.start, prevShanghai.end)
      : null,
    financeRead
      ? loadWindowOperatingFinance(db, enterpriseId, prevShanghai.start, prevShanghai.end)
      : null,
    loadStandardHomeResources(db, enterpriseId, asOf),
  ]);

  const previousCost = financeWindow
    ? {
      totalSpends: financeWindow.totalSpends,
      incompleteReason: financeWindow.incompleteReason,
      basis: "FINANCE_READ_MODEL" as const,
      window: windowToIso(prevShanghai),
    }
    : bridgeSummary
      ? {
        // 已知部分保留：总额不完整时透出已计价 API 花费 + 套餐费用（如上月 Kimi 套餐），
        // 缺口由 incompleteReason 显式标记，而不是把已知金额丢弃为"不可完整计算"。
        totalSpends: bridgeSummary.totalSpends.length > 0
          ? bridgeSummary.totalSpends
          : bridgeKnownSpends(bridgeSummary),
        incompleteReason: bridgeIncompleteReason(bridgeSummary),
        basis: "BALANCE_BRIDGE" as const,
        window: windowToIso(prevShanghai),
      }
      : null;

  return {
    asOf: asOf.toISOString(),
    month: bill.month,
    tokenUsage: {
      rangeStart: shanghaiMonth.start.toISOString(),
      rangeEndExclusive: shanghaiMonth.end.toISOString(),
      current: {
        totalTokens: tokenCurrent.totalTokens,
        inputTokens: tokenCurrent.inputTokens,
        outputTokens: tokenCurrent.outputTokens,
        usageQuality: tokenCurrent.usageQuality,
        unknownCount: tokenCurrent.unknownCount,
      },
      previous: {
        totalTokens: tokenPrevious.totalTokens,
        usageQuality: tokenPrevious.usageQuality,
        unknownCount: tokenPrevious.unknownCount,
        window: windowToIso(prevShanghai),
      },
    },
    monthlyCost: {
      month: bill.month,
      billStatus: bill.status,
      current: {
        totalSpends: bill.summary.totalSpends,
        apiSpends: bill.summary.apiSpends,
        packageCosts: bill.summary.packageCosts,
        incompleteReason: billIncompleteReason(bill),
      },
      previous: previousCost,
    },
    activeEmployees: {
      timezone: employeeOverview.timezone,
      rangeStart: employeeOverview.range.from,
      rangeEndExclusive: employeeOverview.range.to,
      current: employeeOverview.metrics.activeSubjects,
      previous: {
        count: employeePrevious.count,
        window: windowToIso(employeePrevious.window),
      },
    },
    activeProjects: {
      rangeStart: shanghaiMonth.start.toISOString(),
      rangeEndExclusive: shanghaiMonth.end.toISOString(),
      current: projectsCurrent,
      previous: { count: projectsPrevious, window: windowToIso(prevShanghai) },
    },
    resources,
  };
}
