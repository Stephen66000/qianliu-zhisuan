import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
import { effectiveUsageCostDispositionSql } from "./provider-finance-usage-dispositions.js";

export const API_COST_GAP_CODES = [
  "API_USAGE_COST_UNKNOWN", "API_COST_CURRENCY_MISSING", "API_COST_CURRENCY_CONFLICT",
  "API_USAGE_COST_NOT_MIGRATED",
] as const;

export interface ApiCostGapFact {
  code: typeof API_COST_GAP_CODES[number];
  providerResourceId: string;
  count: string;
  requestCount: string;
  requestRangeFrom: Date;
  requestRangeTo: Date;
}

/** Shared expense-quality facts for monthly reports and cumulative balance explanations. */
export async function loadApiCostGaps(
  db: Kysely<Database>, enterpriseId: string, start: Date, end: Date,
): Promise<ApiCostGapFact[]> {
  const effectiveStart = start < PROVIDER_FINANCE_CUTOVER ? PROVIDER_FINANCE_CUTOVER : start;
  if (effectiveStart >= end) return [];
  const result = await sql<ApiCostGapFact>`
    WITH resource_currencies AS MATERIALIZED (
      SELECT provider_resource_id, account_currency AS currency
        FROM provider_finance_event
       WHERE enterprise_id=${enterpriseId}::uuid AND event_type LIKE 'API_%'
      UNION
      SELECT line.provider_resource_id, evidence.currency
        FROM ledger_line line
        CROSS JOIN LATERAL (VALUES (line.api_cost_currency),
          (line.billing_rule_snapshot->>'currency')) evidence(currency)
       WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
         AND evidence.currency IS NOT NULL
    )
    SELECT gap.code, line.provider_resource_id AS "providerResourceId",
           COUNT(*)::text AS count, COUNT(DISTINCT line.ai_request_id)::text AS "requestCount",
           MIN(COALESCE(line.settled_at,line.created_at)) AS "requestRangeFrom",
           MAX(COALESCE(line.settled_at,line.created_at)) AS "requestRangeTo"
      FROM ledger_line line
      LEFT JOIN provider_finance_legacy_cost_resolution resolution
        ON resolution.enterprise_id=line.enterprise_id AND resolution.id=line.legacy_cost_resolution_id
      CROSS JOIN LATERAL (VALUES
        ('API_USAGE_COST_UNKNOWN',
          (line.api_cost_status='UNKNOWN_COST'
            OR (line.api_cost_status IS NULL AND (line.api_cost IS NULL
              OR line.raw_input_tokens > 0 OR line.raw_output_tokens > 0
              OR COALESCE(line.raw_cache_tokens,0) > 0 OR COALESCE(line.raw_reasoning_tokens,0) > 0)))
          AND (resolution.id IS NULL OR resolution.status<>'RESOLVED')
          AND NOT ${effectiveUsageCostDispositionSql("line")}),
        ('API_COST_CURRENCY_MISSING',
          line.api_cost IS NOT NULL AND line.api_cost_currency IS NULL
          AND line.api_cost_status IS DISTINCT FROM 'CONFIRMED_ZERO_NO_UPSTREAM'),
        ('API_COST_CURRENCY_CONFLICT',
          line.api_cost_currency IS NOT NULL AND line.billing_rule_snapshot->>'currency' IS NOT NULL
          AND line.billing_rule_snapshot->>'currency' <> line.api_cost_currency),
        ('API_USAGE_COST_NOT_MIGRATED',
          line.api_cost_status='NOT_MIGRATED' AND NOT EXISTS (
            -- 0084 defines historical usage cost as cutover through occurred_at.
            -- Coverage only counts when its amount is included in this expense window.
            SELECT 1 FROM provider_finance_event historical
             WHERE historical.enterprise_id=line.enterprise_id
               AND historical.provider_resource_id=line.provider_resource_id
               AND historical.event_type='API_HISTORICAL_USAGE_COST'
               AND historical.occurred_at>=${start} AND historical.occurred_at<${end}
               AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
               AND COALESCE(line.settled_at,line.created_at)<=historical.occurred_at
               AND (line.billing_rule_snapshot->>'currency'=historical.account_currency
                 OR (line.billing_rule_snapshot->>'currency' IS NULL AND NOT EXISTS (
                   SELECT 1 FROM resource_currencies evidence
                    WHERE evidence.provider_resource_id=line.provider_resource_id
                      AND evidence.currency<>historical.account_currency
                 )))
          ))
      ) gap(code, missing)
     WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
       AND COALESCE(line.settled_at,line.created_at)>=${effectiveStart}
       AND COALESCE(line.settled_at,line.created_at)<${end} AND gap.missing
     GROUP BY line.provider_resource_id, gap.code
     ORDER BY line.provider_resource_id, gap.code
  `.execute(db);
  return result.rows;
}
