import { Decimal } from "decimal.js";
import type {
  DashboardSummary,
  MonthlyFinanceSummary,
  ProviderFinanceRepository,
} from "@qianliu/database";
import type { ProviderFinanceMode } from "@qianliu/config";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

function singleAmount(values: Array<{ currency: string; amount: string }>): string | null {
  return values.length === 1 ? values[0]!.amount : values.length === 0 ? "0.00000000" : null;
}

function combineOperatingCosts(finance: MonthlyFinanceSummary) {
  const totals = new Map<string, Decimal>();
  for (const item of finance.apiOperatingCosts) {
    totals.set(item.currency, (totals.get(item.currency) ?? new Money(0)).plus(item.amount));
  }
  const plan = new Money(finance.codingPlanFixedCostCny);
  if (!plan.isZero()) totals.set("CNY", (totals.get("CNY") ?? new Money(0)).plus(plan));
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toDecimalPlaces(8).toFixed(8) }));
}

export function projectDashboardFinance(
  summary: DashboardSummary,
  finance: MonthlyFinanceSummary,
): DashboardSummary {
  const packagePayments = new Money(finance.codingPlanFixedCostCny).isZero()
    ? [] : [{ currency: "CNY", amount: finance.codingPlanFixedCostCny }];
  const totalSpends = combineOperatingCosts(finance);
  return {
    ...summary,
    monthlyPackagePayment: finance.complete ? singleAmount(packagePayments) : null,
    monthlyPackagePayments: packagePayments,
    monthlyApiCost: finance.complete ? singleAmount(finance.apiOperatingCosts) : null,
    monthlyApiCosts: finance.apiOperatingCosts,
    monthlyApiSpendReason: finance.complete ? null
      : finance.gaps.map((gap) => `${gap.code}:${gap.count}`).join("、"),
    monthlyTotalSpend: finance.complete ? singleAmount(totalSpends) : null,
    monthlyTotalSpends: totalSpends,
    monthlyRechargeAmount: finance.complete ? singleAmount(finance.apiRecharges) : null,
    monthlyRechargeAmounts: finance.apiRecharges,
  };
}

export function shanghaiMonthAt(value: Date): string {
  const shifted = new Date(value.getTime() + 8 * 3600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function shanghaiDateAt(value: Date | string): string {
  const instant = typeof value === "string" ? new Date(value) : value;
  const shifted = new Date(instant.getTime() + 8 * 3600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export async function financeReadModelEnabled(
  mode: ProviderFinanceMode,
  repository: ProviderFinanceRepository,
  enterpriseId: string,
): Promise<boolean> {
  return mode === "DARK" || mode === "ACTIVE"
    && await repository.isStrictWritesEnabled(enterpriseId);
}
