import { Decimal } from "decimal.js";

import type {
  CurrencyAmount,
  MonthlyOperatingCostResource,
} from "./monthly-operating-cost.js";
import type {
  ApiCostEstimation,
  ApiCostEstimationGap,
} from "./api-cost-estimation.js";

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

/** 估算缺口 → 展示文案；PRICE_BASIS_UNVERIFIED 为信息项，不参与完整性（WP1 plan §4.2）。 */
export function apiEstimationGapText(gaps: ApiCostEstimationGap[]): string | null {
  const text = gaps
    .filter((gap) => gap.reason !== "PRICE_BASIS_UNVERIFIED")
    .map((gap) => `${gap.reason}:${gap.count}`)
    .join("、");
  return text.length > 0 ? text : null;
}

/**
 * 首页 API 费用分量改由同源估算供给（WP1 S3a / ACE-03/06/07）：
 *   - monthlyApiCost(s) 直接采用 loadApiCostEstimation 的按币种 amounts（八位小数字面值，
 *     不混币相加）；已知部分保留——KNOWN_PARTIAL 且有金额时照常透出金额，缺口进 apiCostReason；
 *   - 套餐分量（packagePayment 系列）不动；资金字段（recharge 等）不在本函数职责内；
 *   - totalSpend(s) 由套餐分量与估算分量按币种重新合计。
 */
export function applyApiCostEstimationToSpend(
  spend: DashboardMonthlySpend,
  estimation: Pick<ApiCostEstimation, "amounts" | "completeness" | "gaps">,
): DashboardMonthlySpend {
  const apiCosts: CurrencyAmount[] = estimation.amounts.map((amount) => ({
    currency: amount.currency,
    amount: amount.amount,
  }));
  const apiCost = apiCosts.length === 1
    ? apiCosts[0]!.amount
    : apiCosts.length === 0 && estimation.completeness !== "KNOWN_PARTIAL"
      ? "0.00000000"
      : null;
  const apiCostReason = apiCost !== null
    ? apiEstimationGapText(estimation.gaps)
    : apiCosts.length > 1
      ? `币种不一致：${apiCosts.map((entry) => entry.currency).join("、")}`
      : apiEstimationGapText(estimation.gaps) ?? "API 费用估算不完整";
  const totalComplete = spend.packagePayment !== null && apiCost !== null;
  const totalSpends = totalComplete ? group([...spend.packagePayments, ...apiCosts]) : [];
  const totalSpend = totalComplete ? scalar(totalSpends, true, "0.00000000") : null;
  return {
    ...spend,
    apiCost,
    apiCosts,
    apiCostReason,
    totalSpend,
    totalSpends,
  };
}
