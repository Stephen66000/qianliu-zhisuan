import { zeroAggregateRow, mapCountMetrics, mapMetrics, type AggregateRow, type TrendRow, type RankingRow } from "./usage-overview-metrics.js";
import { sql, type Kysely, type RawBuilder } from "kysely";

import type { Database } from "../kysely.js";
import {
  buildAggregateUsageFacts,
  buildLiveUsageFacts,
  loadUsageAggregateCoverage,
  resolveUsageOverviewRange,
  type UsageOverviewRange,
} from "./usage-overview-facts.js";
import { type UsageQualitySummary } from "./usage-quality.js";
import { loadEmployeeAllocations } from "./usage-overview-allocations.js";
import { loadApiCostEstimation, type ApiCostEstimation } from "./api-cost-estimation.js";

export type UsageOverviewSubjectType = "EMPLOYEE" | "PROJECT";
export type UsageOverviewPeriod = "TODAY" | "WEEK" | "MONTH";

export interface UsageOverviewQuery {
  enterpriseId: string;
  subjectType: UsageOverviewSubjectType;
  subjectId?: string;
  period: UsageOverviewPeriod;
  anchor: Date;
  /** Internal report override; ordinary requests use the enterprise timezone. */
  timezone?: string;
  includeEmployeeAllocations?: boolean;
}

export interface UsageOverviewMetrics {
  activeSubjects: number;
  requestCount: string;
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
  realTokens: string;
  apiCost: string | null;
  apiCostStatus: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_APPLICABLE" | "NOT_MIGRATED";
  /** S2B（R7 裁定；语义随 R1-F3 更正）：窗口级"价格依据待核实"——对该窗口企业级调一次
   *  loadApiCostEstimation，期间计价行依据取**结算时冻结快照** sourceStatus（F3：旧行
   *  快照缺键归 UNVERIFIED，不读规则现值），任一 'UNVERIFIED' 即 true。仅汇总级透出；
   *  趋势点/主体排名行（Omit 排除）不拆分主体维度，apiCostStatus 五值枚举与金额口径不变。
   *  仅当 billing_rule.source_status 列存在（0093+）时产出；既有生产 schema（0093 前，
   *  如 worker 独立报表的 0091 水位）上省略该字段——旧 schema 无"核实"概念，语义是
   *  "无此信息"而非"已核实"，不得回填 false。 */
  priceBasisUnverified?: boolean;
  deductedQuota: string;
  usageQuality: UsageQualitySummary;
  providerReportedCount: number;
  estimatedCount: number;
  accountAggregatedCount: number;
  mixedCount: number;
  unknownCount: number;
}

export interface UsageOverviewPoint extends Omit<UsageOverviewMetrics, "activeSubjects" | "priceBasisUnverified"> {
  bucketStart: string;
  bucketEnd: string;
  label: string;
  collectionStatus: "COMPLETE" | "MISSING";
}

export interface UsageOverviewRankingItem extends Omit<UsageOverviewMetrics, "activeSubjects" | "priceBasisUnverified"> {
  subjectId: string;
  subjectName: string;
  departmentLabel: string | null;
  share: string;
  allocatedQuota: string;
  providerAllocations?: Array<{ provider: string; name: string; amount: string; basis: "RAW_TOKEN" | "PLAN_QUOTA" | null }>;
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

