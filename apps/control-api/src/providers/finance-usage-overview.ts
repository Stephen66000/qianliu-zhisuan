import { Decimal } from "decimal.js";
import type { ResourceFinanceView, ResourceUsageOverview } from "@qianliu/database";
import { shanghaiDateAt } from "../provider-finance/dashboard-projection.js";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const fixed = (value: Decimal.Value) => new Money(value).toDecimalPlaces(8).toFixed(8);

export function projectFinanceUsageOverview(
  overview: ResourceUsageOverview,
  financeViews: ResourceFinanceView[],
): ResourceUsageOverview {
  const byResource = new Map(financeViews.map((view) => [view.resourceId, view]));
  const modelDetails = overview.modelDetails.map((model) => {
    const finance = byResource.get(model.resourceId);
    if (!finance) return model;
    if (model.mode === "CODING_PLAN") {
      const period = finance.currentPeriod;
      const remaining = period?.totalQuota === null || period?.totalQuota === undefined
        || period.deductedQuota === null
        ? null : Money.max(0, new Money(period.totalQuota).minus(period.deductedQuota));
      return { ...model, remainingQuota: remaining?.toDecimalPlaces(8).toFixed(8) ?? null,
        quotaUnit: period?.quotaUnit ?? model.quotaUnit };
    }
    const account = finance.accounts.length === 1 ? finance.accounts[0] : null;
    return { ...model, currency: account?.currency ?? null,
      remainingQuota: account?.balanceState === "NORMAL" ? account.balance : null };
  });
  const providerSummaries = overview.providerSummaries.map((summary) => {
    const views = financeViews.filter((view) =>
      view.providerCode === summary.providerCode && view.mode === summary.mode
    );
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
    const accounts = views.flatMap((view) => view.accounts);
    const currencies = new Set(accounts.map((account) => account.currency));
    const balanceComplete = accounts.length === views.length
      && accounts.every((account) => account.balanceState === "NORMAL" && account.balance !== null)
      && currencies.size === 1;
    const costCalculable = accounts.length === views.length
      && accounts.every((account) => account.balanceState !== "INCOMPLETE_USAGE_COST")
      && currencies.size === 1;
    return { ...summary,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      rechargeAmount: currencies.size === 1
        ? fixed(accounts.reduce((sum, account) => sum.plus(account.monthlyRecharge), new Money(0))) : null,
      currentBalance: balanceComplete
        ? fixed(accounts.reduce((sum, account) => sum.plus(account.balance!), new Money(0))) : null,
      monthlyCost: costCalculable
        ? fixed(accounts.reduce((sum, account) => sum.plus(account.monthlyApiCost), new Money(0))) : null,
      monthlyCostReason: costCalculable ? null : (currencies.size > 1 ? "币种不唯一" : "API 资金账户不完整或币种不唯一") };
  });
  return { ...overview, providerSummaries, modelDetails };
}
