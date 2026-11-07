import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { decimalTextsEqual } from "./dashboard-helpers.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";
import type { ResourceMode } from "./dashboard-types.js";

/**
 * buildResourceBreakdown 的 SQL 事实查询段（拨备池聚合 + 供给预测）。
 * 原样搬运自 dashboard-breakdown.ts：SQL 文本与行契约逐字不变，语义零变化。
 */

export async function sumAllocatedQuota(
  db: Kysely<Database>,
  enterpriseId: string,
  providerCode: string,
  mode: ResourceMode,
  now: Date,
): Promise<string> {
  const row = await sql<{ total: string }>`
    WITH active_grants AS (
      SELECT * FROM principal_grant
       WHERE enterprise_id = ${enterpriseId}
         AND provider = ${providerCode} AND status = 'ACTIVE'
         AND valid_from <= ${now}
         AND (valid_until IS NULL OR valid_until > ${now})
    )
    SELECT COALESCE(SUM(g.quota_value::numeric), 0)::text AS total
    FROM active_grants g
    WHERE g.pool_model_alias = '*'
      OR (g.pool_model_alias IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM active_grants pool
           WHERE pool.principal_id = g.principal_id AND pool.pool_model_alias = '*'
        )
        AND (
        EXISTS (
          SELECT 1
            FROM unified_model um
            JOIN model_route mr
              ON mr.unified_model_id = um.id
             AND mr.enterprise_id = ${enterpriseId}
             AND mr.archived_at IS NULL
            JOIN provider_resource pr
              ON pr.id = mr.provider_resource_id
             AND pr.enterprise_id = ${enterpriseId}
             AND pr.status <> 'DELETED'
            JOIN provider p
              ON p.id = pr.provider_id
             AND p.enterprise_id = ${enterpriseId}
           WHERE um.enterprise_id = ${enterpriseId}
             AND um.alias = g.model_alias
             AND p.code = ${providerCode}
             AND pr.mode = ${mode}
        )
        OR (
          ${mode} = 'CODING_PLAN'
          AND NOT EXISTS (
            SELECT 1
              FROM unified_model um
              JOIN model_route mr
                ON mr.unified_model_id = um.id
               AND mr.enterprise_id = ${enterpriseId}
               AND mr.archived_at IS NULL
              JOIN provider_resource pr
                ON pr.id = mr.provider_resource_id
               AND pr.enterprise_id = ${enterpriseId}
               AND pr.status <> 'DELETED'
             WHERE um.enterprise_id = ${enterpriseId}
               AND um.alias = g.model_alias
          )
        )
      ))
  `.execute(db);
  return row.rows[0]?.total ?? "0";
}

export async function latestProviderForecast(
  db: Kysely<Database>,
  enterpriseId: string,
  providerCode: string,
  mode: ResourceMode,
  currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
): Promise<{
  rate24h: string | null;
  exhaustAt: string | null;
  unit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
  confidence: string;
  reason: string | null;
  dataPoints: number;
} | null> {
  const result = await sql<{
    resource_id: string;
    rate_24h: string | null;
    forecast_exhaust_at: Date | null;
    remaining_quota: string;
    snapshot_at: Date;
    consumption_unit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
    confidence: string;
    not_calculable_reason: string | null;
    data_points: number;
  }>`
    WITH latest_forecast AS (
      SELECT DISTINCT ON (provider_resource_id) *
        FROM supply_forecast
       WHERE enterprise_id = ${enterpriseId}
       ORDER BY provider_resource_id, snapshot_at DESC
    )
    SELECT f.provider_resource_id AS resource_id, f.rate_24h,
           f.forecast_exhaust_at, f.remaining_quota, f.snapshot_at,
           f.consumption_unit, f.confidence, f.not_calculable_reason, f.data_points
      FROM latest_forecast f
      JOIN provider_resource pr ON pr.id = f.provider_resource_id
      JOIN provider p ON p.id = pr.provider_id
     WHERE p.code = ${providerCode}
       AND pr.enterprise_id = ${enterpriseId}
       AND p.enterprise_id = ${enterpriseId}
       AND pr.mode = ${mode} AND pr.status <> 'DELETED'
  `.execute(db);
  const current = new Map(
    currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
  );
  const row = result.rows
    .filter((forecast) => {
      const snapshot = current.get(forecast.resource_id);
      const remaining = mode === "API"
        ? snapshot?.current_balance ?? null
        : snapshot?.remaining_quota ?? null;
      return snapshot !== undefined &&
        forecast.snapshot_at >= snapshot.calculated_at &&
        (forecast.forecast_exhaust_at === null
          || forecast.forecast_exhaust_at >= forecast.snapshot_at
          || decimalTextsEqual(remaining, "0")) &&
        decimalTextsEqual(forecast.remaining_quota, remaining);
    })
    .sort((left, right) => {
      if (!left.forecast_exhaust_at) return 1;
      if (!right.forecast_exhaust_at) return -1;
      return left.forecast_exhaust_at.getTime() - right.forecast_exhaust_at.getTime();
    })[0];
  if (!row) return null;
  return {
    rate24h: row.rate_24h,
    exhaustAt: row.forecast_exhaust_at ? row.forecast_exhaust_at.toISOString() : null,
    unit: row.consumption_unit,
    confidence: row.confidence,
    reason: row.not_calculable_reason,
    dataPoints: row.data_points,
  };
}
