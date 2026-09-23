import type { Generated } from "kysely";

export interface OperationLogTable {
  actor_source: Generated<"ADMIN" | "SYSTEM" | "UNKNOWN">;
  id: Generated<string>;
  enterprise_id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  change_summary: Record<string, unknown> | null;
  result: "SUCCESS" | "FAILURE";
  failure_reason: string | null;
  created_at: Generated<Date>;
}

export interface DeploymentLogTable {
  id: Generated<string>;
  enterprise_id: string;
  deployment_id: string;
  started_at: Date;
  finished_at: Date | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
  from_version: string | null;
  to_version: string | null;
  git_commit: string | null;
  artifact_sha256: string | null;
  migration_from: string | null;
  migration_to: string | null;
  release_id: string | null;
  actor: string;
  summary: string;
  pool_refs: string[];
  backup_ref: string | null;
  rollback_target: string | null;
  health_summary: Record<string, unknown> | null;
  smoke_summary: Record<string, unknown> | null;
  evidence_refs: string[];
  failure_classification: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeploymentLogEventTable {
  id: Generated<string>;
  enterprise_id: string;
  deployment_log_id: string;
  event_key: string;
  event_type: string;
  occurred_at: Date;
  actor: string;
  note: string | null;
  payload: Record<string, unknown> | null;
  created_at: Generated<Date>;
}

export interface OperatingBillPeriodTable {
  id: Generated<string>;
  enterprise_id: string;
  period_month: string;
  status: Generated<"DRAFT" | "CLOSED">;
  current_version: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OperatingBillValueItemTable {
  id: Generated<string>;
  enterprise_id: string;
  period_id: string;
  title: string;
  value_type: "MONETARY" | "NON_MONETARY";
  amount: string | null;
  metric_value: string | null;
  metric_unit: string | null;
  description: string | null;
  evidence_ref: string | null;
  related_principal_id: string | null;
  status: Generated<"PENDING" | "CONFIRMED">;
  submitted_by: string;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OperatingBillVersionTable {
  id: Generated<string>;
  enterprise_id: string;
  period_id: string;
  version: number;
  snapshot: Record<string, unknown>;
  close_note: string | null;
  exceptions: Generated<Array<Record<string, unknown>>>;
  closed_by: string;
  closed_at: Generated<Date>;
}

export interface OperatingBillEventTable {
  id: Generated<string>;
  enterprise_id: string;
  period_id: string;
  action: "CREATED" | "VALUE_CREATED" | "VALUE_CONFIRMED" | "CLOSED" | "REOPENED";
  version: number | null;
  reason: string | null;
  actor_admin_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Generated<Date>;
}

export interface OperatingBillRequestProjectAssignmentTable {
  id: Generated<string>;
  enterprise_id: string;
  ai_request_id: string;
  project_principal_id: string;
  assigned_by: string;
  reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OperatingBillOpeningBalanceTable {
  id: Generated<string>;
  enterprise_id: string;
  period_id: string;
  provider_resource_id: string;
  version: number;
  amount: string;
  currency: string;
  source: "MANUAL";
  reason: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface ProviderModelDiscoveryTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  source: "PROVIDER_API" | "OFFICIAL_DOCUMENTATION" | "LAST_SUCCESSFUL_SNAPSHOT" | "BUILTIN_FALLBACK" | "VERSIONED_CATALOG";
  source_version: string;
  parser_version: string | null;
  source_url: string | null;
  source_etag: string | null;
  source_last_modified: string | null;
  source_content_hash: string | null;
  source_checked_at: Date | null;
  stale: Generated<boolean>;
  status: "SUCCEEDED" | "FAILED";
  discovered_at: Date;
  failure_code: string | null;
  created_at: Generated<Date>;
}

export interface ProviderModelDiscoveryItemTable {
  id: Generated<string>;
  enterprise_id: string;
  discovery_id: string;
  provider_resource_id: string;
  upstream_model: string;
  display_name: string;
  model_type: "CHAT" | "EMBEDDING" | "IMAGE" | "UNKNOWN";
  capabilities: string[];
  source: "PROVIDER_API" | "OFFICIAL_DOCUMENTATION" | "LAST_SUCCESSFUL_SNAPSHOT" | "BUILTIN_FALLBACK" | "VERSIONED_CATALOG";
  compatible: boolean;
  unavailable_reason: string | null;
  facts: Record<string, unknown>;
  availability_status: "AVAILABLE" | "REMOVED";
  first_discovered_at: Date;
  last_discovered_at: Date;
  last_validated_at: Date | null;
  created_at: Generated<Date>;
}

export interface ProviderModelOnboardingTable {
  id: Generated<string>;
  enterprise_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  provider_resource_id: string;
  result: Record<string, unknown>;
  created_at: Generated<Date>;
}

/**
 * WP04：探针 run 的 endpoint_scope 取值域。前四值为端点策略 EndpointScope；
 * 端点解析歧义时 run 以 "ENDPOINT_SCOPE_AMBIGUOUS" 落库（host 为 "unresolved"
 * 或歧义 host）。F-P2-2：类型如实扩列，消除仓储层 as 收窄强转。
 */
export type ProbeRunEndpointScope =
  | "MODE_SCOPED_CONFIG" | "ENV" | "LEGACY_BASE_URL" | "MODE_DEFAULT"
  | "ENDPOINT_SCOPE_AMBIGUOUS";

/** WP04：权限探针运行（脱敏；不含 Key/Authorization/Prompt/正文）。 */
export interface ProviderModelProbeRunTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_id: string | null;
  provider_resource_id: string | null;
  provider_code: string;
  resource_mode: "API" | "CODING_PLAN";
  credential_fingerprint: string;
  endpoint_scope: ProbeRunEndpointScope;
  endpoint_host: string;
  discovery_source: string | null;
  discovery_source_hash: string | null;
  parser_version: string | null;
  status: "COMPLETED" | "FAILED";
  idempotency_key: string;
  request_hash: string;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

/** WP04：权限探针明细（模型级状态/HTTP/统一错误码/可重试性）。 */
export interface ProviderModelProbeItemTable {
  id: Generated<string>;
  probe_run_id: string;
  upstream_model: string;
  validation_status: "NOT_RUN" | "READY" | "AUTH_FAILED" | "PLAN_NOT_ENTITLED"
    | "REQUEST_REJECTED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "NETWORK_FAILED";
  http_status: number | null;
  error_code: string | null;
  error_category: string | null;
  retryable: boolean;
  diagnostic_hash: string | null;
  checked_at: Date | null;
}

export interface ProviderModelValidationTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  unified_model_id: string;
  upstream_model: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
  started_at: Generated<Date>;
  finished_at: Date | null;
  created_at: Generated<Date>;
}

export interface ProviderResourceOperatingSnapshotTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  subscription_period_id: Generated<string | null>;
  version: number;
  source: "ADMIN" | "PROVIDER_SYNC" | "BILL_RECONCILIATION";
  collected_at: Date;
  currency: string | null;
  recharge_amount: string | null;
  current_balance: string | null;
  granted_balance: Generated<string | null>;
  topped_up_balance: Generated<string | null>;
  provider_balance_available: Generated<boolean | null>;
  balance_source: Generated<"ADMIN" | "PROVIDER_API" | "BILL_RECONCILIATION" | null>;
  cost_source: Generated<"ADMIN" | "LOCAL_LEDGER" | "BILL_RECONCILIATION" | "NOT_SUPPORTED" | null>;
  cumulative_cost: string | null;
  current_period_cost: string | null;
  cost_period_start: Date | null;
  cost_period_end: Date | null;
  balance_updated_at: Date | null;
  package_name: string | null;
  package_cost: string | null;
  total_quota: string | null;
  quota_unit: string | null;
  used_quota: string | null;
  remaining_quota: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  reset_cycle: string | null;
  reset_anchor_at: Date | null;
  reset_timezone: string | null;
  usage_calculation: Generated<"MANUAL_SNAPSHOT" | "SYSTEM_LEDGER">;
  next_reset_at: Date | null;
  created_at: Generated<Date>;
}
