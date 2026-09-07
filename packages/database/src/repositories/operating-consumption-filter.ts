import { sql } from "kysely";

/** Operating usage excludes failed audit rows with no recorded consumption and no committed response.
 * Keep failures with tokens/cost/deduction or committed responses; the request ledger remains untouched.
 * Callers provide the tenant-filtered ledger_line alias ll.
 */
export function operatingConsumptionFilter(alias: "ll" | "line" = "ll") {
  const col = (name: string) => sql.ref(`${alias}.${name}`);
  return sql`NOT (
    ${col("raw_input_tokens")}=0 AND ${col("raw_output_tokens")}=0
    AND COALESCE(${col("raw_cache_tokens")},0)=0 AND COALESCE(${col("raw_reasoning_tokens")},0)=0
    AND COALESCE(${col("api_cost")},0)=0 AND COALESCE(${col("deducted_quota")},0)=0
    AND EXISTS (SELECT 1 FROM ai_request audit_request
      WHERE audit_request.enterprise_id=${col("enterprise_id")} AND audit_request.id=${col("ai_request_id")}
        AND audit_request.status IN ('FAILED','REJECTED'))
    AND NOT EXISTS (SELECT 1 FROM upstream_attempt attempt
      WHERE attempt.enterprise_id=${col("enterprise_id")} AND attempt.ai_request_id=${col("ai_request_id")} AND attempt.response_committed)
  )`;
}
