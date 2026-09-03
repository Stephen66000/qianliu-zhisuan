import { Decimal } from "decimal.js";
import type { ResourceFinanceView, ResourceUsageOverview } from "@qianliu/database";

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
    if (model.mode === "CODING_PLAN") return model;
    const account = finance.accounts.length === 1 ? finance.accounts[0] : null;
    return { ...model, currency: account?.currency ?? null,
      remainingQuota: account?.balanceState === "NORMAL" ? account.balance : null };
  });
  const providerSummaries = overview.providerSummaries.map((summary) => {
    const resourceIds = [...new Set(overview.modelDetails
      .filter((model) => model.providerCode === summary.providerCode && model.mode === summary.mode)
      .map((model) => model.resourceId))];
    const views = resourceIds.map((id) => byResource.get(id)).filter(
      (view): view is ResourceFinanceView => view !== undefined,
    );
    if (summary.mode === "CODING_PLAN") {
      const periods = views.map((view) => view.currentPeriod).filter(
        (period): period is NonNullable<ResourceFinanceView["currentPeriod"]> => period !== null,
      );
      return { ...summary,
        packageCost: fixed(views.reduce((sum, view) => sum.plus(view.monthlyPlanCashCny), new Money(0))),
        monthlyCost: fixed(views.reduce((sum, view) => sum.plus(view.monthlyPlanCashCny), new Money(0))),
        monthlyCostReason: null,
        subscriptionPeriodStart: periods.length === views.length && new Set(periods.map((p) => p.periodStart)).size === 1
          ? periods[0]!.periodStart : null,
        subscriptionPeriodEnd: periods.length === views.length && new Set(periods.map((p) => p.periodEndExclusive)).size === 1
          ? periods[0]!.periodEndExclusive : null };
    }
    const accounts = views.flatMap((view) => view.accounts);
    const currencies = new Set(accounts.map((account) => account.currency));
    const complete = accounts.length === views.length
      && accounts.every((account) => account.balanceState === "NORMAL" && account.balance !== null)
      && currencies.size === 1;
    return { ...summary,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      rechargeAmount: currencies.size === 1
        ? fixed(accounts.reduce((sum, account) => sum.plus(account.monthlyRecharge), new Money(0))) : null,
      currentBalance: complete
        ? fixed(accounts.reduce((sum, account) => sum.plus(account.balance!), new Money(0))) : null,
      monthlyCost: complete
        ? fixed(accounts.reduce((sum, account) => sum.plus(account.monthlyApiCost), new Money(0))) : null,
      monthlyCostReason: complete ? null : "API 资金账户不完整或币种不唯一" };
  });
  return { ...overview, providerSummaries, modelDetails };
}
