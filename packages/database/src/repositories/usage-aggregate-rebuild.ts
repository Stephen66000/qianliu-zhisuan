import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import type {
  UsageAggregateBucketKey,
  UsageAggregateRebuildResult,
} from "./usage-aggregate-repository.js";

interface RebuildCountRow {
  rows_written: bigint | string;
  rows_removed: bigint | string;
}

export async function rebuildUsageAggregateBucket(
  db: Kysely<Database>,
  input: UsageAggregateBucketKey,
): Promise<UsageAggregateRebuildResult> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`${input.enterpriseId}:${input.bucketGranularity}:${input.bucketStart.toISOString()}:${input.timezone}`},
      20
    ))`.execute(trx);
    const clock = await sql<{ generated_at: Date }>`
      SELECT clock_timestamp() AS generated_at
    `.execute(trx);
    const generatedAt = clock.rows[0]!.generated_at;

    const result = await sql<RebuildCountRow>`
      WITH bounds AS (
        SELECT ${input.bucketStart}::timestamptz AS range_start,
               CASE WHEN ${input.bucketGranularity}::text = 'HOUR'
                 THEN ${input.bucketStart}::timestamptz + interval '1 hour'
                 ELSE ((${input.bucketStart}::timestamptz AT TIME ZONE ${input.timezone})
                       + interval '1 day') AT TIME ZONE ${input.timezone}
               END AS range_end
      ), request_facts AS (
        SELECT lt.ai_request_id, lt.principal_id AS source_principal_id,
               CASE WHEN source.type = 'PROJECT' THEN source.id
                    ELSE COALESCE(attribution.project_principal_id,
                                  legacy_assignment.project_principal_id)
                END AS project_principal_id,
               final_line.provider_resource_id,
               ar.unified_model_id,
               lt.total_input_tokens, lt.total_output_tokens,
               lt.total_cache_tokens, lt.total_reasoning_tokens,
               lt.total_deducted_quota, lt.total_api_cost,
               lt.usage_quality,
               COALESCE(final_line.ledger_watermark, lt.created_at) AS ledger_watermark,
               lt.created_at AS settled_at
          FROM ledger_transaction lt
          JOIN ai_request ar
            ON ar.id = lt.ai_request_id AND ar.enterprise_id = lt.enterprise_id
          JOIN principal source
            ON source.id = lt.principal_id AND source.enterprise_id = lt.enterprise_id
          CROSS JOIN bounds b
          LEFT JOIN LATERAL (
            SELECT snapshot.project_principal_id
              FROM request_attribution_snapshot snapshot
             WHERE snapshot.enterprise_id = lt.enterprise_id
               AND snapshot.ai_request_id = lt.ai_request_id
             ORDER BY snapshot.version DESC, snapshot.created_at DESC, snapshot.id DESC
             LIMIT 1
          ) attribution ON true
          LEFT JOIN operating_bill_request_project_assignment legacy_assignment
            ON legacy_assignment.enterprise_id = lt.enterprise_id
           AND legacy_assignment.ai_request_id = lt.ai_request_id
          LEFT JOIN LATERAL (
            SELECT
              (array_agg(ll.provider_resource_id
                 ORDER BY COALESCE(ua.attempt_no, 0) DESC, ll.created_at DESC, ll.id DESC))[1]
                AS provider_resource_id,
              max(ll.created_at) AS ledger_watermark
              FROM ledger_line ll
              LEFT JOIN upstream_attempt ua
                ON ua.id = ll.upstream_attempt_id
               AND ua.enterprise_id = ll.enterprise_id
             WHERE ll.enterprise_id = lt.enterprise_id
               AND ll.ai_request_id = lt.ai_request_id
          ) final_line ON true
         WHERE lt.enterprise_id = ${input.enterpriseId}::uuid
           AND lt.status = 'SETTLED'
           AND lt.created_at >= b.range_start
           AND lt.created_at < b.range_end
      ), aggregated AS MATERIALIZED (
        SELECT source_principal_id, project_principal_id, provider_resource_id,
               unified_model_id,
               count(DISTINCT ai_request_id)::bigint AS request_count,
               sum(total_input_tokens)::bigint AS input_tokens,
               sum(total_output_tokens)::bigint AS output_tokens,
               sum(total_cache_tokens)::bigint AS cache_tokens,
               sum(total_reasoning_tokens)::bigint AS reasoning_tokens,
               sum(total_deducted_quota)::bigint AS deducted_quota,
               sum(total_api_cost)::numeric(30, 8) AS api_cost,
               count(*) FILTER (WHERE usage_quality IN ('PROVIDER_REPORTED', 'UPSTREAM_REPORTED'))::bigint AS provider_reported_count,
               count(*) FILTER (
                 WHERE usage_quality = 'ESTIMATED' OR usage_quality LIKE 'MIXED:%ESTIMATED%'
               )::bigint AS estimated_count,
               count(*) FILTER (WHERE usage_quality = 'ACCOUNT_AGGREGATED')::bigint AS account_aggregated_count,
               count(*) FILTER (
                 WHERE usage_quality LIKE 'MIXED%'
                   AND usage_quality NOT LIKE '%ESTIMATED%'
                   AND usage_quality NOT LIKE '%UNKNOWN%'
               )::bigint AS mixed_count,
               count(*) FILTER (
                 WHERE usage_quality = 'UNKNOWN' OR usage_quality LIKE 'MIXED:%UNKNOWN%'
               )::bigint AS unknown_count,
               max(ledger_watermark) AS fact_watermark,
               max(settled_at) AS max_fact_at
          FROM request_facts
         GROUP BY source_principal_id, project_principal_id, provider_resource_id,
                  unified_model_id
      ), removed AS (
        DELETE FROM usage_bucket_aggregate existing
         WHERE existing.enterprise_id = ${input.enterpriseId}::uuid
           AND existing.bucket_granularity = ${input.bucketGranularity}
           AND existing.bucket_start = ${input.bucketStart}
           AND existing.timezone = ${input.timezone}
           AND NOT EXISTS (
             SELECT 1 FROM aggregated next
              WHERE next.source_principal_id = existing.source_principal_id
                AND next.project_principal_id IS NOT DISTINCT FROM existing.project_principal_id
                AND next.provider_resource_id IS NOT DISTINCT FROM existing.provider_resource_id
                AND next.unified_model_id IS NOT DISTINCT FROM existing.unified_model_id
           )
        RETURNING 1
      ), written AS (
        INSERT INTO usage_bucket_aggregate (
          enterprise_id, bucket_granularity, bucket_start, timezone,
          source_principal_id, project_principal_id, provider_resource_id,
          unified_model_id, request_count, input_tokens, output_tokens,
          cache_tokens, reasoning_tokens, deducted_quota, api_cost,
          provider_reported_count, estimated_count, account_aggregated_count,
          mixed_count, unknown_count,
          fact_watermark, max_fact_at, dirty, generated_at
        )
        SELECT ${input.enterpriseId}::uuid, ${input.bucketGranularity},
               ${input.bucketStart}, ${input.timezone},
               source_principal_id, project_principal_id, provider_resource_id,
               unified_model_id, request_count, input_tokens, output_tokens,
               cache_tokens, reasoning_tokens, deducted_quota, api_cost,
               provider_reported_count, estimated_count, account_aggregated_count,
               mixed_count, unknown_count,
               fact_watermark, max_fact_at, false, ${generatedAt}
          FROM aggregated
        ON CONFLICT (
          enterprise_id, bucket_granularity, bucket_start, timezone,
          source_principal_id, project_principal_id, provider_resource_id,
          unified_model_id
        ) DO UPDATE SET
          request_count = EXCLUDED.request_count,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_tokens = EXCLUDED.cache_tokens,
          reasoning_tokens = EXCLUDED.reasoning_tokens,
          deducted_quota = EXCLUDED.deducted_quota,
          api_cost = EXCLUDED.api_cost,
          provider_reported_count = EXCLUDED.provider_reported_count,
          estimated_count = EXCLUDED.estimated_count,
          account_aggregated_count = EXCLUDED.account_aggregated_count,
          mixed_count = EXCLUDED.mixed_count,
          unknown_count = EXCLUDED.unknown_count,
          fact_watermark = EXCLUDED.fact_watermark,
          max_fact_at = EXCLUDED.max_fact_at,
          dirty = false,
          generated_at = EXCLUDED.generated_at
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM written) AS rows_written,
             (SELECT count(*) FROM removed) AS rows_removed
    `.execute(trx);

    await sql`
      INSERT INTO usage_aggregate_bucket_state (
        enterprise_id, bucket_granularity, bucket_start, timezone,
        fact_watermark, max_fact_at, generated_at
      )
      SELECT ${input.enterpriseId}::uuid, ${input.bucketGranularity},
             ${input.bucketStart}, ${input.timezone},
             max(fact_watermark), max(max_fact_at), ${generatedAt}
        FROM usage_bucket_aggregate
       WHERE enterprise_id = ${input.enterpriseId}::uuid
         AND bucket_granularity = ${input.bucketGranularity}
         AND bucket_start = ${input.bucketStart}
         AND timezone = ${input.timezone}
      ON CONFLICT (enterprise_id, bucket_granularity, bucket_start, timezone)
      DO UPDATE SET
        fact_watermark = EXCLUDED.fact_watermark,
        max_fact_at = EXCLUDED.max_fact_at,
        generated_at = EXCLUDED.generated_at
    `.execute(trx);

    // 只消费本次开始前的 dirty；重建期间新到的 Settlement 标记必须保留。
    await trx.deleteFrom("usage_aggregate_dirty_bucket")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("bucket_granularity", "=", input.bucketGranularity)
      .where("bucket_start", "=", input.bucketStart)
      .where("timezone", "=", input.timezone)
      .where("marked_at", "<=", generatedAt)
      .execute();

    const counts = result.rows[0] ?? { rows_written: 0n, rows_removed: 0n };
    return {
      ...input,
      rowsWritten: Number(counts.rows_written),
      rowsRemoved: Number(counts.rows_removed),
      generatedAt,
    };
  });
}
