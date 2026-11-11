import { Decimal } from "decimal.js";
import type { ResourceFinanceView, ResourceUsageOverview } from "@qianliu/database";
import { shanghaiDateAt } from "../provider-finance/dashboard-projection.js";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const fixed = (value: Decimal.Value) => new Money(value).toDecimalPlaces(8).toFixed(8);

/**
 * 资金读模型投影（WP1 S3a 后）：
 *   - 仅 CODING_PLAN 分支保留资金读模型增强（套餐剩余额度、订阅期、套餐现金口径）；
 *   - API 模型行与 API 汇总行不再被资金账户余额/费用字段覆盖（WP0 contracts.md §1 C1
 *     约束"remainingQuota 覆盖行为移除，余额走 C2"＋ACE-06"不把货币余额放进 Token/套餐
 *     剩余额度"）：API 费用同源来自 loadApiCostEstimation（基础聚合层注入，见
 *     dashboard-breakdown.ts），API 余额字段保留基础层的厂商经营快照事实（官方余额域，
 *     走 C2/WP3），因此本投影对 API 行为恒等映射——finance 开/关两条路径 API 字段同源同值。
 */
export function projectFinanceUsageOverview(
  overview: ResourceUsageOverview,
  financeViews: ResourceFinanceView[],
): ResourceUsageOverview {
  const byResource = new Map(financeViews.map((view) => [view.resourceId, view]));
  const modelDetails = overview.modelDetails.map((model) => {
    const finance = byResource.get(model.resourceId);
    if (!finance) return model;
    // CODING_PLAN 套餐分支原样保留（W5/W6 合同不变）。
    if (model.mode === "CODING_PLAN") {
      const period = finance.currentPeriod;
      const remaining = period?.totalQuota === null || period?.totalQuota === undefined
        || period.deductedQuota === null
        ? null : Money.max(0, new Money(period.totalQuota).minus(period.deductedQuota));
      return { ...model, remainingQuota: remaining?.toDecimalPlaces(8).toFixed(8) ?? null,
        quotaUnit: period?.quotaUnit ?? model.quotaUnit };
    }
    // API 模型行：不注入资金账户余额/币种（C1 约束），保留基础层快照事实。
    return model;
  });
  const providerSummaries = overview.providerSummaries.map((summary) => {
    const views = financeViews.filter((view) =>
      view.providerCode === summary.providerCode && view.mode === summary.mode
    );
    // CODING_PLAN 套餐汇总分支原样保留。
    if (summary.mode === "CODING_PLAN") {
      const periods = views.map((view) => view.currentPeriod).filter(
        (period): period is NonNullable<ResourceFinanceView["currentPeriod"]> => period !== null,
      );
      const activeCosts = periods.map((period) => period.fixedCashPaidCny
        ?? (period.fixedFeeCurrency === "CNY" ? period.fixedFeeAmount : null));
      const periodFactsComplete = views.length > 0 && periods.length === views.length;
      const activeCostsComplete = periodFactsComplete && activeCosts.every((value) => value !== null);
      const periodTotals = periods.map((period) => period.totalQuota);
      const total = periodFactsComplete && periodTotals.every((value) => value !== null)
        ? periodTotals.reduce((sum, value) => sum.plus(value!), new Money(0))
        : null;
      const deductionsComplete = periodFactsComplete
        && periods.every((period) => period.deductedQuota !== null);
      const used = deductionsComplete
        ? periods.reduce((sum, period) => sum.plus(period.deductedQuota!), new Money(0)) : null;
      return { ...summary,
        packageCost: activeCostsComplete
          ? fixed(activeCosts.reduce((sum, value) => sum.plus(value!), new Money(0))) : null,
        monthlyCost: fixed(views.reduce((sum, view) => sum.plus(view.monthlyPlanCashCny), new Money(0))),
        monthlyCostReason: null,
        totalQuota: total?.toDecimalPlaces(8).toFixed(8) ?? null,
        usedQuota: used?.toDecimalPlaces(8).toFixed(8) ?? null,
        remainingQuota: total && used
          ? Money.max(0, total.minus(used)).toDecimalPlaces(8).toFixed(8)
          : null,
        currency: activeCostsComplete ? "CNY" : summary.currency,
        subscriptionPeriodStart: periodFactsComplete && new Set(periods.map((p) => p.periodStart)).size === 1
          ? shanghaiDateAt(periods[0]!.periodStart) : null,
        subscriptionPeriodEnd: periodFactsComplete && new Set(periods.map((p) => p.periodEndExclusive)).size === 1
          ? shanghaiDateAt(periods[0]!.periodEndExclusive) : null };
    }
    // API 汇总行：不再从资金账户覆盖 monthlyCost/rechargeAmount/currentBalance/currency
    // （C1 约束＋ACE-06）；基础层已按同源估算与经营快照供给，恒等透传。
    return summary;
  });
  return { ...overview, providerSummaries, modelDetails };
}
