import { Decimal } from "decimal.js";

import type { ApiSpendStatus, CurrencyAmount, MonthlyOperatingCostResource, MonthlyOperatingCostSummary } from "./monthly-operating-cost.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
function money(value: Decimal.Value): string { return new MoneyDecimal(value).toDecimalPlaces(8).toFixed(8); }

function singleKnownAmount(
  resourceCount: number, complete: boolean, facts: CurrencyAmount[], emptyValue: string | null,
): string | null {
  if (resourceCount === 0) return emptyValue;
  return complete && facts.length === 1 ? facts[0]!.amount : null;
}

function summarizedRecharge(
  resources: MonthlyOperatingCostResource[], facts: CurrencyAmount[],
): string | null {
  if (resources.length === 0) return null;
  if (!resources.every((row) => row.rechargeAmount !== null)) return null;
  if (facts.length === 0) return "0.00000000";
  return facts.length === 1 ? facts[0]!.amount : null;
}

export function summarizeMonthlyOperatingCosts(resources: MonthlyOperatingCostResource[]): MonthlyOperatingCostSummary {
  const apiResources = resources.filter((row) => row.mode === "API");
  const planResources = resources.filter((row) => row.mode === "CODING_PLAN");
  const firstIncomplete = apiResources.find((row) => row.apiSpendStatus !== "CALCULABLE");
  const sum = (values: string[]) => money(values.reduce(
    (total, value) => total.plus(value),
    new MoneyDecimal(0),
  ));
  const group = (facts: Array<{ currency: string | null; amount: string | null }>): CurrencyAmount[] => {
    const totals = new Map<string, Decimal>();
    for (const fact of facts) {
      if (fact.currency === null || fact.amount === null) continue;
      totals.set(fact.currency, (totals.get(fact.currency) ?? new MoneyDecimal(0)).plus(fact.amount));
    }
    return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amountValue]) => ({ currency, amount: money(amountValue) }));
  };
  const openingBalances = group(apiResources.map((row) => ({
    currency: row.openingBalanceCurrency, amount: row.openingBalance,
  })));
  const rechargeAmounts = group(apiResources.flatMap((row) => row.rechargeAmounts));
  const endingBalances = group(apiResources.map((row) => ({
    currency: row.endingBalanceCurrency, amount: row.endingBalance,
  })));
  const apiSpends = group(apiResources.map((row) => ({
    currency: row.apiSpendCurrency, amount: row.apiSpend,
  })));
  const packageCosts = group(planResources.map((row) => ({
    currency: row.packageCostCurrency, amount: row.packageCost,
  })));
  const totalSpends = group(resources.map((row) => ({
    currency: row.mode === "API" ? row.apiSpendCurrency : row.packageCostCurrency,
    amount: row.mode === "API" ? row.apiSpend : row.packageCost,
  })));
  const currencyMismatch = apiResources.length > 0
    && firstIncomplete === undefined && apiSpends.length !== 1;
  const apiSpendStatus: ApiSpendStatus = apiResources.length === 0 ? "NOT_APPLICABLE"
    : currencyMismatch ? "CURRENCY_MISMATCH" : firstIncomplete?.apiSpendStatus ?? "CALCULABLE";
  const apiSpend = apiResources.length === 0 ? "0.00000000"
    : apiSpendStatus === "CALCULABLE" ? apiSpends[0]!.amount : null;
  const packageComplete = planResources.every((row) => row.packageCost !== null);
  const packageCurrencyComplete = planResources.every((row) => row.packageCostCurrency !== null);
  const ledgerComplete = apiResources.every((row) => row.ledgerApiCost !== null);
  const packageCost = planResources.length === 0
      ? resources.length === 0 ? null : "0.00000000"
      : packageComplete && packageCurrencyComplete
        && packageCosts.length === 1
        ? packageCosts[0]!.amount
        : null;
  const openingBalance = singleKnownAmount(
    apiResources.length, apiResources.every((row) => row.openingBalance !== null),
    openingBalances, "0.00000000",
  );
  const rechargeAmount = summarizedRecharge(apiResources, rechargeAmounts);
  const endingBalance = singleKnownAmount(
    apiResources.length, apiResources.every((row) => row.endingBalance !== null),
    endingBalances, "0.00000000",
  );
  const costCurrencies = new Set(totalSpends.map((row) => row.currency));
  return {
    apiSpend,
    ledgerApiCost: ledgerComplete
      ? sum(apiResources.map((row) => row.ledgerApiCost!))
      : null,
    packageCost,
    totalSpend: apiSpend !== null && packageCost !== null && totalSpends.length === 1
      ? totalSpends[0]!.amount : null,
    openingBalance,
    rechargeAmount,
    endingBalance,
    currency: costCurrencies.size === 1 ? [...costCurrencies][0]! : null,
    openingBalances, rechargeAmounts, endingBalances, apiSpends, packageCosts, totalSpends,
    apiSpendStatus,
    apiSpendReason: currencyMismatch ? "期初余额、本月充值与期末余额币种不一致" : firstIncomplete?.apiSpendReason ?? null,
  };
}
