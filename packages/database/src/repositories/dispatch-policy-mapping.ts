import type { DispatchPolicy } from "@qianliu/domain";
import type { DispatchPolicyRecord } from "./dispatch-policy-repository.js";

export function sameDecimal(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  };
  return units(left) === units(right);
}

export function mapPolicy(row: {
  id: string; status: string; match_unified_model: string | null;
  match_resource_mode: string | null; match_provider_resource_id: string | null;
  match_timezone: string | null; match_days_of_week: number[] | null;
  match_start_time: string | null; match_end_time: string | null;
  match_price_multiplier_min: string | null; match_remaining_quota_ratio_max: string | null;
  match_forecast_exhaust_risk: boolean | null; match_principal_scope: string[] | null;
  action: string; switch_equivalent_group: string[] | null; rate_limit_per_minute: number | null;
  policy_version: string; priority: number; description: string | null; source: string | null;
  copied_from_policy_id: string | null; created_by_admin_id: string | null;
  validated_at: Date | null; validated_by_admin_id: string | null;
  published_at: Date | null; published_by_admin_id: string | null; effective_at: Date | null;
  retired_at: Date | null; retired_by_admin_id: string | null; created_at: Date; updated_at: Date;
}): DispatchPolicyRecord {
  return {
    id: row.id,
    status: row.status as DispatchPolicy["status"],
    matchUnifiedModel: row.match_unified_model,
    matchResourceMode: row.match_resource_mode as DispatchPolicy["matchResourceMode"],
    matchProviderResourceId: row.match_provider_resource_id,
    matchTimezone: row.match_timezone,
    matchDaysOfWeek: row.match_days_of_week,
    matchStartTime: row.match_start_time,
    matchEndTime: row.match_end_time,
    matchPriceMultiplierMin: row.match_price_multiplier_min,
    matchRemainingQuotaRatioMax: row.match_remaining_quota_ratio_max,
    matchForecastExhaustRisk: row.match_forecast_exhaust_risk,
    matchPrincipalScope: row.match_principal_scope,
    action: row.action as DispatchPolicy["action"],
    switchEquivalentGroup: row.switch_equivalent_group ?? [],
    rateLimitPerMinute: row.rate_limit_per_minute,
    policyVersion: row.policy_version,
    priority: row.priority,
    description: row.description,
    source: row.source,
    copiedFromPolicyId: row.copied_from_policy_id,
    createdByAdminId: row.created_by_admin_id,
    validatedAt: row.validated_at,
    validatedByAdminId: row.validated_by_admin_id,
    publishedAt: row.published_at,
    publishedByAdminId: row.published_by_admin_id,
    effectiveAt: row.effective_at,
    retiredAt: row.retired_at,
    retiredByAdminId: row.retired_by_admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
