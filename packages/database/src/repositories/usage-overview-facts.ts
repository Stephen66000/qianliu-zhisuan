import { sql, type Kysely, type RawBuilder } from "kysely";

import type { Database } from "../kysely.js";
import type { UsageOverviewQuery } from "./usage-overview-repository.js";

export interface UsageOverviewRange {
  timezone: string;
  local_start: string;
  local_end: string;
  range_start: Date;
  range_end: Date;
}

interface AggregateCoverageRow {
  expected_count: bigint | string;
  state_count: bigint | string;
  dirty_count: bigint | string;
  generated_at: Date | null;
}

export interface UsageAggregateCoverage {
  complete: boolean;
  generatedAt: Date | null;
  stale: boolean;
}

export async function resolveUsageOverviewRange(
  db: Kysely<Database>,
  input: UsageOverviewQuery,
): Promise<UsageOverviewRange | undefined> {
  const result = await sql<UsageOverviewRange>`
    WITH settings AS (
      SELECT timezone
        FROM enterprise
       WHERE id = ${input.enterpriseId}
    ), local_bounds AS (
      SELECT timezone,
             CASE ${input.period}
               WHEN 'TODAY' THEN date_trunc('day', ${input.anchor}::timestamptz AT TIME ZONE timezone)
               WHEN 'WEEK' THEN date_trunc('week', ${input.anchor}::timestamptz AT TIME ZONE timezone)
               ELSE date_trunc('month', ${input.anchor}::timestamptz AT TIME ZONE timezone)
             END AS local_start
        FROM settings
    ), bounded AS (
      SELECT timezone, local_start,
             local_start + CASE ${input.period}
               WHEN 'TODAY' THEN interval '1 day'
               WHEN 'WEEK' THEN interval '1 week'
               ELSE interval '1 month'
             END AS local_end
        FROM local_bounds
    )
    SELECT timezone,
           local_start::text AS local_start,
           local_end::text AS local_end,
           local_start AT TIME ZONE timezone AS range_start,
           local_end AT TIME ZONE timezone AS range_end
      FROM bounded
  `.execute(db);
  return result.rows[0];
}

export async function loadUsageAggregateCoverage(
  db: Kysely<Database>,
  input: UsageOverviewQuery,
  range: UsageOverviewRange,
  currentTime: Date,
): Promise<UsageAggregateCoverage> {
  const granularity = input.period === "TODAY" ? "HOUR" : "DAY";
  const expected = input.period === "TODAY"
    ? sql`
        SELECT bucket_start
          FROM generate_series(
            ${range.range_start}::timestamptz,
            LEAST(${range.range_end}::timestamptz, ${currentTime}::timestamptz)
              - interval '1 microsecond',
            interval '1 hour'
          ) bucket_start
      `
    : sql`
        SELECT local_bucket AT TIME ZONE ${range.timezone} AS bucket_start
          FROM generate_series(
            ${range.local_start}::timestamp,
            ${range.local_end}::timestamp - interval '1 day',
            interval '1 day'
          ) local_bucket
         WHERE local_bucket AT TIME ZONE ${range.timezone}
               < LEAST(${range.range_end}::timestamptz, ${currentTime}::timestamptz)
      `;
  const result = await sql<AggregateCoverageRow>`
    WITH expected AS (${expected})
    SELECT count(*) AS expected_count,
           count(state.bucket_start) AS state_count,
           count(dirty.bucket_start) AS dirty_count,
           max(state.generated_at) AS generated_at
      FROM expected
      LEFT JOIN usage_aggregate_bucket_state state
        ON state.enterprise_id = ${input.enterpriseId}::uuid
       AND state.bucket_granularity = ${granularity}
       AND state.bucket_start = expected.bucket_start
       AND state.timezone = ${range.timezone}
      LEFT JOIN usage_aggregate_dirty_bucket dirty
        ON dirty.enterprise_id = state.enterprise_id
       AND dirty.bucket_granularity = state.bucket_granularity
       AND dirty.bucket_start = state.bucket_start
       AND dirty.timezone = state.timezone
  `.execute(db);
  const row = result.rows[0];
  const expectedCount = Number(row?.expected_count ?? 0);
  const stateCount = Number(row?.state_count ?? 0);
  const dirtyCount = Number(row?.dirty_count ?? 0);
  const generatedAt = row?.generated_at ?? null;
  const complete = expectedCount > 0
    && stateCount === expectedCount
    && dirtyCount === 0
    && generatedAt !== null;
  return {
    complete,
    generatedAt: complete ? generatedAt : null,
    stale: complete && generatedAt.getTime() < currentTime.getTime() - 10 * 60_000,
  };
}

