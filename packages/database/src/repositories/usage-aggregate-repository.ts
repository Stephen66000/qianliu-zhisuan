import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { rebuildUsageAggregateBucket } from "./usage-aggregate-rebuild.js";

export type UsageAggregateGranularity = "HOUR" | "DAY";

export interface UsageAggregateBucketKey {
  enterpriseId: string;
  bucketGranularity: UsageAggregateGranularity;
  bucketStart: Date;
  timezone: string;
}

export interface UsageAggregateRebuildResult extends UsageAggregateBucketKey {
  rowsWritten: number;
  rowsRemoved: number;
  generatedAt: Date;
}

export interface UsageAggregateRangeResult {
  enterpriseId: string;
  timezone: string;
  from: Date;
  to: Date;
  hourBuckets: number;
  dayBuckets: number;
  rowsWritten: number;
  rowsRemoved: number;
}

interface DirtyBucketRow {
  enterprise_id: string;
  bucket_granularity: UsageAggregateGranularity;
  bucket_start: Date;
  timezone: string;
}

/**
 * Settlement／归属修正事务内的轻量 dirty 写入。
 *
 * 独立队列可表达尚无聚合行的空桶；ON CONFLICT 只刷新 marked_at，不读取账本、
 * 不锁 Gateway 事实表。小时桶按请求时点实际 UTC offset 切分，DST 回拨的两个
 * 同名小时不会合并。
 */
export async function markUsageAggregateDirtyForRequest(
  db: Kysely<Database>,
  enterpriseId: string,
  requestId: string,
): Promise<void> {
  await sql`
    WITH request_fact AS (
      SELECT ar.started_at, e.timezone,
             (ar.started_at AT TIME ZONE e.timezone)
               - (ar.started_at AT TIME ZONE 'UTC') AS utc_offset
        FROM ai_request ar
        JOIN enterprise e ON e.id = ar.enterprise_id
       WHERE ar.enterprise_id = ${enterpriseId}::uuid
         AND ar.id = ${requestId}::uuid
    ), buckets AS (
      SELECT 'HOUR'::varchar(8) AS bucket_granularity,
             date_bin(
               interval '1 hour',
               started_at + utc_offset,
               '1970-01-01 00:00:00+00'::timestamptz
             ) - utc_offset AS bucket_start,
             timezone
        FROM request_fact
      UNION ALL
      SELECT 'DAY'::varchar(8),
             date_trunc('day', started_at AT TIME ZONE timezone) AT TIME ZONE timezone,
             timezone
        FROM request_fact
    )
    INSERT INTO usage_aggregate_dirty_bucket (
      enterprise_id, bucket_granularity, bucket_start, timezone, marked_at
    )
    SELECT ${enterpriseId}::uuid, bucket_granularity, bucket_start, timezone,
           clock_timestamp()
      FROM buckets
    ON CONFLICT (enterprise_id, bucket_granularity, bucket_start, timezone)
    DO UPDATE SET marked_at = clock_timestamp()
  `.execute(db);
}

/** W20-04 可重建读模型；任何方法都只消费 SETTLED 账本，不修正基础事实。 */
export class UsageAggregateRepository {
  constructor(private db: Kysely<Database>) {}

  async markRequestDirty(enterpriseId: string, requestId: string): Promise<void> {
    await markUsageAggregateDirtyForRequest(this.db, enterpriseId, requestId);
  }

  /** 每个调度 tick 保鲜企业当前小时；空小时也会留下完整重建水位。 */
  async markCurrentHoursDirty(now = new Date()): Promise<number> {
    const result = await sql<{ marked: bigint | string }>`
      WITH enterprise_bucket AS (
        SELECT e.id AS enterprise_id, e.timezone,
               (${now}::timestamptz AT TIME ZONE e.timezone)
                 - (${now}::timestamptz AT TIME ZONE 'UTC') AS utc_offset
          FROM enterprise e
      ), written AS (
        INSERT INTO usage_aggregate_dirty_bucket (
          enterprise_id, bucket_granularity, bucket_start, timezone, marked_at
        )
        SELECT enterprise_id, 'HOUR',
               date_bin(
                 interval '1 hour', ${now}::timestamptz + utc_offset,
                 '1970-01-01 00:00:00+00'::timestamptz
               ) - utc_offset,
               timezone, clock_timestamp()
          FROM enterprise_bucket
        ON CONFLICT (enterprise_id, bucket_granularity, bucket_start, timezone)
        DO UPDATE SET marked_at = clock_timestamp()
        RETURNING 1
      )
      SELECT count(*) AS marked FROM written
    `.execute(this.db);
    return Number(result.rows[0]?.marked ?? 0);
  }

  async rebuildBucket(input: UsageAggregateBucketKey): Promise<UsageAggregateRebuildResult> {
    return rebuildUsageAggregateBucket(this.db, input);
  }

  async listDirtyBuckets(
    bucketGranularity: UsageAggregateGranularity,
    limit = 200,
  ): Promise<UsageAggregateBucketKey[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    const rows = await this.db.selectFrom("usage_aggregate_dirty_bucket")
      .select(["enterprise_id", "bucket_granularity", "bucket_start", "timezone"])
      .where("bucket_granularity", "=", bucketGranularity)
      .orderBy("marked_at", "asc")
      .orderBy("enterprise_id", "asc")
      .orderBy("bucket_start", "asc")
      .limit(safeLimit)
      .execute() as DirtyBucketRow[];
    return rows.map(mapBucketKey);
  }

