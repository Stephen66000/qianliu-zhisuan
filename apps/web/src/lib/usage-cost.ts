/** Preserve missing-cost semantics instead of formatting them as a zero charge. */
export function unavailableUsageCostLabel(
  amount: string | null,
  status?: string | null,
): string | null {
  if (status === "NOT_MIGRATED") return "未迁移/不可计算";
  if (status === "EXCLUDED_NO_RECORDED_COST") return "未记录费用，不计入";
  if (status === "NOT_APPLICABLE") return "套餐内";
  if (status === "UNKNOWN_COST" || amount === null) return "未知";
  return null;
}