export function buildLiveUsageFacts(
  input: UsageOverviewQuery,
  range: UsageOverviewRange,
): RawBuilder<unknown> {
  const targetId = input.subjectType === "EMPLOYEE"
    ? sql`source.id`
    : sql`CASE WHEN source.type = 'PROJECT' THEN source.id
               ELSE COALESCE(attribution.project_principal_id, assignment.project_principal_id)
          END`;
  const subjectFilter = input.subjectId ? sql`AND target.id = ${input.subjectId}` : sql``;
  return sql`
    SELECT ar.started_at, lt.created_at AS settled_at,
           target.id AS subject_id, target.name AS subject_name,
           target.department_label,
           1::bigint AS request_count,
           lt.total_input_tokens, lt.total_output_tokens,
           lt.total_cache_tokens, lt.total_reasoning_tokens,
           lt.total_deducted_quota, lt.total_api_cost
      FROM ledger_transaction lt
      JOIN ai_request ar
        ON ar.id = lt.ai_request_id AND ar.enterprise_id = ${input.enterpriseId}
      JOIN principal source
        ON source.id = lt.principal_id AND source.enterprise_id = ${input.enterpriseId}
      LEFT JOIN operating_bill_request_project_assignment assignment
        ON assignment.ai_request_id = lt.ai_request_id
       AND assignment.enterprise_id = ${input.enterpriseId}
      LEFT JOIN LATERAL (
        SELECT snapshot.project_principal_id
          FROM request_attribution_snapshot snapshot
         WHERE snapshot.enterprise_id = ${input.enterpriseId}
           AND snapshot.ai_request_id = lt.ai_request_id
         ORDER BY snapshot.version DESC, snapshot.created_at DESC, snapshot.id DESC
         LIMIT 1
      ) attribution ON true
      JOIN principal target
        ON target.id = ${targetId}
       AND target.enterprise_id = ${input.enterpriseId}
       AND target.type = ${input.subjectType}
     WHERE lt.enterprise_id = ${input.enterpriseId}
       AND lt.status = 'SETTLED'
       AND ar.started_at >= ${range.range_start}
       AND ar.started_at < ${range.range_end}
       ${subjectFilter}
  `;
}

export function buildAggregateUsageFacts(
  input: UsageOverviewQuery,
  range: UsageOverviewRange,
): RawBuilder<unknown> {
  const targetId = input.subjectType === "EMPLOYEE"
    ? sql`aggregate.source_principal_id`
    : sql`aggregate.project_principal_id`;
  const subjectFilter = input.subjectId ? sql`AND target.id = ${input.subjectId}` : sql``;
  const granularity = input.period === "TODAY" ? "HOUR" : "DAY";
  return sql`
    SELECT aggregate.bucket_start AS started_at,
           aggregate.fact_watermark AS settled_at,
           target.id AS subject_id, target.name AS subject_name,
           target.department_label,
           aggregate.request_count,
           aggregate.input_tokens AS total_input_tokens,
           aggregate.output_tokens AS total_output_tokens,
           aggregate.cache_tokens AS total_cache_tokens,
           aggregate.reasoning_tokens AS total_reasoning_tokens,
           aggregate.deducted_quota AS total_deducted_quota,
           aggregate.api_cost AS total_api_cost
      FROM usage_bucket_aggregate aggregate
      JOIN principal target
        ON target.id = ${targetId}
       AND target.enterprise_id = ${input.enterpriseId}
       AND target.type = ${input.subjectType}
     WHERE aggregate.enterprise_id = ${input.enterpriseId}
       AND aggregate.bucket_granularity = ${granularity}
       AND aggregate.timezone = ${range.timezone}
       AND aggregate.bucket_start >= ${range.range_start}
       AND aggregate.bucket_start < ${range.range_end}
       ${subjectFilter}
  `;
}
