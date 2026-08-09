import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  buildEmployeeAccountSummary,
  type RawEmployeeAccountSummary,
} from "./operating-bill-account-detail.js";
import {
  frozenEvidenceState,
  frozenFactsCte,
  OperatingBillAccountEvidenceUnavailableError,
} from "./operating-bill-account-frozen.js";

/** CLOSED 详情在 JSONB 内聚合到 provider/model，Node 只接收小型汇总集。 */
export async function loadFrozenOperatingBillEmployeeSummary(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  principalId: string,
  providerCode?: string,
) {
  if (await frozenEvidenceState(db, enterpriseId, month) !== "AVAILABLE") {
    throw new OperatingBillAccountEvidenceUnavailableError();
  }
  const provider = providerCode ? sql` AND provider_code = ${providerCode}` : sql``;
  const result = await sql<RawEmployeeAccountSummary>`
    WITH ${frozenFactsCte(enterpriseId, month)}, scoped AS (
      SELECT frozen_facts.*,
             COALESCE(unified_model_id::text, 'unresolved:' || historical_alias) AS model_key
        FROM frozen_facts
       WHERE source_principal_type = 'EMPLOYEE' AND source_principal_id = ${principalId}
         ${provider}
    ), summaries AS (
      SELECT CASE WHEN GROUPING(provider_code) = 1 THEN 'TOTAL'
                  WHEN GROUPING(model_key) = 1 THEN 'PROVIDER' ELSE 'MODEL' END AS level,
             provider_code, provider_name, model_key, unified_model_id, current_alias,
             ARRAY_AGG(DISTINCT historical_alias ORDER BY historical_alias) AS historical_aliases,
             SUM(input_tokens::numeric)::text AS input_tokens,
             SUM(output_tokens::numeric)::text AS output_tokens,
             SUM(cache_tokens::numeric)::text AS cache_tokens,
             SUM(reasoning_tokens::numeric)::text AS reasoning_tokens,
             (CASE WHEN COUNT(deducted_quota) = COUNT(*)
               THEN COALESCE(SUM(deducted_quota::numeric), 0) ELSE NULL END)::text AS deducted_quota,
             (CASE WHEN COUNT(api_cost) = COUNT(*)
               THEN COALESCE(SUM(api_cost::numeric), 0) ELSE NULL END)::text AS api_cost,
             (CASE WHEN COUNT(package_allocated_cost) = COUNT(*)
               THEN COALESCE(SUM(package_allocated_cost::numeric), 0) ELSE NULL END)::text
               AS package_allocated_cost,
             STRING_AGG(DISTINCT quality_signature, ',') AS quality_signature,
             COUNT(DISTINCT request_id)::text AS request_count,
             MAX(used_at) AS last_used_at
        FROM scoped
       GROUP BY GROUPING SETS (
         (provider_code, provider_name, model_key, unified_model_id, current_alias),
         (provider_code, provider_name), ()
       )
    ), activity AS (
      SELECT CASE WHEN GROUPING(provider_code) = 1 THEN 'TOTAL'
                  WHEN GROUPING(model_key) = 1 THEN 'PROVIDER' ELSE 'MODEL' END AS level,
             provider_code, provider_name, model_key, unified_model_id, current_alias,
             COUNT(DISTINCT active_date)::text AS active_days
        FROM scoped CROSS JOIN LATERAL unnest(active_dates) active_date
       GROUP BY GROUPING SETS (
         (provider_code, provider_name, model_key, unified_model_id, current_alias),
         (provider_code, provider_name), ()
       )
    )
    SELECT summaries.*, COALESCE(activity.active_days, '0') AS active_days
      FROM summaries LEFT JOIN activity
        ON activity.level = summaries.level
       AND activity.provider_code IS NOT DISTINCT FROM summaries.provider_code
       AND activity.provider_name IS NOT DISTINCT FROM summaries.provider_name
       AND activity.model_key IS NOT DISTINCT FROM summaries.model_key
       AND activity.unified_model_id IS NOT DISTINCT FROM summaries.unified_model_id
       AND activity.current_alias IS NOT DISTINCT FROM summaries.current_alias
  `.execute(db);
  return buildEmployeeAccountSummary(result.rows);
}
