/**
 * 标准版首页聚合组合器（HOME-STANDARD-20260910 WP02）—— 只读事实聚合，前端只格式化。
 *
 * 口径契约见 V4/Evidence/HOME-STANDARD-20260910/C1/contract.md。模块拆分：
 *   - dashboard-home-types.ts    响应契约类型；
 *   - dashboard-home-metrics.ts  同期窗口 + Token/员工/项目指标（与目的页同源）；
 *   - dashboard-home-providers.ts 接入资源区按厂商聚合（调用状态与同步状态分别判断）；
 *   - dashboard-home-costs.ts    费用真实窗口聚合；资金读模型提供同查询的双期 MTD 已记录金额。
 * 月账单字段保持原合同，mtdComparison 仅补充同截止时刻的展示数据；不修改任何账本事实。
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

export function billIncompleteReason(bill: Pick<OperatingBillSnapshot, "summary">): string | null {
  const summary = bill.summary;
  if (summary.apiSpendReason) return summary.apiSpendReason;
  if (summary.totalSpends.length > 0) return null;
  if (summary.packageCost === null) return "待补套餐费用";
  // Empty currency arrays are not evidence of missing expense facts or mixed currencies.
  return summary.apiSpendStatus === "CALCULABLE" || summary.apiSpendStatus === "NOT_APPLICABLE"
    ? null : "本期费用缺少可计算事实";
}

function windowToIso(window: { start: Date; end: Date; truncated: boolean }): StandardHomeWindow {
  return {
    rangeStart: window.start.toISOString(),
    rangeEndExclusive: window.end.toISOString(),
    truncated: window.truncated,
  };
}

/** First paint only needs usage, subjects and resource status. */
export async function getStandardHomeOverview(
  db: Kysely<Database>,
  enterpriseId: string,
  asOf: Date,
): Promise<Omit<StandardHomeSummary, "monthlyCost">> {
  const shanghaiMonth = shanghaiNaturalMonthRange(asOf);
  const prevShanghai = previousShanghaiMonthWindow(asOf);
  const [employeeOverview, tokenCurrent, tokenPrevious, projectsCurrent, projectsPrevious, employeePrevious, resources] = await Promise.all([
    new UsageOverviewRepository(db).getActiveSubjectSummary({ enterpriseId, subjectType: "EMPLOYEE", period: "MONTH", anchor: asOf }),
    tokenTotalsForRange(db, enterpriseId, shanghaiMonth.start, shanghaiMonth.end),
    tokenTotalsForRange(db, enterpriseId, prevShanghai.start, prevShanghai.end),
    countActiveProjectsRange(db, enterpriseId, shanghaiMonth.start, shanghaiMonth.end),
    countActiveProjectsRange(db, enterpriseId, prevShanghai.start, prevShanghai.end),
    previousEmployeeWindow(db, enterpriseId, asOf),
    loadStandardHomeResources(db, enterpriseId, asOf),
  ]);

  return {
    asOf: asOf.toISOString(),
    month: new Date(asOf.getTime() + 8 * 3_600_000).toISOString().slice(0, 7),
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
    activeEmployees: {
      timezone: employeeOverview.timezone,
      rangeStart: employeeOverview.range.from,
      rangeEndExclusive: employeeOverview.range.to,
      current: employeeOverview.activeSubjects,
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

/** The finance-mode card uses these two as-of windows, independently of the full monthly bill. */
export async function getStandardHomeMtdComparison(
  db: Kysely<Database>,
  enterpriseId: string,
  asOf: Date,
): Promise<NonNullable<StandardHomeSummary["monthlyCost"]["mtdComparison"]>> {
  const { start } = shanghaiNaturalMonthRange(asOf);
  const previous = previousShanghaiMonthWindow(asOf);
  const [currentCost, previousCost] = await Promise.all([
    loadWindowOperatingFinance(db, enterpriseId, start, asOf),
    loadWindowOperatingFinance(db, enterpriseId, previous.start, previous.end),
  ]);
  return {
    basis: "FINANCE_READ_MODEL",
    current: { ...currentCost, window: windowToIso({ start, end: asOf, truncated: false }) },
    previous: { ...previousCost, window: windowToIso(previous) },
  };
}

export async function getStandardHomeMonthlyCost(
  db: Kysely<Database>,
  { enterpriseId, asOf, bill, financeRead }: StandardHomeOptions,
): Promise<StandardHomeSummary["monthlyCost"]> {
  const previousWindow = previousShanghaiMonthWindow(asOf);
  const [snapshot, mtdComparison, bridgeSummary] = await Promise.all([
    bill,
    financeRead ? getStandardHomeMtdComparison(db, enterpriseId, asOf) : null,
    financeRead ? null : loadWindowBridgeCosts(db, enterpriseId, previousWindow.start, previousWindow.end),
  ]);
  const previous = mtdComparison
    ? { ...mtdComparison.previous, basis: "FINANCE_READ_MODEL" as const }
    : bridgeSummary
      ? {
        totalSpends: bridgeSummary.totalSpends.length > 0 ? bridgeSummary.totalSpends : bridgeKnownSpends(bridgeSummary),
        incompleteReason: bridgeIncompleteReason(bridgeSummary),
        basis: "BALANCE_BRIDGE" as const,
        window: windowToIso(previousWindow),
      }
      : null;

  return {
    month: snapshot.month,
    billStatus: snapshot.status,
    ...(mtdComparison ? { mtdComparison } : {}),
    current: {
      totalSpends: snapshot.summary.totalSpends,
      apiSpends: snapshot.summary.apiSpends,
      packageCosts: snapshot.summary.packageCosts,
      incompleteReason: billIncompleteReason(snapshot),
    },
    previous,
  };
}

export async function getStandardHomeSummary(
  db: Kysely<Database>,
  options: StandardHomeOptions,
): Promise<StandardHomeSummary> {
  const [overview, monthlyCost] = await Promise.all([
    getStandardHomeOverview(db, options.enterpriseId, options.asOf),
    getStandardHomeMonthlyCost(db, options),
  ]);
  return { ...overview, month: monthlyCost.month, monthlyCost };
}
