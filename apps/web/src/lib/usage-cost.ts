import { formatDecimal, formatMoney } from "./format";

/** ACE-04 信息项文案（R7 聚合级角标与逐请求角标共用同一分支文案，不另造措辞）。 */
export const PRICE_BASIS_UNVERIFIED_LABEL = "价格依据待核实";

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
  if (status === "PRICE_BASIS_UNVERIFIED") return PRICE_BASIS_UNVERIFIED_LABEL;
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

/**
 * 请求详情精确金额展示（走查缺陷 D-1，2026-11-04 裁定：现在修）。
 * 验收计划 §3："小额非零估算应能从详情查明"——详情下钻不做两位舍入，
 * 按后端 8 位小数尺度原值直出（如 0.00104）；币种规则与 costMoneyText 一致。
 * 列表页两位舍入展示（costMoneyText/formatMoney）不受影响。
 */
export function costMoneyExactText(value: string, currency?: string | null): string {
  if (currency && currency !== "CNY") return `${currency} ${formatDecimal(value, 8)}`;
  return `¥${formatDecimal(value, 8)}`;
}
