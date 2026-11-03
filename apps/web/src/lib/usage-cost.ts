import { formatMoney } from "./format";

/** Preserve missing-cost semantics instead of formatting them as a zero charge. */
export function unavailableUsageCostLabel(
  amount: string | null,
  status?: string | null,
): string | null {
  if (status === "NOT_MIGRATED") return "未迁移/不可计算";
  if (status === "EXCLUDED_NO_RECORDED_COST") return "未记录费用，不计入";
  if (status === "NOT_APPLICABLE") return "套餐内";
  // ACE-04 缺口分类：价格缺失/币种缺失为缺口；价格依据待核实为信息项（不影响完整性），
  // 文案不带"待计价"措辞（WP1 估算合同 §1 gaps 语义）。
  if (status === "PRICE_MISSING") return "价格缺失";
  if (status === "PRICE_BASIS_UNVERIFIED") return "价格依据待核实";
  if (status === "CURRENCY_MISSING") return "币种缺失";
  if (status === "UNKNOWN_COST" || amount === null) return "未知";
  return null;
}

/**
 * 行内单笔金额展示（ACE-07）：消费行内币种字段；无币种才回退 ¥/CNY。
 * 只格式化单值，不做跨币种相加或换算。
 */
export function costMoneyText(value: string, currency?: string | null): string {
  if (currency && currency !== "CNY") return `${currency} ${formatMoney(value)}`;
  return `¥${formatMoney(value)}`;
}
