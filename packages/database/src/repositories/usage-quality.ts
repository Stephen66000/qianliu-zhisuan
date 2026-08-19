export type UsageQualitySummary =
  | "NO_DATA"
  | "PROVIDER_REPORTED"
  | "ESTIMATED"
  | "ACCOUNT_AGGREGATED"
  | "MIXED"
  | "UNKNOWN";

export interface UsageQualityCounts {
  providerReportedCount: number;
  estimatedCount: number;
  accountAggregatedCount: number;
  mixedCount: number;
  unknownCount: number;
}

export function summarizeUsageQuality(
  transactionCount: number,
  counts: UsageQualityCounts,
): UsageQualitySummary {
  if (transactionCount === 0) return "NO_DATA";
  if (counts.unknownCount > 0) return "UNKNOWN";
  const populated = [
    counts.providerReportedCount,
    counts.estimatedCount,
    counts.accountAggregatedCount,
  ].filter((count) => count > 0).length;
  if (counts.mixedCount > 0 || populated > 1) return "MIXED";
  if (counts.accountAggregatedCount > 0) return "ACCOUNT_AGGREGATED";
  if (counts.estimatedCount > 0) return "ESTIMATED";
  return counts.providerReportedCount === transactionCount ? "PROVIDER_REPORTED" : "UNKNOWN";
}
