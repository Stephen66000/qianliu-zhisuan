import { companyMonthlyMetrics } from "./company-monthly-metrics.js";
import { formatNumber, formatTokenVolume } from "./format-utils.js";
import type { EmployeeReportFacts } from "./report-facts.js";

/** Keep image KPI values and text summary on the same monthly contract. */
export function companyReportPresentation(monthly: boolean, facts: EmployeeReportFacts) {
  const { overview, quota } = facts;
  if (monthly) {
    const metrics = companyMonthlyMetrics(facts.companyMonthlyAllocation, overview.metrics.realTokens, overview.metrics.requestCount);
    return { monthlyMetrics: metrics, monthQuotaTotal: metrics.allocation, monthTokenUsageRate: metrics.usageRate,
      monthConsumedTokens: formatTokenVolume(overview.metrics.realTokens), monthQuotaRemaining: metrics.remaining,
      totalRequests: metrics.requestsWan,
      quotaSummaryLines: [`💎 单月分配额度：${metrics.allocation}`, `📊 当月Token使用率：${metrics.usageRate}`, `🧮 月末剩余额度：${metrics.remaining}`] };
  }
  return { monthlyMetrics: undefined, monthQuotaTotal: quota.scopeLabel, monthTokenUsageRate: undefined,
    monthConsumedTokens: quota.statusLabel, monthQuotaRemaining: quota.policyLabel,
    totalRequests: `${formatNumber(overview.metrics.requestCount)} 次`,
    quotaSummaryLines: [`💎 额度范围：${quota.scopeLabel}`, `🔥 额度状态：${quota.statusLabel}`, `🧮 超额策略：${quota.policyLabel}`,
      `额度${quota.asOfLabel}；${quota.rows.map(row => `${row.provider}（${row.basis}）：${row.detail}`).join("；")}`,
      "成功请求统计；额度包含失败实耗，按预占归属月计量。"] };
}
