import { Decimal } from "decimal.js";

import type { MonthlyOperatingCostResource, MonthlyOperatingCosts } from "./monthly-operating-cost.js";
import type { OperatingBillGap, OperatingBillProviderRow, OperatingBillSnapshot } from "./operating-bill-types.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const amount = (value: Decimal.Value) => new MoneyDecimal(value).toDecimalPlaces(8).toFixed(8);

export function apiBalanceGaps(
  row: { mode: string; resource_id: string; resource_name: string; snapshot_id: string | null; snapshot_version: number | null },
  monthlyCost: MonthlyOperatingCostResource | undefined,
): OperatingBillGap[] {
  if (row.mode !== "API" || monthlyCost?.apiSpendStatus === "CALCULABLE") return [];
  const fieldByStatus: Record<string, string> = {
    OPENING_BALANCE_MISSING: "opening_balance",
    ENDING_BALANCE_MISSING: "ending_balance",
    CURRENCY_MISMATCH: "currency",
    NEGATIVE_BALANCE_BRIDGE: "api_spend",
  };
  return [{
    code: `API_${monthlyCost?.apiSpendStatus ?? "BALANCE_BRIDGE_MISSING"}`,
    message: `${row.resource_name} ${monthlyCost?.apiSpendReason ?? "余额桥接不可计算"}；API 花费必须使用期初余额 + 本月充值 - 期末余额`,
    providerResourceId: row.resource_id,
    field: fieldByStatus[monthlyCost?.apiSpendStatus ?? ""] ?? "balance_bridge",
    snapshotId: row.snapshot_id,
    snapshotVersion: row.snapshot_version,
  }];
}

export function monthlyProviderCostFields(
  cost: MonthlyOperatingCostResource,
  ledgerApiCost: string | null,
): Pick<OperatingBillProviderRow,
  "apiCost" | "ledgerApiCost" | "openingBalance" | "rechargeAmount" | "apiSpendStatus" |
  "apiSpendReason" | "packageCost" | "totalCost" | "endingBalance" |
  "openingBalanceCurrency" | "rechargeAmounts" | "endingBalanceCurrency" |
  "apiSpendCurrency" | "packageCostCurrency"> {
  return {
    apiCost: cost.apiSpend,
    ledgerApiCost,
    openingBalance: cost.openingBalance,
    openingBalanceCurrency: cost.openingBalanceCurrency,
    rechargeAmount: cost.rechargeAmount,
    rechargeAmounts: cost.rechargeAmounts,
    apiSpendStatus: cost.apiSpendStatus,
    apiSpendReason: cost.apiSpendReason,
    packageCost: cost.packageCost,
    packageCostCurrency: cost.packageCostCurrency,
    totalCost: cost.apiSpend === null || cost.packageCost === null
      ? null : amount(new MoneyDecimal(cost.apiSpend).plus(cost.packageCost)),
    endingBalance: cost.endingBalance,
    endingBalanceCurrency: cost.endingBalanceCurrency,
    apiSpendCurrency: cost.apiSpendCurrency,
  };
}

export function monthlySummaryFields(
  costs: MonthlyOperatingCosts,
): Pick<OperatingBillSnapshot["summary"],
  "totalCost" | "apiCost" | "openingBalance" | "monthlyRecharge" | "apiSpendStatus" |
  "apiSpendReason" | "packageCost" | "endingBalance" | "endingBalanceCurrency" |
  "openingBalances" | "rechargeAmounts" | "endingBalances" | "apiSpends" |
  "packageCosts" | "totalSpends"> {
  return {
    totalCost: costs.summary.totalSpend,
    apiCost: costs.summary.apiSpend,
    openingBalance: costs.summary.openingBalance,
    monthlyRecharge: costs.summary.rechargeAmount,
    apiSpendStatus: costs.summary.apiSpendStatus,
    apiSpendReason: costs.summary.apiSpendReason,
    packageCost: costs.summary.packageCost,
    endingBalance: costs.summary.endingBalance,
    endingBalanceCurrency: costs.summary.endingBalances.length === 1
      ? costs.summary.endingBalances[0]!.currency : null,
    openingBalances: costs.summary.openingBalances,
    rechargeAmounts: costs.summary.rechargeAmounts,
    endingBalances: costs.summary.endingBalances,
    apiSpends: costs.summary.apiSpends,
    packageCosts: costs.summary.packageCosts,
    totalSpends: costs.summary.totalSpends,
  };
}

export function balanceBridgeFacts(costs: MonthlyOperatingCosts) {
  return costs.resources.filter((row) => row.mode === "API").map((row) => ({
    providerResourceId: row.resourceId, currency: row.currency,
    openingSnapshotId: row.openingSnapshotId, openingSnapshotVersion: row.openingSnapshotVersion,
    openingSnapshotAt: row.openingSnapshotAt, endingSnapshotId: row.endingSnapshotId,
    openingBalanceFactId: row.openingBalanceFactId,
    openingBalanceFactVersion: row.openingBalanceFactVersion,
    openingBalanceSource: row.openingBalanceSource,
    endingSnapshotVersion: row.endingSnapshotVersion, endingSnapshotAt: row.endingSnapshotAt,
    openingBalance: row.openingBalance, rechargeAmount: row.rechargeAmount,
    endingBalance: row.endingBalance, apiSpend: row.apiSpend, apiSpendStatus: row.apiSpendStatus,
  }));
}
