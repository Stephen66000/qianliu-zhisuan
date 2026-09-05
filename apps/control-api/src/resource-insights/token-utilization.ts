import type { Database } from "@qianliu/database";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { listResourceUtilization, type ResourceUtilizationRow } from "./query.js";

export interface TokenUtilization {
  currentMonthTokens: string;
  trailingThreeMonthAverageTokens: string | null;
  baselineMonths: string[];
  baselineMonthCount: number;
  rate: string | null;
  basis: "CURRENT_MONTH_VS_UP_TO_3_COMPLETE_MONTHS";
  unavailableReason: "INSUFFICIENT_HISTORY" | "ZERO_BASELINE" | null;
}

/** The table and its ratio must use one cutoff and one MVCC snapshot, including the resource list. */
export async function loadResourceUtilizationSnapshot(
  db: Kysely<Database>, enterpriseId: string, month: string, asOf = new Date(),
): Promise<{ generatedAt: string; resources: Array<ResourceUtilizationRow & { tokenUtilization: TokenUtilization }> }> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const resources = await listResourceUtilization(trx, enterpriseId, month, asOf);
    const tokenFacts = await loadResourceTokenUtilization(trx, enterpriseId, month, asOf);
    return { generatedAt: asOf.toISOString(), resources: resources.map((resource) => {
      const tokenUtilization = tokenFacts.get(resource.resourceId);
      if (!tokenUtilization) throw new Error("Resource missing from utilization snapshot");
      return { ...resource, tokenUtilization };
    }) };
  });
}

/** One ledger scan for all resources and four months; legacy settled lines use created_at. */
export async function loadResourceTokenUtilization(
  db: Kysely<Database>, enterpriseId: string, month: string, now = new Date(),
): Promise<Map<string, TokenUtilization>> {
  const result = await sql<{
    resource_id: string; current_tokens: string; average_tokens: string | null;
    baseline_months: string[]; baseline_month_count: number;
    rate: string | null; unavailable_reason: TokenUtilization["unavailableReason"];
  }>`
    WITH bounds AS (
      SELECT e.timezone, ${`${month}-01`}::date AS month_start,
             (${`${month}-01`}::timestamp AT TIME ZONE e.timezone) AS started_at,
             ((${`${month}-01`}::date - interval '3 months') AT TIME ZONE e.timezone) AS baseline_start,
             ((${`${month}-01`}::date + interval '1 month') AT TIME ZONE e.timezone) AS ended_at
        FROM enterprise e WHERE e.id = ${enterpriseId}::uuid
    ), tokens AS (
      SELECT ll.provider_resource_id,
             COALESCE(SUM(ll.raw_input_tokens::numeric + ll.raw_output_tokens)
               FILTER (WHERE COALESCE(ll.settled_at, ll.created_at) >= b.started_at), 0) AS current_tokens,
             COALESCE(SUM(ll.raw_input_tokens::numeric + ll.raw_output_tokens)
               FILTER (WHERE COALESCE(ll.settled_at, ll.created_at) < b.started_at
                 AND pr.created_at <= (date_trunc('month', COALESCE(ll.settled_at, ll.created_at)
                   AT TIME ZONE b.timezone) AT TIME ZONE b.timezone)
                 AND ((date_trunc('month', COALESCE(ll.settled_at, ll.created_at)
                   AT TIME ZONE b.timezone) + interval '1 month') AT TIME ZONE b.timezone) <= ${now}), 0)
               AS baseline_tokens
        FROM ledger_line ll
        JOIN provider_resource pr ON pr.id = ll.provider_resource_id
          AND pr.enterprise_id = ll.enterprise_id
        CROSS JOIN bounds b
       WHERE ll.enterprise_id = ${enterpriseId}::uuid
         AND COALESCE(ll.settled_at, ll.created_at) >= b.baseline_start
         AND COALESCE(ll.settled_at, ll.created_at) < b.ended_at
         AND COALESCE(ll.settled_at, ll.created_at) <= ${now}
       GROUP BY ll.provider_resource_id
    ), facts AS (
      SELECT pr.id AS resource_id, COALESCE(t.current_tokens, 0) AS current_tokens,
             COALESCE(t.baseline_tokens, 0) AS baseline_tokens,
             ARRAY(SELECT to_char(b.month_start - n * interval '1 month', 'YYYY-MM')
                     FROM generate_series(3, 1, -1) AS n
                    WHERE pr.created_at <= ((b.month_start - n * interval '1 month') AT TIME ZONE b.timezone)
                      AND ((b.month_start - (n - 1) * interval '1 month') AT TIME ZONE b.timezone) <= ${now}
             ) AS baseline_months,
             (SELECT count(*)::integer FROM generate_series(1, 3) AS n
               WHERE pr.created_at <= ((b.month_start - n * interval '1 month') AT TIME ZONE b.timezone)
                 AND ((b.month_start - (n - 1) * interval '1 month') AT TIME ZONE b.timezone) <= ${now}
             ) AS baseline_month_count
        FROM provider_resource pr CROSS JOIN bounds b
        LEFT JOIN tokens t ON t.provider_resource_id = pr.id
       WHERE pr.enterprise_id = ${enterpriseId}::uuid
    )
    SELECT resource_id, current_tokens::text, baseline_months, baseline_month_count,
           CASE WHEN baseline_month_count > 0
             THEN round(baseline_tokens / baseline_month_count, 8)::text END AS average_tokens,
           CASE WHEN baseline_month_count > 0 AND baseline_tokens > 0
             THEN round(current_tokens * baseline_month_count / baseline_tokens, 8)::text END AS rate,
           CASE WHEN baseline_month_count = 0 THEN 'INSUFFICIENT_HISTORY'
                WHEN baseline_tokens = 0 THEN 'ZERO_BASELINE' END AS unavailable_reason
      FROM facts
  `.execute(db);
  return new Map(result.rows.map((row) => [row.resource_id, {
    currentMonthTokens: row.current_tokens,
    trailingThreeMonthAverageTokens: row.average_tokens,
    baselineMonths: row.baseline_months,
    baselineMonthCount: row.baseline_month_count,
    rate: row.rate,
    basis: "CURRENT_MONTH_VS_UP_TO_3_COMPLETE_MONTHS",
    unavailableReason: row.unavailable_reason,
  }]));
}
