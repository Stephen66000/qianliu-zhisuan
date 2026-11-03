import { Decimal } from "decimal.js";

import type { ApiCostEstimation } from "./api-cost-estimation.js";
import type { CurrencyAmount, MonthlyOperatingCostResource, MonthlyOperatingCosts } from "./monthly-operating-cost.js";
import type { OperatingBillGap, OperatingBillProviderRow, OperatingBillSnapshot } from "./operating-bill-types.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const amount = (value: Decimal.Value) => new MoneyDecimal(value).toDecimalPlaces(8).toFixed(8);

export function apiBalanceGaps(
  row: { mode: string; resource_id: string; resource_name: string; snapshot_id: string | null; snapshot_version: number | null },
  monthlyCost: MonthlyOperatingCostResource | undefined,
): OperatingBillGap[] {
  // WP2-S5（AFR-07＋WP2 plan §4.5）：OPENING_BALANCE_MISSING → API_OPENING_BALANCE_MISSING
  // 映射恒空——monthly-operating-cost 已停产该状态位（期初缺口随资金管理退役）；
  // 映射结构保留（历史冻结快照形状/其余状态照旧，WP4 处置）。
  // BRIDGE_UNAVAILABLE（期初事实缺席，总指挥 S5 裁定）：桥接不可算但无资金待补含义，
  // 不产生任何资金缺口（AFR-07：不据此阻断当前账单）。
  if (row.mode !== "API" || monthlyCost?.apiSpendStatus === "CALCULABLE"
    || monthlyCost?.apiSpendStatus === "BRIDGE_UNAVAILABLE") return [];
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

/**
 * 同源估算 → 账单 API 费用值（S3b 合同 §1.3 / ACE-03/04/06/07）：
 *   - 单币种已知金额：直接采用估算金额字面值（8 位小数，已知部分保留——KNOWN_PARTIAL
 *     但有金额时照常透出，缺口语义由既有完整性机制表达）；
 *   - 无金额且非 KNOWN_PARTIAL（无 API 账本行 / 仅明确零与合法处置排除）：精确 0；
 *   - 多币种或 KNOWN_PARTIAL 且无金额：null（不混币相加，不把缺失冒充零）。
 * 传 null（非 API 资源 / 未加载估算）返回 null + 空分列。
 */
export function estimatedApiCostFields(
  estimation: Pick<ApiCostEstimation, "amounts" | "completeness"> | null,
): { apiCost: string | null; apiSpends: CurrencyAmount[] } {
  if (estimation === null) return { apiCost: null, apiSpends: [] };
  const apiSpends: CurrencyAmount[] = estimation.amounts.map((amount) => ({
    currency: amount.currency, amount: amount.amount,
  }));
  if (apiSpends.length === 1) return { apiCost: apiSpends[0]!.amount, apiSpends };
  if (apiSpends.length === 0 && estimation.completeness !== "KNOWN_PARTIAL") {
    return { apiCost: "0.00000000", apiSpends };
  }
  return { apiCost: null, apiSpends };
}

function groupByCurrency(
  facts: CurrencyAmount[],
): CurrencyAmount[] {
  const totals = new Map<string, Decimal>();
  for (const fact of facts) {
    totals.set(fact.currency, (totals.get(fact.currency) ?? new MoneyDecimal(0)).plus(fact.amount));
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amountValue]) => ({ currency, amount: amount(amountValue) }));
}

export function monthlyProviderCostFields(
  cost: MonthlyOperatingCostResource,
  ledgerApiCost: string | null,
  estimatedApiCost: string | null,
): Pick<OperatingBillProviderRow,
  "apiCost" | "ledgerApiCost" | "openingBalance" | "rechargeAmount" | "apiSpendStatus" |
  "apiSpendReason" | "packageCost" | "totalCost" | "endingBalance" |
  "openingBalanceCurrency" | "rechargeAmounts" | "endingBalanceCurrency" |
  "apiSpendCurrency" | "packageCostCurrency"> {
  // S3b（合同 §1.3）：apiCost/totalCost 的 API 分量改由同源估算供给；
  // opening/recharge/ending/apiSpendStatus/Reason 等余额桥接机制字段原样保留（WP2/WP4 处置）。
  return {
    apiCost: estimatedApiCost,
    ledgerApiCost,
    openingBalance: cost.openingBalance,
    openingBalanceCurrency: cost.openingBalanceCurrency,
    rechargeAmount: cost.rechargeAmount,
    rechargeAmounts: cost.rechargeAmounts,
    apiSpendStatus: cost.apiSpendStatus,
    apiSpendReason: cost.apiSpendReason,
    packageCost: cost.packageCost,
    packageCostCurrency: cost.packageCostCurrency,
    totalCost: estimatedApiCost === null || cost.packageCost === null
      ? null : amount(new MoneyDecimal(estimatedApiCost).plus(cost.packageCost)),
    endingBalance: cost.endingBalance,
    endingBalanceCurrency: cost.endingBalanceCurrency,
    apiSpendCurrency: cost.apiSpendCurrency,
  };
}

export function monthlySummaryFields(
  costs: MonthlyOperatingCosts,
  estimatedApi: { apiCost: string | null; apiSpends: CurrencyAmount[] },
): Pick<OperatingBillSnapshot["summary"],
  "totalCost" | "apiCost" | "openingBalance" | "monthlyRecharge" | "apiSpendStatus" |
  "apiSpendReason" | "packageCost" | "endingBalance" | "endingBalanceCurrency" |
  "openingBalances" | "rechargeAmounts" | "endingBalances" | "apiSpends" |
  "packageCosts" | "totalSpends"> {
  // S3b（合同 §1.3）：apiCost/apiSpends 改由同源估算供给；totalCost/totalSpends 由
  // 套餐分量（原口径）与估算 API 分量按币种重新合计（单一币种才出 scalar，不混币相加）；
  // openingBalance/monthlyRecharge/endingBalance/apiSpendStatus/Reason 等桥接字段原样保留。
  const totalComplete = estimatedApi.apiCost !== null && costs.summary.packageCost !== null;
  const totalSpends = totalComplete
    ? groupByCurrency([...costs.summary.packageCosts, ...estimatedApi.apiSpends])
    : [];
  return {
    totalCost: totalSpends.length === 1 ? totalSpends[0]!.amount : null,
    apiCost: estimatedApi.apiCost,
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
    apiSpends: estimatedApi.apiSpends,
    packageCosts: costs.summary.packageCosts,
    totalSpends,
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
