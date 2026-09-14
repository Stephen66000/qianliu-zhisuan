import { sql, type Kysely, type RawBuilder } from "kysely";

import type { Database } from "../kysely.js";
import {
  buildAggregateUsageFacts,
  buildLiveUsageFacts,
  loadUsageAggregateCoverage,
  resolveUsageOverviewRange,
  type UsageOverviewRange,
} from "./usage-overview-facts.js";
import { summarizeUsageQuality, type UsageQualitySummary } from "./usage-quality.js";

export type UsageOverviewSubjectType = "EMPLOYEE" | "PROJECT";
export type UsageOverviewPeriod = "TODAY" | "WEEK" | "MONTH";

export interface UsageOverviewQuery {
  enterpriseId: string;
  subjectType: UsageOverviewSubjectType;
  subjectId?: string;
  period: UsageOverviewPeriod;
  anchor: Date;
}

export interface UsageOverviewMetrics {
  activeSubjects: number;
  requestCount: string;
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
  realTokens: string;
  apiCost: string;
  deductedQuota: string;
  usageQuality: UsageQualitySummary;
  providerReportedCount: number;
  estimatedCount: number;
  accountAggregatedCount: number;
  mixedCount: number;
  unknownCount: number;
}

export interface UsageOverviewPoint extends Omit<UsageOverviewMetrics, "activeSubjects"> {
  bucketStart: string;
  bucketEnd: string;
  label: string;
  collectionStatus: "COMPLETE" | "MISSING";
}

export interface UsageOverviewRankingItem extends Omit<UsageOverviewMetrics, "activeSubjects"> {
  subjectId: string;
  subjectName: string;
  departmentLabel: string | null;
  share: string;
  allocatedQuota: string;
}

export interface UsageOverviewResult {
  subjectType: UsageOverviewSubjectType;
  subjectId: string | null;
  period: UsageOverviewPeriod;
  anchor: string;
  timezone: string;
  range: { from: string; to: string };
  metrics: UsageOverviewMetrics;
  trend: UsageOverviewPoint[];
  ranking: UsageOverviewRankingItem[];
  source: "LIVE_LEDGER" | "BUCKET_AGGREGATE";
  factWatermark: string | null;
  generatedAt: string;
  stale: boolean;
  detailQuery: {
    principalId: string | null;
    projectId: string | null;
    subjectType: UsageOverviewSubjectType;
    settledOnly: true;
    status: "SUCCEEDED";
    from: string;
    toExclusive: string;
  };
}

export class UsageOverviewEnterpriseNotFoundError extends Error {
  constructor() {
    super("enterprise not found");
    this.name = "UsageOverviewEnterpriseNotFoundError";
  }
}

export class UsageOverviewSubjectNotFoundError extends Error {
  constructor() {
    super("usage overview subject not found");
    this.name = "UsageOverviewSubjectNotFoundError";
  }
}

interface AggregateRow {
  active_subjects: bigint | string;
  request_count: bigint | string;
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  reasoning_tokens: string;
  real_tokens: string;
  api_cost: string;
  deducted_quota: string;
  provider_reported_count: bigint | string;
  estimated_count: bigint | string;
  account_aggregated_count: bigint | string;
  mixed_count: bigint | string;
  unknown_count: bigint | string;
  fact_watermark: Date | null;
}

interface TrendRow extends Omit<AggregateRow, "active_subjects" | "fact_watermark"> {
  bucket_start: Date;
  bucket_end: Date;
  label: string;
  collection_complete: boolean;
}

interface RankingRow extends Omit<AggregateRow, "active_subjects" | "fact_watermark"> {
  subject_id: string;
  subject_name: string;
  department_label: string | null;
  share: string;
  allocated_quota: string;
}

/**
 * W20-04 周期用量查询。
 *
 * 只在查询范围的每个已开始时间桶都有完整重建水位且无 dirty 时读
 * usage_bucket_aggregate。任一缺桶都稳定回退 LIVE_LEDGER，禁止把“未聚合”伪装成 0。
 */
