import type { Generated } from "kysely";

export interface ProviderTable {
  id: Generated<string>; enterprise_id: string; code: string; name: string; adapter_type: string;
  supported_protocols: string[] | null; capability_set: Record<string, unknown> | null;
  status: Generated<string>; config_schema_version: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface ProviderResourceTable {
  id: Generated<string>; enterprise_id: string; provider_id: string; name: string; mode: "API" | "CODING_PLAN";
  credential_type: "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION"; credential_ciphertext: string | null;
  credential_fingerprint: string | null; credential_version: number | null; upstream_models: string[] | null;
  concurrency_limit: number | null; status: Generated<string>; api_fallback_enabled: Generated<boolean>;
  resource_pool_id: string | null; credential_expires_at: Date | null; credential_refresh_status: Generated<string>;
  last_refresh_at: Date | null; refresh_error_classification: string | null; consecutive_failures: Generated<number>;
  cooldown_until: Date | null; last_probe_at: Date | null; version: Generated<number>;
  monthly_budget_amount: Generated<string | null>; monthly_budget_currency: Generated<string | null>;
  created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface ProviderResourceMonthlyBudgetTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string; month: string | Date;
  version: number; status: "ACTIVE" | "CLEARED"; amount: string | null; currency: string | null;
  is_current: Generated<boolean>; created_by: string; created_at: Generated<Date>; idempotency_key: string;
  request_hash: string; response_snapshot: Record<string, unknown>;
}
export interface ResourceStatusEventTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string; from_status: string | null;
  to_status: string; reason: string; error_classification: string | null; consecutive_failures: number | null;
  cooldown_until: Date | null; actor: Generated<string>; created_at: Generated<Date>;
}
export interface ConcurrencyLeaseTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string; ai_request_id: string | null;
  acquired_at: Generated<Date>; expires_at: Date; released_at: Date | null;
}
export interface SupplyForecastTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string; rate_1h: string | null;
  rate_24h: string | null; rate_7d: string | null; forecast_exhaust_at: Date | null;
  next_recover_at: Date | null; coverage_hours: string | null; remaining_quota: string | null;
  confidence: string; data_points: Generated<number>; not_calculable_reason: string | null;
  algorithm_version: string; consumption_unit: Generated<string | null>; forecast_key: Generated<string | null>;
  snapshot_at: Generated<Date>;
}
export interface DispatchPolicyTable {
  id: Generated<string>; enterprise_id: string; status: Generated<string>; match_unified_model: string | null;
  match_resource_mode: string | null; match_provider_resource_id: string | null; match_timezone: string | null;
  match_days_of_week: number[] | null; match_start_time: string | null; match_end_time: string | null;
  match_price_multiplier_min: string | null; match_remaining_quota_ratio_max: string | null;
  match_forecast_exhaust_risk: boolean | null; match_principal_scope: string[] | null; action: string;
  switch_equivalent_group: string[] | null; rate_limit_per_minute: number | null; policy_version: string;
  priority: Generated<number>; description: string | null; source: string | null; copied_from_policy_id: string | null;
  restore_source_policy_id: Generated<string | null>; created_by_admin_id: string | null; validated_at: Date | null;
  validated_by_admin_id: string | null; published_at: Date | null; published_by_admin_id: string | null;
  effective_at: Date | null; retired_at: Date | null; retired_by_admin_id: string | null;
  created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface DispatchDecisionTable {
  id: Generated<string>; enterprise_id: string; ai_request_id: string; dispatch_input: Record<string, unknown> | null;
  matched_policy_id: string | null; matched_policy_version: string | null; matched_policy_action: string | null;
  final_action: string; reason_code: string; reason_detail: string | null; switch_target_resource_id: string | null;
  counterfactual_cost: string | null; actual_cost: string | null; dispatch_saving: string | null;
  saving_calculable: Generated<boolean>; not_calculable_reason: string | null; decided_at: Generated<Date>;
}
export interface ReconciliationRunTable {
  id: Generated<string>; enterprise_id: string; range_from: Date; range_to: Date;
  requests_scanned: Generated<number>; usage_events_scanned: Generated<number>; ledger_lines_scanned: Generated<number>;
  transactions_scanned: Generated<number>; duplicate_count: Generated<number>; missing_count: Generated<number>;
  mismatch_count: Generated<number>; total_discrepancies: Generated<number>; result: string;
  duplicate_rate: string | null; missing_rate: string | null; summary: Record<string, unknown> | null;
  algorithm_version: string; started_at: Generated<Date>; finished_at: Date | null;
}
export interface ReconciliationDiscrepancyTable {
  id: Generated<string>; enterprise_id: string; reconciliation_run_id: string; discrepancy_type: string;
  ai_request_id: string | null; usage_event_id: string | null; ledger_line_id: string | null;
  ledger_transaction_id: string | null; detail: Record<string, unknown> | null; severity: Generated<string>;
  status: Generated<string>; resolution_note: string | null; created_at: Generated<Date>; resolved_at: Date | null;
}
export interface AlertEventTable {
  id: Generated<string>; enterprise_id: string; alert_key: string; domain: string; signal: string;
  severity: Generated<string>; title: string; detail: string | null; resource_id: string | null;
  principal_id: string | null; ai_request_id: string | null; status: Generated<string>;
  first_seen_at: Generated<Date>; last_seen_at: Generated<Date>; resolved_at: Date | null;
  source_cleared_at: Date | null; resolution_note: string | null; resolved_by: string | null;
  availability_event_id: string | null;
}