  async getActiveSubjectSummary(input: Omit<UsageOverviewQuery, "subjectId">) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const range = await resolveUsageOverviewRange(trx, input);
      if (!range) throw new UsageOverviewEnterpriseNotFoundError();
      const coverage = await loadUsageAggregateCoverage(trx, input, range, this.now());
      const facts = coverage.complete
        ? buildAggregateUsageFacts(input, range)
        : buildLiveUsageFacts(input, range);
      const result = await sql<{ count: string }>`
        SELECT count(DISTINCT subject_id)::text AS count FROM (${facts}) AS facts
      `.execute(trx);
      return {
        timezone: range.timezone,
        range: { from: range.range_start.toISOString(), to: range.range_end.toISOString() },
        activeSubjects: Number(result.rows[0]?.count ?? 0),
      };
    });
  }

  async getOverview(input: UsageOverviewQuery): Promise<UsageOverviewResult> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) =>
      new UsageOverviewRepository(trx, this.now).getOverviewSnapshot(input));
  }

  async getOverviewSnapshot(input: UsageOverviewQuery): Promise<UsageOverviewResult> {
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
    const [trend, ranking, estimation] = await Promise.all([
      this.loadTrend(input, range, facts, currentTime),
      this.loadRanking(facts, aggregate.metrics.realTokens, input.enterpriseId, range.range_end),
      // S2B（R7；语义随 R1-F3 更正）：判定源统一＝loadApiCostEstimation（WP1 合同 §1
      // v1.2：priceBasis 取**结算时冻结快照** sourceStatus，旧行缺键归 UNVERIFIED，
      // 不再读规则现值）；企业级、同窗口（range 为本仓库已解析的企业时区窗口）。只读
      // 额外一次 ledger_line（resource_mode='API'）快照键，不改任何聚合口径。
      // 兼容门（WP5）：loadApiCostEstimation 的 SQL 引用 0093 才有的 billing_rule.source_status，
      // 在既有生产 schema（0093 前，如 worker 独立报表 migrateTo 0091 水位）上会因缺列报错；
      // 先做列存在性检查（见 hasBillingRuleSourceStatusColumn），列不存在则返回 null，
      // priceBasisUnverified 相应省略（undefined 而非 false：旧 schema 无核实概念）。
      this.loadPriceBasisEstimation(input, range),
    ]);
    if (input.includeEmployeeAllocations && input.subjectType === "EMPLOYEE" && ranking.length) {
      const allocations = await loadEmployeeAllocations(this.db, input.enterpriseId, ranking.map((row) => row.subjectId), currentTime);
      for (const row of ranking) row.providerAllocations = allocations.get(row.subjectId) ?? [];
    }
    const metrics: UsageOverviewMetrics = {
      ...aggregate.metrics,
      ...(estimation && {
        priceBasisUnverified: estimation.priceBasis
          .some((basis) => basis.sourceStatus === "UNVERIFIED"),
      }),
    };
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      period: input.period,
      anchor: input.anchor.toISOString(),
      timezone: range.timezone,
      range: { from: range.range_start.toISOString(), to: range.range_end.toISOString() },
      metrics,
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

  /**
   * S2B priceBasisUnverified 的兼容门（WP5）：仅当 billing_rule.source_status 列存在
   * （0093+）时才调用 loadApiCostEstimation 计算"价格依据待核实"。这是 worker 独立报表
   * （report-facts.ts 经 getOverviewSnapshot，report-facts-legacy.integration.test.ts 按
   * migrateTo 0091 水位模拟既有生产 schema）上的兼容行为：该报表合同要求不依赖 0093 的
   * 新表/新列也能出报表。列不存在时返回 null，调用方省略 priceBasisUnverified
   * （保持 undefined、不回填 false——语义是"无此信息"，不是"已核实"）。
   */
  private async loadPriceBasisEstimation(
    input: UsageOverviewQuery,
    range: UsageOverviewRange,
  ): Promise<ApiCostEstimation | null> {
    if (!(await this.hasBillingRuleSourceStatusColumn())) return null;
    return loadApiCostEstimation(this.db, input.enterpriseId, {
      start: range.range_start,
      end: range.range_end,
    });
  }

  /**
   * billing_rule.source_status 列存在性检查：information_schema.columns 上的普通 SELECT，
   * 一次 catalog 点查。取舍：不做仓库实例级缓存——getOverview 每次调用都为新事务新建
   * 仓库实例，worker 报表也是按调用新建（getOverviewSnapshot），实例缓存无收益；模块级
   * 缓存则会跨连接/跨数据库实例（同一进程内多个 testcontainer、多企业库）串状态，且在
   * 0093 上线/回滚后有陈旧风险。每次快照多一次轻量 catalog 查询，可接受。
   */
  private async hasBillingRuleSourceStatusColumn(): Promise<boolean> {
    const result = await sql<{ present: boolean }>`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'billing_rule'
           AND column_name = 'source_status'
      ) AS present
    `.execute(this.db);
    return result.rows[0]?.present ?? false;
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
             CASE
               WHEN bool_or(api_cost_status = 'NOT_MIGRATED') THEN 'NOT_MIGRATED'
               WHEN bool_or(api_cost_status = 'UNKNOWN_COST') THEN 'UNKNOWN_COST'
               WHEN bool_and(api_cost_status = 'NOT_APPLICABLE') THEN 'NOT_APPLICABLE'
               WHEN COALESCE(SUM(CASE WHEN api_cost_status NOT IN ('NOT_APPLICABLE') THEN total_api_cost::numeric ELSE 0 END), 0) = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
               ELSE 'PRICED_USAGE'
             END AS api_cost_status,
             CASE
               WHEN bool_or(api_cost_status = 'NOT_MIGRATED') THEN NULL
               WHEN bool_or(api_cost_status = 'UNKNOWN_COST') THEN NULL
               WHEN bool_and(api_cost_status = 'NOT_APPLICABLE') THEN NULL
               ELSE COALESCE(SUM(CASE WHEN api_cost_status NOT IN ('NOT_APPLICABLE') THEN total_api_cost::numeric ELSE 0 END), 0)::text
             END AS api_cost,
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
             CASE
               WHEN bool_or(f.api_cost_status = 'NOT_MIGRATED') THEN 'NOT_MIGRATED'
               WHEN bool_or(f.api_cost_status = 'UNKNOWN_COST') THEN 'UNKNOWN_COST'
               WHEN bool_and(f.api_cost_status = 'NOT_APPLICABLE') THEN 'NOT_APPLICABLE'
               WHEN COALESCE(SUM(CASE WHEN f.api_cost_status NOT IN ('NOT_APPLICABLE') THEN f.total_api_cost::numeric ELSE 0 END), 0) = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
               ELSE 'PRICED_USAGE'
             END AS api_cost_status,
             CASE
               WHEN bool_or(f.api_cost_status = 'NOT_MIGRATED') THEN NULL
               WHEN bool_or(f.api_cost_status = 'UNKNOWN_COST') THEN NULL
               WHEN bool_and(f.api_cost_status = 'NOT_APPLICABLE') THEN NULL
               ELSE COALESCE(SUM(CASE WHEN f.api_cost_status NOT IN ('NOT_APPLICABLE') THEN f.total_api_cost::numeric ELSE 0 END), 0)::text
             END AS api_cost,
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
             CASE
               WHEN bool_or(f.api_cost_status = 'NOT_MIGRATED') THEN 'NOT_MIGRATED'
               WHEN bool_or(f.api_cost_status = 'UNKNOWN_COST') THEN 'UNKNOWN_COST'
               WHEN bool_and(f.api_cost_status = 'NOT_APPLICABLE') THEN 'NOT_APPLICABLE'
               WHEN COALESCE(SUM(CASE WHEN f.api_cost_status NOT IN ('NOT_APPLICABLE') THEN f.total_api_cost::numeric ELSE 0 END), 0) = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
               ELSE 'PRICED_USAGE'
             END AS api_cost_status,
             CASE
               WHEN bool_or(f.api_cost_status = 'NOT_MIGRATED') THEN NULL
               WHEN bool_or(f.api_cost_status = 'UNKNOWN_COST') THEN NULL
               WHEN bool_and(f.api_cost_status = 'NOT_APPLICABLE') THEN NULL
               ELSE SUM(CASE WHEN f.api_cost_status NOT IN ('NOT_APPLICABLE') THEN f.total_api_cost::numeric ELSE 0 END)::text
             END AS api_cost,
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