export class UsageOverviewRepository {
  constructor(
    private db: Kysely<Database>,
    private now: () => Date = () => new Date(),
  ) {}

  async getOverview(input: UsageOverviewQuery): Promise<UsageOverviewResult> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) =>
      new UsageOverviewRepository(trx, this.now).getOverviewSnapshot(input));
  }

  private async getOverviewSnapshot(input: UsageOverviewQuery): Promise<UsageOverviewResult> {
    if (input.subjectId) await this.assertOwnedSubject(input);
    const range = await resolveUsageOverviewRange(this.db, input);
    if (!range) throw new UsageOverviewEnterpriseNotFoundError();
    const currentTime = this.now();
    const coverage = await loadUsageAggregateCoverage(this.db, input, range, currentTime);
    const useAggregate = coverage.complete;
    const facts = useAggregate
      ? buildAggregateUsageFacts(input, range)
      : buildLiveUsageFacts(input, range);
    const aggregate = await this.loadMetrics(facts);
    const [trend, ranking] = await Promise.all([
      this.loadTrend(input, range, facts, currentTime),
      this.loadRanking(facts, aggregate.metrics.realTokens, input.enterpriseId, range.range_end),
    ]);
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      period: input.period,
      anchor: input.anchor.toISOString(),
      timezone: range.timezone,
      range: { from: range.range_start.toISOString(), to: range.range_end.toISOString() },
      metrics: aggregate.metrics,
      trend,
      ranking,
      source: useAggregate ? "BUCKET_AGGREGATE" : "LIVE_LEDGER",
      factWatermark: aggregate.factWatermark,
      generatedAt: useAggregate
        ? coverage.generatedAt!.toISOString()
        : currentTime.toISOString(),
      stale: useAggregate ? coverage.stale : false,
      detailQuery: {
        principalId: input.subjectType === "EMPLOYEE" ? input.subjectId ?? null : null,
        projectId: input.subjectType === "PROJECT" ? input.subjectId ?? null : null,
        subjectType: input.subjectType,
        settledOnly: true,
        status: "SUCCEEDED",
        from: range.range_start.toISOString(),
        toExclusive: range.range_end.toISOString(),
      },
    };
  }

  private async assertOwnedSubject(input: UsageOverviewQuery): Promise<void> {
    const subject = await this.db.selectFrom("principal")
      .select("id")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", input.subjectId!)
      .where("type", "=", input.subjectType)
      .executeTakeFirst();
    if (!subject) throw new UsageOverviewSubjectNotFoundError();
  }

  private async loadMetrics(facts: RawBuilder<unknown>): Promise<{
    metrics: UsageOverviewMetrics;
    factWatermark: string | null;
  }> {
    const result = await sql<AggregateRow>`
      WITH facts AS (${facts})
      SELECT COUNT(DISTINCT subject_id) AS active_subjects,
             COALESCE(SUM(request_count), 0) AS request_count,
             COALESCE(SUM(total_input_tokens), 0)::text AS input_tokens,
             COALESCE(SUM(total_output_tokens), 0)::text AS output_tokens,
             COALESCE(SUM(total_cache_tokens), 0)::text AS cache_tokens,
             COALESCE(SUM(total_reasoning_tokens), 0)::text AS reasoning_tokens,
             COALESCE(SUM(total_input_tokens + total_output_tokens), 0)::text AS real_tokens,
             COALESCE(SUM(total_api_cost), 0)::text AS api_cost,
             COALESCE(SUM(total_deducted_quota), 0)::text AS deducted_quota,
             COALESCE(SUM(provider_reported_count), 0) AS provider_reported_count,
             COALESCE(SUM(estimated_count), 0) AS estimated_count,
             COALESCE(SUM(account_aggregated_count), 0) AS account_aggregated_count,
             COALESCE(SUM(mixed_count), 0) AS mixed_count,
             COALESCE(SUM(unknown_count), 0) AS unknown_count,
             MAX(settled_at) AS fact_watermark
        FROM facts
    `.execute(this.db);
    const row = result.rows[0] ?? zeroAggregateRow();
    return {
      metrics: mapMetrics(row),
      factWatermark: row.fact_watermark?.toISOString() ?? null,
    };
  }

  private async loadTrend(
    input: UsageOverviewQuery,
    range: UsageOverviewRange,
    facts: RawBuilder<unknown>,
    currentTime: Date,
  ): Promise<UsageOverviewPoint[]> {
    const period = input.period;
    const label = period === "WEEK"
        ? sql`('周' || substr('一二三四五六日', extract(isodow from local_bucket)::integer, 1))`
        : sql`to_char(local_bucket, 'MM-DD')`;
    const buckets = period === "TODAY"
      ? sql`
          SELECT utc_bucket AS bucket_start,
                 utc_bucket + interval '1 hour' AS bucket_end,
                 to_char(utc_bucket AT TIME ZONE ${range.timezone}, 'HH24:00') AS label
            FROM generate_series(
              ${range.range_start}::timestamptz,
              ${range.range_end}::timestamptz - interval '1 hour',
              interval '1 hour'
            ) utc_bucket
        `
      : sql`
          SELECT local_bucket AT TIME ZONE ${range.timezone} AS bucket_start,
                 (local_bucket + interval '1 day') AT TIME ZONE ${range.timezone} AS bucket_end,
                 ${label} AS label
            FROM generate_series(
              ${range.local_start}::timestamp,
              ${range.local_end}::timestamp - interval '1 day',
              interval '1 day'
            ) AS generated(local_bucket)
        `;
    const result = await sql<TrendRow>`
      WITH facts AS (${facts}), buckets AS (${buckets})
      SELECT b.bucket_start, b.bucket_end, b.label,
             COALESCE(SUM(f.request_count), 0) AS request_count,
             COALESCE(SUM(f.total_input_tokens), 0)::text AS input_tokens,
             COALESCE(SUM(f.total_output_tokens), 0)::text AS output_tokens,
             COALESCE(SUM(f.total_cache_tokens), 0)::text AS cache_tokens,
             COALESCE(SUM(f.total_reasoning_tokens), 0)::text AS reasoning_tokens,
             COALESCE(SUM(f.total_input_tokens + f.total_output_tokens), 0)::text AS real_tokens,
             COALESCE(SUM(f.total_api_cost), 0)::text AS api_cost,
             COALESCE(SUM(f.total_deducted_quota), 0)::text AS deducted_quota
             ,COALESCE(SUM(f.provider_reported_count), 0) AS provider_reported_count
             ,COALESCE(SUM(f.estimated_count), 0) AS estimated_count
             ,COALESCE(SUM(f.account_aggregated_count), 0) AS account_aggregated_count
             ,COALESCE(SUM(f.mixed_count), 0) AS mixed_count
             ,COALESCE(SUM(f.unknown_count), 0) AS unknown_count,
             CASE WHEN b.bucket_end <= ${currentTime}
                    AND EXISTS (
                      SELECT 1
                        FROM usage_aggregate_bucket_state state
                        LEFT JOIN usage_aggregate_dirty_bucket dirty
                          ON dirty.enterprise_id = state.enterprise_id
                         AND dirty.bucket_granularity = state.bucket_granularity
                         AND dirty.bucket_start = state.bucket_start
                         AND dirty.timezone = state.timezone
                       WHERE state.enterprise_id = ${input.enterpriseId}::uuid
                         AND state.bucket_granularity = ${period === "TODAY" ? "HOUR" : "DAY"}
                         AND state.bucket_start = b.bucket_start
                         AND state.timezone = ${range.timezone}
                         AND state.generated_at IS NOT NULL
                         AND dirty.bucket_start IS NULL
                    )
                  THEN true ELSE false END AS collection_complete
        FROM buckets b
        LEFT JOIN facts f ON f.started_at >= b.bucket_start AND f.started_at < b.bucket_end
       GROUP BY b.bucket_start, b.bucket_end, b.label
       ORDER BY b.bucket_start
    `.execute(this.db);
    return result.rows.map((row) => ({
      bucketStart: row.bucket_start.toISOString(),
      bucketEnd: row.bucket_end.toISOString(),
      label: row.label,
      collectionStatus: row.collection_complete ? "COMPLETE" : "MISSING",
      ...mapCountMetrics(row),
    }));
  }

  private async loadRanking(
    facts: RawBuilder<unknown>,
    totalRealTokens: string,
    enterpriseId: string,
    rangeEnd: Date,
  ): Promise<UsageOverviewRankingItem[]> {
    const result = await sql<RankingRow>`
      WITH facts AS (${facts})
      SELECT f.subject_id, f.subject_name, f.department_label,
             SUM(f.request_count) AS request_count,
             SUM(f.total_input_tokens)::text AS input_tokens,
             SUM(f.total_output_tokens)::text AS output_tokens,
             SUM(f.total_cache_tokens)::text AS cache_tokens,
             SUM(f.total_reasoning_tokens)::text AS reasoning_tokens,
             SUM(f.total_input_tokens + f.total_output_tokens)::text AS real_tokens,
             COALESCE((
               SELECT SUM(pg.quota_value)::text
                 FROM principal_grant pg
                WHERE pg.enterprise_id = ${enterpriseId}
                  AND pg.principal_id = f.subject_id
                  AND pg.status = 'ACTIVE'
                  AND (pg.valid_until IS NULL OR pg.valid_until > ${rangeEnd})
             ), '0') AS allocated_quota,
             SUM(f.total_api_cost)::text AS api_cost,
             SUM(f.total_deducted_quota)::text AS deducted_quota,
             SUM(f.provider_reported_count) AS provider_reported_count,
             SUM(f.estimated_count) AS estimated_count,
             SUM(f.account_aggregated_count) AS account_aggregated_count,
             SUM(f.mixed_count) AS mixed_count,
             SUM(f.unknown_count) AS unknown_count,
             CASE WHEN ${totalRealTokens}::numeric = 0 THEN '0'
                  ELSE (SUM(f.total_input_tokens + f.total_output_tokens)::numeric /
                        ${totalRealTokens}::numeric)::text END AS share
        FROM facts f
       GROUP BY f.subject_id, f.subject_name, f.department_label
       ORDER BY SUM(f.total_input_tokens + f.total_output_tokens) DESC, f.subject_name, f.subject_id
       LIMIT 100
    `.execute(this.db);
    return result.rows.map((row) => ({
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      departmentLabel: row.department_label,
      ...mapCountMetrics(row),
      share: row.share,
      allocatedQuota: row.allocated_quota ?? "0",
    }));
  }
}

function zeroAggregateRow(): AggregateRow {
  return {
    active_subjects: 0n, request_count: 0n, input_tokens: "0", output_tokens: "0",
    cache_tokens: "0", reasoning_tokens: "0", real_tokens: "0", api_cost: "0",
    deducted_quota: "0", provider_reported_count: 0n, estimated_count: 0n,
    account_aggregated_count: 0n, mixed_count: 0n, unknown_count: 0n,
    fact_watermark: null,
  };
}

function mapCountMetrics(row: Omit<AggregateRow, "active_subjects" | "fact_watermark">) {
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
    deductedQuota: row.deducted_quota,
    usageQuality: summarizeUsageQuality(requestCount, {
      providerReportedCount, estimatedCount, accountAggregatedCount, mixedCount, unknownCount,
    }),
    providerReportedCount, estimatedCount, accountAggregatedCount, mixedCount, unknownCount,
  };
}

function mapMetrics(row: AggregateRow): UsageOverviewMetrics {
  return { activeSubjects: Number(row.active_subjects), ...mapCountMetrics(row) };
}

function normalizeApiCost(value: string): string {
  if (/^[+-]?0+(?:\.0+)?$/.test(value)) return "0";
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(8, "0")}`;
}
