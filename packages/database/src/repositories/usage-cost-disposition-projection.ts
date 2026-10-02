import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { effectiveUsageCostDispositionSql } from "./provider-finance-usage-dispositions.js";

/** A disposition contributes no cost only while its original unpriced fact still matches. */
export function effectiveReportedApiCostSql(alias: string) {
  const cost = sql.ref(`${alias}.api_cost`);
  return sql`CASE WHEN ${cost} IS NOT NULL THEN ${cost}
    WHEN ${effectiveUsageCostDispositionSql(alias)} THEN 0::numeric
    ELSE ${cost} END`;
}

export type DispositionCostStatus = "PRICED_USAGE" | "UNKNOWN_COST" | "NOT_MIGRATED"
  | "EXCLUDED_NO_RECORDED_COST";

export interface UsageCostDispositionProjection {
  totalApiCost: string | null;
  apiCostStatus: DispositionCostStatus;
  costCurrency: string | null;
}

export async function loadExcludedUsageCostLineIds(
  db: Kysely<Database>, enterpriseId: string, requestId: string,
): Promise<Set<string>> {
  const result = await sql<{ id: string }>`SELECT line.id FROM ledger_line line
    WHERE line.enterprise_id=${enterpriseId}::uuid AND line.ai_request_id=${requestId}::uuid
      AND ${effectiveUsageCostDispositionSql("line")}`.execute(db);
  return new Set(result.rows.map((row) => row.id));
}

interface ProjectionRow {
  request_id: string;
  has_not_migrated: boolean;
  has_unknown: boolean;
  recorded_count: string;
  recorded_cost: string;
  currency: string | null;
  transaction_status: string;
  transaction_cost: string | null;
}

/** Request-level read overlay; the immutable transaction and ledger lines stay unchanged. */
export async function loadUsageCostDispositionProjections(
  db: Kysely<Database>, enterpriseId: string, requestIds: string[],
): Promise<Map<string, UsageCostDispositionProjection>> {
  if (requestIds.length === 0) return new Map();
  const result = await sql<ProjectionRow>`
    WITH lines AS (
      SELECT line.*, ${effectiveUsageCostDispositionSql("line")} AS excluded
        FROM ledger_line line
       WHERE line.enterprise_id=${enterpriseId}::uuid
         AND line.ai_request_id=ANY(${requestIds}::uuid[])
    )
    SELECT line.ai_request_id AS request_id,
           bool_or(line.api_cost_status='NOT_MIGRATED') AS has_not_migrated,
           bool_or(line.resource_mode='API' AND line.api_cost IS NULL AND NOT line.excluded) AS has_unknown,
           count(line.api_cost) FILTER (WHERE line.resource_mode='API')::text AS recorded_count,
           coalesce(sum(line.api_cost) FILTER (WHERE line.resource_mode='API'),0)::numeric(30,8)::text AS recorded_cost,
           CASE WHEN count(DISTINCT line.api_cost_currency)=1 THEN min(line.api_cost_currency) ELSE NULL END AS currency,
           transaction.api_cost_status AS transaction_status,
           transaction.total_api_cost::text AS transaction_cost
      FROM lines line
      JOIN ledger_transaction transaction ON transaction.enterprise_id=line.enterprise_id
        AND transaction.ai_request_id=line.ai_request_id
     GROUP BY line.ai_request_id, transaction.api_cost_status, transaction.total_api_cost
    HAVING bool_or(line.excluded)
  `.execute(db);
  return new Map(result.rows.map((row) => [row.request_id, projectRequestCost(row)]));
}

function projectRequestCost(row: ProjectionRow): UsageCostDispositionProjection {
  const costCurrency = row.currency;
  if (row.transaction_status === "NOT_MIGRATED" || row.has_not_migrated) {
    return { totalApiCost: null, apiCostStatus: "NOT_MIGRATED", costCurrency: null };
  }
  if (row.has_unknown) return { totalApiCost: null, apiCostStatus: "UNKNOWN_COST", costCurrency };
  if (row.transaction_status === "PRICED_USAGE" && row.transaction_cost !== null) {
    return { totalApiCost: row.transaction_cost, apiCostStatus: "PRICED_USAGE", costCurrency };
  }
  if (Number(row.recorded_count) > 0) {
    return { totalApiCost: row.recorded_cost, apiCostStatus: "PRICED_USAGE", costCurrency };
  }
  return { totalApiCost: "0.00000000", apiCostStatus: "EXCLUDED_NO_RECORDED_COST", costCurrency: null };
}
