import { companyMonthlyMetrics } from "./company-monthly-metrics.js";
import { formatNumber } from "./format-utils.js";
import type { EmployeeReportFacts } from "./report-facts.js";

/** Keep image KPI values and text summary on the same monthly contract. */
export function companyReportPresentation(monthly: boolean, facts: EmployeeReportFacts) {
  const { overview, quota } = facts;
  if (monthly) {
    const metrics = companyMonthlyMetrics(facts.companyMonthlyAllocation, overview.metrics.realTokens, overview.metrics.requestCount);
    return { reportTitle: "Token使用量月报", requestsLabel: "当月总请求次数", tokenUsageLabel: "当月Token使用量", monthlyMetrics: metrics, monthQuotaTotal: metrics.allocation, monthTokenUsageRate: metrics.usageRate,
      monthQuotaRemaining: metrics.remaining,
      totalRequests: metrics.requestsWan,
      quotaSummaryLines: [`💎 当月分配额度：${metrics.allocation}`, `📊 当月Token使用率：${metrics.usageRate}`, `🧮 月末剩余额度：${metrics.remaining}`] };
  }
  const { companyMonthlyAllocation, companyMonthToDateTokens } = facts;
  const metrics = companyMonthlyAllocation !== null && companyMonthToDateTokens !== null
    ? companyMonthlyMetrics(companyMonthlyAllocation, companyMonthToDateTokens, overview.metrics.requestCount, true)
    : null;
  const allocation = metrics?.allocation ?? "待核";
  const usageRate = metrics?.usageRate ?? "待核";
  const remaining = metrics?.remaining ?? "待核";
  return { reportTitle: "Token使用量周报", requestsLabel: "全周总请求次数", tokenUsageLabel: "全周Token使用量", monthlyMetrics: undefined,
    monthQuotaTotal: allocation, monthTokenUsageRate: usageRate, monthQuotaRemaining: remaining,
    totalRequests: `${formatNumber(overview.metrics.requestCount)} 次`,
    quotaSummaryLines: [`额度${quota.asOfLabel}`, `💎 当月分配额度：${allocation}`,
      `📊 当月Token使用率：${usageRate}`, `🧮 剩余额度：${remaining}`] };
}