  async rebuildDirtyBuckets(
    bucketGranularity: UsageAggregateGranularity,
    limit = 200,
  ): Promise<UsageAggregateRebuildResult[]> {
    const buckets = await this.listDirtyBuckets(bucketGranularity, limit);
    const results: UsageAggregateRebuildResult[] = [];
    for (const bucket of buckets) results.push(await this.rebuildBucket(bucket));
    return results;
  }

  async rebuildRecentSevenDays(
    now = new Date(),
    days = 7,
  ): Promise<UsageAggregateRebuildResult[]> {
    const safeDays = Math.max(1, Math.min(Math.trunc(days), 31));
    const enterprises = await this.db.selectFrom("enterprise")
      .select(["id", "timezone"])
      .orderBy("id", "asc")
      .execute();
    const results: UsageAggregateRebuildResult[] = [];
    for (const enterprise of enterprises) {
      const range = await sql<{ range_start: Date }>`
        SELECT (((${now}::timestamptz AT TIME ZONE ${enterprise.timezone})::date
                  - (${safeDays}::integer - 1))::timestamp
                AT TIME ZONE ${enterprise.timezone}) AS range_start
      `.execute(this.db);
      const from = range.rows[0]!.range_start;
      for (const granularity of ["HOUR", "DAY"] as const) {
        const starts = await this.listRangeBucketStarts(
          granularity, enterprise.timezone, from, now,
        );
        for (const bucketStart of starts) {
          results.push(await this.rebuildBucket({
            enterpriseId: enterprise.id,
            bucketGranularity: granularity,
            bucketStart,
            timezone: enterprise.timezone,
          }));
        }
      }
    }
    return results;
  }

  async rebuildRange(input: {
    enterpriseId: string;
    from: Date;
    to: Date;
  }): Promise<UsageAggregateRangeResult> {
    if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime())
      || input.from >= input.to) {
      throw new Error("usage aggregate rebuild range is invalid");
    }
    const enterprise = await this.db.selectFrom("enterprise")
      .select(["id", "timezone"])
      .where("id", "=", input.enterpriseId)
      .executeTakeFirst();
    if (!enterprise) throw new Error("usage aggregate enterprise not found");

    const [hourStarts, dayStarts] = await Promise.all([
      this.listRangeBucketStarts("HOUR", enterprise.timezone, input.from, input.to),
      this.listRangeBucketStarts("DAY", enterprise.timezone, input.from, input.to),
    ]);
    let rowsWritten = 0;
    let rowsRemoved = 0;
    for (const [granularity, starts] of [
      ["HOUR", hourStarts] as const,
      ["DAY", dayStarts] as const,
    ]) {
      for (const bucketStart of starts) {
        const rebuilt = await this.rebuildBucket({
          enterpriseId: input.enterpriseId,
          bucketGranularity: granularity,
          bucketStart,
          timezone: enterprise.timezone,
        });
        rowsWritten += rebuilt.rowsWritten;
        rowsRemoved += rebuilt.rowsRemoved;
      }
    }
    return {
      enterpriseId: input.enterpriseId,
      timezone: enterprise.timezone,
      from: input.from,
      to: input.to,
      hourBuckets: hourStarts.length,
      dayBuckets: dayStarts.length,
      rowsWritten,
      rowsRemoved,
    };
  }

  private async listRangeBucketStarts(
    granularity: UsageAggregateGranularity,
    timezone: string,
    from: Date,
    to: Date,
  ): Promise<Date[]> {
    if (granularity === "DAY") {
      const rows = await sql<{ bucket_start: Date }>`
        WITH candidates AS (
          SELECT (local_day::timestamp AT TIME ZONE ${timezone}) AS bucket_start
            FROM generate_series(
              (${from}::timestamptz AT TIME ZONE ${timezone})::date - 1,
              (${to}::timestamptz AT TIME ZONE ${timezone})::date,
              interval '1 day'
            ) local_day
        )
        SELECT bucket_start FROM candidates
         WHERE bucket_start < ${to}::timestamptz
           AND ((bucket_start AT TIME ZONE ${timezone}) + interval '1 day')
                 AT TIME ZONE ${timezone} > ${from}::timestamptz
         ORDER BY bucket_start
      `.execute(this.db);
      return rows.rows.map((row) => row.bucket_start);
    }
    const rows = await sql<{ bucket_start: Date }>`
      WITH points AS (
        SELECT point,
               (point AT TIME ZONE ${timezone})
                 - (point AT TIME ZONE 'UTC') AS utc_offset
          FROM generate_series(
            ${from}::timestamptz - interval '1 hour',
            ${to}::timestamptz,
            interval '1 hour'
          ) point
      ), candidates AS (
        SELECT DISTINCT date_bin(
                 interval '1 hour', point + utc_offset,
                 '1970-01-01 00:00:00+00'::timestamptz
               ) - utc_offset AS bucket_start
          FROM points
      )
      SELECT bucket_start FROM candidates
       WHERE bucket_start < ${to}::timestamptz
         AND bucket_start + interval '1 hour' > ${from}::timestamptz
       ORDER BY bucket_start
    `.execute(this.db);
    return rows.rows.map((row) => row.bucket_start);
  }
}

function mapBucketKey(row: DirtyBucketRow): UsageAggregateBucketKey {
  return {
    enterpriseId: row.enterprise_id,
    bucketGranularity: row.bucket_granularity,
    bucketStart: row.bucket_start,
    timezone: row.timezone,
  };
}
