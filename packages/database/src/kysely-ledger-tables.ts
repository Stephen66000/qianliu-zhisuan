import type { Generated } from "kysely";

export interface UnifiedModelTable {
  id: Generated<string>; enterprise_id: string; alias: string; display_name: string;
  required_capabilities: string[] | null; status: Generated<string>; version: Generated<number>;
  archived_at: Generated<Date | null>; archived_by_admin_id: string | null;
  created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface ModelRouteTable {
  id: Generated<string>; enterprise_id: string; unified_model_id: string; provider_resource_id: string;
  upstream_model: string; priority: Generated<number>; weight: Generated<number>; enabled: Generated<boolean>;
  fallback_policy: string | null; version: Generated<number>; archived_at: Generated<Date | null>;
  archived_by_admin_id: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface AiRequestTable {
  id: string; enterprise_id: string; principal_id: string; principal_key_id: string;
  idempotency_key: string | null; client_request_id: string | null; request_fingerprint: string | null;
  protocol: string; unified_model: string; unified_model_id: Generated<string | null>; stream: Generated<boolean>;
  status: Generated<string>; client_id: string | null; agent_family: Generated<string>; agent_version: string | null;
  agent_identity_source: Generated<string>; agent_identity_confidence: Generated<string>;
  client_identity_rule_version: Generated<string>; started_at: Generated<Date>; finished_at: Date | null;
  error_classification: string | null; error_code: string | null;
}
export interface RouteCandidateTable {
  id: Generated<string>; ai_request_id: string; enterprise_id: string; provider_resource_id: string;
  upstream_model: string; priority: number; weight: number; selected: Generated<boolean>;
  score_factors: Record<string, unknown> | null; total_score: string | null; reason_code: string | null;
  created_at: Generated<Date>;
}
export interface UpstreamAttemptTable {
  id: Generated<string>; ai_request_id: string; enterprise_id: string; attempt_no: number;
  provider_resource_id: string; upstream_model: string; started_at: Generated<Date>; first_byte_at: Date | null;
  finished_at: Date | null; http_status: number | null; error_classification: string | null; error_code: string | null;
  response_committed: Generated<boolean>; failure_layer: string | null; switch_reason: string | null;
  upstream_error_evidence: Generated<Record<string, unknown> | null>;
  request_shape_summary: Generated<Record<string, unknown> | null>;
}
export interface UsageEventTable {
  id: Generated<string>; ai_request_id: string; enterprise_id: string; upstream_attempt_id: string;
  provider_resource_id: string; input_tokens: Generated<bigint>; output_tokens: Generated<bigint>;
  cache_tokens: Generated<bigint>; reasoning_tokens: Generated<bigint>; usage_quality: string;
  upstream_usage_id: string | null; dedup_key: string; created_at: Generated<Date>;
}
export interface LedgerLineTable {
  id: Generated<string>; ai_request_id: string; enterprise_id: string; usage_event_id: string;
  upstream_attempt_id: string; provider_resource_id: string; principal_id: string; resource_mode: string;
  raw_input_tokens: bigint; raw_output_tokens: bigint; raw_cache_tokens: bigint;
  raw_reasoning_tokens: Generated<bigint>; deducted_quota: bigint | null; api_cost: string | null;
  api_cost_currency: Generated<"CNY" | "USD" | null>;
  api_cost_status: Generated<"PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_APPLICABLE" | null>;
  legacy_cost_resolution_id: Generated<string | null>; subscription_period_id: Generated<string | null>;
  settled_at: Generated<Date | null>; usage_quality: string; billing_rule_id: string | null;
  rule_version: string | null; multiplier: string | null; billing_rule_snapshot: Record<string, unknown> | null;
  created_at: Generated<Date>;
}
export interface BillingRuleWindow { timezone: string; days_of_week: number[] | null; start_time: string; end_time: string }
export interface BillingRuleTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string | null; upstream_model: string | null;
  rule_type: string; rule_version: string; effective_from: Date; effective_to: Date | null;
  timezone: string | null; days_of_week: number[] | null; start_time: string | null; end_time: string | null;
  time_windows: Generated<BillingRuleWindow[] | null>; multiplier: string | null; cache_hit_price: string | null;
  cache_miss_price: string | null; output_price: string | null; currency: Generated<string>;
  priority: Generated<number>; enabled: Generated<boolean>; source: string | null; version: Generated<number>;
  archived_at: Generated<Date | null>; archived_by_admin_id: string | null;
  created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface LedgerTransactionTable {
  id: Generated<string>; ai_request_id: string; enterprise_id: string; principal_id: string;
  total_input_tokens: Generated<bigint>; total_output_tokens: Generated<bigint>;
  total_cache_tokens: Generated<bigint>; total_reasoning_tokens: Generated<bigint>;
  total_deducted_quota: Generated<bigint>; total_api_cost: Generated<string>;
  overage: Generated<boolean | null>; usage_quality: string; attempt_count: Generated<number>;
  status: Generated<string>; created_at: Generated<Date>;
}
export interface PrincipalAgentExpectationTable {
  id: Generated<string>; enterprise_id: string; principal_id: string; agent_family: string; created_at: Generated<Date>;
}
