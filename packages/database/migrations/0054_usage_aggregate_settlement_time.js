/**
 * POOL20-045：用量聚合从请求开始时间切换为账本结算时间。
 *
 * usage_bucket_aggregate 是可重建读模型。升级时清除旧语义缓存，并按已结算
 * ledger_transaction.created_at 重建 dirty 桶；回退时同样清缓存，再按旧的
 * ai_request.started_at 标记，避免任一方向继续读取另一种时间口径的缓存。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    ALTER TABLE usage_event DROP CONSTRAINT usage_event_quality_check;
    ALTER TABLE usage_event ADD CONSTRAINT usage_event_quality_check
      CHECK (usage_quality IN (
        'PROVIDER_REPORTED', 'ESTIMATED', 'ACCOUNT_AGGREGATED', 'MIXED', 'UNKNOWN'
      )) NOT VALID
  `.execute(db);
  await db.schema.alterTable("usage_bucket_aggregate")
    .addColumn("provider_reported_count", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("estimated_count", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("account_aggregated_count", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("mixed_count", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("unknown_count", "bigint", (c) => c.notNull().defaultTo(0))
    .execute();
  await resetAggregateCache(db, "lt.created_at");
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM usage_event WHERE usage_quality = 'MIXED') THEN
        RAISE EXCEPTION '0054 contains MIXED usage facts; destructive down is disabled';
      END IF;
    END;
    $$;
    ALTER TABLE usage_event DROP CONSTRAINT usage_event_quality_check;
    ALTER TABLE usage_event ADD CONSTRAINT usage_event_quality_check
      CHECK (usage_quality IN (
        'PROVIDER_REPORTED', 'ESTIMATED', 'ACCOUNT_AGGREGATED', 'UNKNOWN'
      )) NOT VALID
  `.execute(db);
  await resetAggregateCache(db, "ar.started_at");
  await db.schema.alterTable("usage_bucket_aggregate")
    .dropColumn("unknown_count")
    .dropColumn("mixed_count")
    .dropColumn("account_aggregated_count")
    .dropColumn("estimated_count")
    .dropColumn("provider_reported_count")
    .execute();
}

async function resetAggregateCache(db, factExpression) {
  await sql`TRUNCATE usage_bucket_aggregate, usage_aggregate_bucket_state,
                    usage_aggregate_dirty_bucket`.execute(db);
  const factAt = factExpression === "lt.created_at" ? sql`lt.created_at` : sql`ar.started_at`;
  await sql`
    WITH facts AS (
      SELECT DISTINCT lt.enterprise_id, e.timezone, ${factAt} AS fact_at
        FROM ledger_transaction lt
        JOIN ai_request ar
          ON ar.id = lt.ai_request_id AND ar.enterprise_id = lt.enterprise_id
        JOIN enterprise e ON e.id = lt.enterprise_id
       WHERE lt.status = 'SETTLED'
    ), bucket_facts AS (
      SELECT enterprise_id, timezone, fact_at,
             (fact_at AT TIME ZONE timezone)
               - (fact_at AT TIME ZONE 'UTC') AS utc_offset
        FROM facts
    ), buckets AS (
      SELECT enterprise_id, 'HOUR'::varchar(8) AS bucket_granularity,
             date_bin(interval '1 hour', fact_at + utc_offset,
                      '1970-01-01 00:00:00+00'::timestamptz) - utc_offset AS bucket_start,
             timezone
        FROM bucket_facts
      UNION
      SELECT enterprise_id, 'DAY'::varchar(8),
             date_trunc('day', fact_at AT TIME ZONE timezone) AT TIME ZONE timezone,
             timezone
        FROM bucket_facts
    )
    INSERT INTO usage_aggregate_dirty_bucket (
      enterprise_id, bucket_granularity, bucket_start, timezone, marked_at
    )
    SELECT enterprise_id, bucket_granularity, bucket_start, timezone, clock_timestamp()
      FROM buckets
    ON CONFLICT (enterprise_id, bucket_granularity, bucket_start, timezone)
    DO UPDATE SET marked_at = EXCLUDED.marked_at
  `.execute(db);
}
