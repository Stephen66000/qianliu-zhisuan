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

/** 按币种合并金额分量（不混币相加，多币种时 scalar 由 singleAmount 判 null）。 */
function combineTotals(
  components: Array<Array<{ currency: string; amount: string }>>,
): Array<{ currency: string; amount: string }> {
  const totals = new Map<string, Decimal>();
  for (const component of components) {
    for (const item of component) {
      totals.set(item.currency, (totals.get(item.currency) ?? new Money(0)).plus(item.amount));
    }
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toDecimalPlaces(8).toFixed(8) }));
}

/**
 * /dashboard 首页 finance 开路径投影（S3b 合同 §1.1 / ACE-06/07 / WP0 C1）。
 *
 * 前置条件：summary 必须来自 DashboardRepository.getSummary——其 monthlyApiCost(s)/
 * monthlyApiSpendReason/totalSpend(s) 已由 applyApiCostEstimationToSpend（dashboard-
 * monthly-spend.ts）按 loadApiCostEstimation 同源供给（WP1 S3a）。本函数因此：
 *   - API 费用字段不再用资金读模型覆盖（finance.apiOperatingCosts 弃用），
 *     开/关两条路径的首页 API 金额恒等于同一估算值；
 *   - 套餐分量（monthlyPackagePayment 系列，含 finance.complete 的套餐缺口表达）
 *     与资金域其余字段（monthlyRechargeAmount 系列）原样保留资金读模型取值；
 *   - monthlyTotalSpend(s) 由“资金读模型套餐分量 + 估算 API 分量”按币种重新合计。
 */
export function projectDashboardFinance(
  summary: DashboardSummary,
  finance: MonthlyFinanceSummary,
): DashboardSummary {
  const packagePayments = new Money(finance.codingPlanFixedCostCny).isZero()
    ? [] : [{ currency: "CNY", amount: finance.codingPlanFixedCostCny }];
  const packagePayment = finance.complete ? singleAmount(packagePayments) : null;
  const totalComplete = packagePayment !== null && summary.monthlyApiCost !== null;
  const totalSpends = totalComplete
    ? combineTotals([packagePayments, summary.monthlyApiCosts])
    : [];
  return {
    ...summary,
    monthlyPackagePayment: packagePayment,
    monthlyPackagePayments: packagePayments,
    // API 分量＝估算同源值（getSummary 已按 applyApiCostEstimationToSpend 供给），不再覆盖。
    monthlyApiCost: summary.monthlyApiCost,
    monthlyApiCosts: summary.monthlyApiCosts,
    monthlyApiSpendReason: summary.monthlyApiSpendReason,
    monthlyTotalSpend: totalComplete ? singleAmount(totalSpends) : null,
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
