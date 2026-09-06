import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { billingPriceMultiplier, matchApplicableBillingRule } from "@qianliu/domain";
import { listEnabledBillingRulesAt } from "./billing-rule-applicability.js";
import { ProviderRepository } from "./provider-repository.js";
import { sameDecimal } from "./dispatch-policy-mapping.js";

function remainingQuotaRatio(total: number | null, remaining: number | null): number | null {
  return total !== null && remaining !== null && Number.isFinite(total) &&
    Number.isFinite(remaining) && total > 0
    ? remaining / total
    : null;
}

async function resourcePriceMultiplier(db: Kysely<Database>, enterpriseId: string, resourceId: string,
  upstreamModel: string | undefined, resource: { mode: string } | undefined, now: number) {
  const mode = resource?.mode;
  if (!upstreamModel || (mode !== "API" && mode !== "CODING_PLAN")) return null;
  return billingPriceMultiplier(matchApplicableBillingRule(await listEnabledBillingRulesAt(db, enterpriseId, new Date(now)),
    resourceId, upstreamModel, mode, now));
}

/**
 * POOL-010：经营调度只读厂商最新快照。
 * 若快照未知或预测早于当前经营快照，返回未知/无风险，禁止拿 Grant/Counter 代替。
 */
export async function resolveResourceOperatingInput(
  db: Kysely<Database>,
  enterpriseId: string,
  providerResourceId: string,
  now: number = Date.now(),
  upstreamModel?: string,
): Promise<{
  priceMultiplier: string | null;
  remainingQuotaRatio: number | null;
  forecastExhaustRisk: boolean;
}> {
  const result = await sql<{
    mode: string;
    forecast_exhaust_at: Date | null;
    forecast_remaining_quota: string | null;
    forecast_snapshot_at: Date | null;
  }>`
    WITH latest_forecast AS (
      SELECT forecast_exhaust_at, snapshot_at, remaining_quota
        FROM supply_forecast
       WHERE enterprise_id = ${enterpriseId}
         AND provider_resource_id = ${providerResourceId}
       ORDER BY snapshot_at DESC
       LIMIT 1
    )
    SELECT pr.mode, f.forecast_exhaust_at,
           f.remaining_quota AS forecast_remaining_quota,
           f.snapshot_at AS forecast_snapshot_at
      FROM provider_resource pr
      LEFT JOIN latest_forecast f ON TRUE
     WHERE pr.id = ${providerResourceId}
       AND pr.enterprise_id = ${enterpriseId}
  `.execute(db);
  const row = result.rows[0];
  const snapshot = (await new ProviderRepository(db)
    .listCurrentOperatingSnapshots(enterpriseId, new Date(now)))
    .find((item) => item.provider_resource_id === providerResourceId);
  const total = row?.mode !== "CODING_PLAN" ||
    snapshot?.total_quota === null || snapshot?.total_quota === undefined
    ? null
    : Number(snapshot.total_quota);
  const remaining = row?.mode !== "CODING_PLAN" ||
    snapshot?.remaining_quota === null || snapshot?.remaining_quota === undefined
    ? null
    : Number(snapshot.remaining_quota);
  return {
    priceMultiplier: await resourcePriceMultiplier(db, enterpriseId, providerResourceId, upstreamModel, row, now),
    remainingQuotaRatio: remainingQuotaRatio(total, remaining),
    forecastExhaustRisk:
      snapshot !== undefined &&
      row?.forecast_snapshot_at !== null &&
      row?.forecast_snapshot_at !== undefined &&
      row.forecast_snapshot_at >= snapshot.calculated_at &&
      sameDecimal(
        row.forecast_remaining_quota ?? null,
        row.mode === "API" ? snapshot.current_balance : snapshot.remaining_quota,
      ) &&
      row?.forecast_exhaust_at !== null &&
      row?.forecast_exhaust_at !== undefined &&
      row.forecast_exhaust_at.getTime() <= now + 24 * 60 * 60 * 1000,
  };
}
