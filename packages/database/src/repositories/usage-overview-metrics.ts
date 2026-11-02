import { summarizeUsageQuality } from "./usage-quality.js";
import type { UsageOverviewMetrics } from "./usage-overview-repository.js";

export interface AggregateRow {
  active_subjects: bigint | string;
  request_count: bigint | string;
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  reasoning_tokens: string;
  real_tokens: string;
  api_cost: string | null;
  api_cost_status: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_APPLICABLE" | "NOT_MIGRATED";
  deducted_quota: string;
  provider_reported_count: bigint | string;
  estimated_count: bigint | string;
  account_aggregated_count: bigint | string;
  mixed_count: bigint | string;
  unknown_count: bigint | string;
  fact_watermark: Date | null;
}

export interface TrendRow extends Omit<AggregateRow, "active_subjects" | "fact_watermark"> {
  bucket_start: Date;
  bucket_end: Date;
  label: string;
  collection_complete: boolean;
}

export interface RankingRow extends Omit<AggregateRow, "active_subjects" | "fact_watermark"> {
  subject_id: string;
  subject_name: string;
  department_label: string | null;
  share: string;
  allocated_quota: string;
}

export function zeroAggregateRow(): AggregateRow {
  return {
    active_subjects: 0n, request_count: 0n, input_tokens: "0", output_tokens: "0",
    cache_tokens: "0", reasoning_tokens: "0", real_tokens: "0", api_cost: "0",
    api_cost_status: "CONFIRMED_ZERO_NO_UPSTREAM",
    deducted_quota: "0", provider_reported_count: 0n, estimated_count: 0n,
    account_aggregated_count: 0n, mixed_count: 0n, unknown_count: 0n,
    fact_watermark: null,
  };
}

export function mapCountMetrics(row: Omit<AggregateRow, "active_subjects" | "fact_watermark">) {
  const providerReportedCount = Number(row.provider_reported_count);
  const estimatedCount = Number(row.estimated_count);
  const accountAggregatedCount = Number(row.account_aggregated_count);
  const mixedCount = Number(row.mixed_count);
  const unknownCount = Number(row.unknown_count);
  const requestCount = Number(row.request_count);
  return {
    requestCount: String(row.request_count), inputTokens: row.input_tokens,
    outputTokens: row.output_tokens, cacheTokens: row.cache_tokens,
    reasoningTokens: row.reasoning_tokens, realTokens: row.real_tokens,
    apiCost: normalizeApiCost(row.api_cost),
    apiCostStatus: row.api_cost_status,
    deductedQuota: row.deducted_quota,
    usageQuality: summarizeUsageQuality(requestCount, {
      providerReportedCount, estimatedCount, accountAggregatedCount, mixedCount, unknownCount,
    }),
    providerReportedCount, estimatedCount, accountAggregatedCount, mixedCount, unknownCount,
  };
}

export function mapMetrics(row: AggregateRow): UsageOverviewMetrics {
  return { activeSubjects: Number(row.active_subjects), ...mapCountMetrics(row) };
}

function normalizeApiCost(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  if (/^[+-]?0+(?:\.0+)?$/.test(value)) return "0";
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(8, "0")}`;
}
