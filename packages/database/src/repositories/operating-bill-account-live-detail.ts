import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  buildEmployeeAccountSummary,
  type RawEmployeeAccountSummary,
} from "./operating-bill-account-detail.js";
import { liveLineFactCtes } from "./operating-bill-account-live.js";

/** 在 PostgreSQL 内收敛到 provider/model 粒度，避免大流量员工的整月 request facts 进入 Node。 */
export async function loadLiveOperatingBillEmployeeSummary(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  principalId: string,
  providerCode?: string,
) {
  const provider = providerCode ? sql` AND provider_code = ${providerCode}` : sql``;
  const result = await sql<RawEmployeeAccountSummary>`
    WITH ${liveLineFactCtes(enterpriseId, month)}, employee_lines AS (
      SELECT line_facts.*,
             COALESCE(unified_model_id::text, 'unresolved:' || historical_alias) AS model_key
        FROM line_facts
       WHERE source_principal_type = 'EMPLOYEE' AND source_principal_id = ${principalId}
         ${provider}
    )
    SELECT CASE WHEN GROUPING(provider_code) = 1 THEN 'TOTAL'
                WHEN GROUPING(model_key) = 1 THEN 'PROVIDER' ELSE 'MODEL' END AS level,
           provider_code, provider_name, model_key, unified_model_id, current_alias,
           ARRAY_AGG(DISTINCT historical_alias ORDER BY historical_alias) AS historical_aliases,
           SUM(raw_input_tokens)::text AS input_tokens,
           SUM(raw_output_tokens)::text AS output_tokens,
           SUM(raw_cache_tokens)::text AS cache_tokens,
           SUM(raw_reasoning_tokens)::text AS reasoning_tokens,
           (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
             WHEN COUNT(deducted_quota) FILTER (WHERE resource_mode = 'CODING_PLAN')
                = COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
             THEN COALESCE(SUM(deducted_quota) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)::numeric
             ELSE NULL END)::text AS deducted_quota,
           (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'API') = 0 THEN 0::numeric
             WHEN COUNT(api_cost) FILTER (WHERE resource_mode = 'API')
                = COUNT(*) FILTER (WHERE resource_mode = 'API')
             THEN COALESCE(SUM(api_cost) FILTER (WHERE resource_mode = 'API'), 0)::numeric
             ELSE NULL END)::text AS api_cost,
           (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
             WHEN COUNT(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN')
                = COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
             THEN COALESCE(SUM(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)::numeric
             ELSE NULL END)::text AS package_allocated_cost,
           STRING_AGG(DISTINCT upper(usage_quality), ',' ORDER BY upper(usage_quality)) AS quality_signature,
           COUNT(DISTINCT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD'))::text AS active_days,
           COUNT(DISTINCT request_id)::text AS request_count,
           MAX(created_at) AS last_used_at
      FROM employee_lines
     GROUP BY GROUPING SETS (
       (provider_code, provider_name, model_key, unified_model_id, current_alias),
       (provider_code, provider_name), ()
     )
  `.execute(db);
  return buildEmployeeAccountSummary(result.rows);
}
