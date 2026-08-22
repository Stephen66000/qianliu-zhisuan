import { Decimal } from "decimal.js";
import type { MonthlyOperatingCostResource } from "@qianliu/database";
import type { ResourceUtilizationRow } from "./query.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export function applyApiBudgetFacts(
  row: Omit<ResourceUtilizationRow, "quotaWindows">,
  operating: MonthlyOperatingCostResource | undefined,
): Omit<ResourceUtilizationRow, "quotaWindows"> {
  if (row.mode !== "API") return row;
  const apiSpend = operating?.apiSpend ?? null;
  const apiSpendCurrency = operating?.apiSpendCurrency ?? null;
  row.apiCost = apiSpend;
  if (apiSpendCurrency) row.currency = apiSpendCurrency;
  if (row.budgetStatus !== "ACTIVE" || row.budgetAmount === null || row.budgetCurrency === null) {
    row.utilizationRate = null;
    row.utilizationBasis = null;
    row.utilizationStatus = "NOT_CONFIGURED";
    row.notCalculableReason = "MONTHLY_BUDGET_NOT_CONFIGURED";
    return row;
  }
  if (apiSpend === null) {
    row.utilizationRate = null;
    row.utilizationBasis = null;
    row.utilizationStatus = "UNKNOWN";
    row.notCalculableReason = operating?.apiSpendReason ?? "API_SPEND_NOT_CALCULABLE";
    return row;
  }
  if (apiSpendCurrency === null || apiSpendCurrency !== row.budgetCurrency) {
    row.utilizationRate = null;
    row.utilizationBasis = null;
    row.utilizationStatus = "UNKNOWN";
    row.notCalculableReason = "BUDGET_CURRENCY_MISMATCH";
    return row;
  }
  const spend = new MoneyDecimal(apiSpend);
  const budget = new MoneyDecimal(row.budgetAmount);
  row.utilizationRate = spend.div(budget).toDecimalPlaces(8).toFixed(8);
  row.budgetDifference = budget.minus(spend).toDecimalPlaces(8).toFixed(8);
  row.utilizationBasis = "API_MONTHLY_BUDGET";
  row.utilizationStatus = spend.gte(budget) ? "OVER_BUDGET"
    : spend.gte(budget.times("0.8")) ? "WARNING" : "NORMAL";
  row.notCalculableReason = null;
  return row;
}
