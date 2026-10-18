export interface UsageQualityFacts {
  usageQuality: "NO_DATA" | "PROVIDER_REPORTED" | "ESTIMATED" | "ACCOUNT_AGGREGATED" | "MIXED" | "UNKNOWN";
  providerReportedCount: number;
  estimatedCount: number;
  accountAggregatedCount: number;
  mixedCount: number;
  unknownCount: number;
}

export function usageQualityText(facts: UsageQualityFacts): string {
  if (facts.usageQuality === "NO_DATA") return "本周期暂无已结算计量";
  if (facts.usageQuality === "PROVIDER_REPORTED") return "全部为厂商上报计量";
  if (facts.usageQuality === "ESTIMATED") return `含 ${facts.estimatedCount} 笔估算计量`;
  if (facts.usageQuality === "ACCOUNT_AGGREGATED") {
    return `含 ${facts.accountAggregatedCount} 笔账户聚合计量，非逐请求精确值`;
  }
  if (facts.usageQuality === "MIXED") {
    return `混合计量：厂商 ${facts.providerReportedCount}、估算 ${facts.estimatedCount}、账户聚合 ${facts.accountAggregatedCount}、维度不完整 ${facts.mixedCount}`;
  }
  return `含 ${facts.unknownCount} 笔计量未知，数值只代表已记录 Token`;
}

const USAGE_QUALITY_LABELS: Record<string, string> = {
  NO_DATA: "暂无计量",
  PROVIDER_REPORTED: "厂商上报",
  ESTIMATED: "估算",
  ACCOUNT_AGGREGATED: "账户聚合",
  MIXED: "混合计量",
  UNKNOWN: "未知",
};

/** 单行计量质量的中文标签；未登记的取值原样返回，便于发现新枚举。 */
export function usageQualityLabel(code: string): string {
  return USAGE_QUALITY_LABELS[code] ?? code;
}
