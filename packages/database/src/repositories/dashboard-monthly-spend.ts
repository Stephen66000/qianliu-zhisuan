import { Decimal } from "decimal.js";

import type {
  CurrencyAmount,
  MonthlyOperatingCostResource,
} from "./monthly-operating-cost.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export interface DashboardMonthlySpend {
  packagePayment: string | null;
  packagePayments: CurrencyAmount[];
  apiCost: string | null;
  apiCosts: CurrencyAmount[];
  apiCostReason: string | null;
  totalSpend: string | null;
  totalSpends: CurrencyAmount[];
}

function money(value: Decimal.Value): string {
  return new MoneyDecimal(value).toDecimalPlaces(8).toFixed(8);
}

function isZero(value: string): boolean {
  return new MoneyDecimal(value).isZero();
}

function shanghaiDate(value: Date): string {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function group(facts: Array<{ currency: string | null; amount: string }>): CurrencyAmount[] {
  const totals = new Map<string, Decimal>();
  for (const fact of facts) {
    if (fact.currency === null) continue;
    totals.set(
      fact.currency,
      (totals.get(fact.currency) ?? new MoneyDecimal(0)).plus(fact.amount),
    );
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: money(amount) }));
}

function scalar(
  facts: CurrencyAmount[],
  complete: boolean,
  emptyValue: string | null,
): string | null {
  if (!complete) return null;
  if (facts.length === 0) return emptyValue;
  return facts.length === 1 ? facts[0]!.amount : null;
}

/**
 * 首页支出口径：套餐按录入的订阅起始日一次性归属月份；API 只认已冻结账本费用。
 * 经营账单仍保留余额桥接口径，本函数只服务首页汇总卡片。
 */
export function summarizeDashboardMonthlySpend(
  resources: MonthlyOperatingCostResource[],
  periodStart: Date,
  periodEnd: Date,
): DashboardMonthlySpend {
  const apiResources = resources.filter((resource) => resource.mode === "API");
  const periodStartDate = shanghaiDate(periodStart);
  const periodEndDate = shanghaiDate(periodEnd);
  const monthlyPlans = resources.filter((resource) => resource.mode === "CODING_PLAN"
    && resource.servicePeriodStart !== null
    && resource.servicePeriodStart >= periodStartDate
    && resource.servicePeriodStart < periodEndDate);

  const packageComplete = monthlyPlans.every((resource) => resource.packageCost !== null)
    && monthlyPlans.every((resource) => (resource.packageCost !== null && isZero(resource.packageCost))
      || resource.packageCostCurrency !== null);
  const apiComplete = apiResources.every((resource) => resource.ledgerApiCost !== null)
    && apiResources.every((resource) => (resource.ledgerApiCost !== null && isZero(resource.ledgerApiCost))
      || resource.currency !== null);

  const packagePayments = packageComplete ? group(monthlyPlans.map((resource) => ({
    currency: resource.packageCostCurrency,
    amount: resource.packageCost!,
  }))) : [];
  const apiCosts = apiComplete ? group(apiResources.map((resource) => ({
    currency: resource.currency,
    amount: resource.ledgerApiCost!,
  }))) : [];
  const packagePayment = resources.length === 0
    ? null
    : scalar(packagePayments, packageComplete, "0.00000000");
  const apiCost = scalar(apiCosts, apiComplete, "0.00000000");
  const totalComplete = packagePayment !== null && apiCost !== null;
  const totalSpends = totalComplete ? group([
    ...packagePayments,
    ...apiCosts,
  ]) : [];
  const totalSpend = totalComplete
    ? scalar(totalSpends, true, "0.00000000")
    : null;

  return {
    packagePayment,
    packagePayments,
    apiCost,
    apiCosts,
    apiCostReason: apiComplete ? null : "账本费用或币种事实不完整",
    totalSpend,
    totalSpends,
  };
}
