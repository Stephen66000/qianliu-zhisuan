/**
 * Kysely 实例工厂与强类型 Database Schema 根。
 *
 * 随 W02-W04 迁移文件逐步扩充。金额字段统一用 string + numeric（decimal.js 处理）。
 */
import { Kysely, PostgresDialect, type Generated } from "kysely";
import { Pool } from "pg";

/** Kysely migrator 内部表行类型。 */
export interface KyselyMigrationTable {
  name: string;
}
export interface KyselyMigrationLockTable {
  id: number;
}

export interface EnterpriseTable {
  id: Generated<string>;
  name: string;
  status: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AdminUserTable {
  id: Generated<string>;
  enterprise_id: string;
  username: string;
  password_hash: string; // Argon2id
  status: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AdminSessionTable {
  id: Generated<string>;
  admin_user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface EmployeeLoginTable {
  principal_id: string;
  username: string;
  password_hash: string;
  must_change_password: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PrincipalTable {
  id: Generated<string>;
  enterprise_id: string;
  type: "EMPLOYEE" | "PROJECT";
  name: string;
  department_label: string | null;
  status: Generated<"ACTIVE" | "DISABLED">;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OperationLogTable {
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

export interface PrincipalKeyTable {
  id: Generated<string>;
  enterprise_id: string;
  principal_id: string;
  key_prefix: string;
  key_digest: string;
  allowed_model_ids: string[] | null;
  ip_allowlist: string[] | null;
  expires_at: Date | null;
  quota_limit: bigint | null;
  concurrency_limit: number | null;
  status: Generated<"ACTIVE" | "REVOKED">;
  created_at: Generated<Date>;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface PrincipalGrantTable {
  id: Generated<string>;
  enterprise_id: string;
  principal_id: string;
  provider: string;
  model_alias: string;
  quota_unit: Generated<string>;
  quota_value: bigint;
  allow_overage: Generated<boolean>;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  status: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface QuotaCounterTable {
  id: Generated<string>;
  grant_id: string;
  used_value: Generated<bigint>;
  overage_value: Generated<bigint>;
  period_anchor: Generated<Date>;
  next_reset_at: Date | null;
  reset_marker: string | null;
  updated_at: Generated<Date>;
}

export interface ProviderTable {
  id: Generated<string>;
  enterprise_id: string;
  code: string;
  name: string;
  adapter_type: string;
  supported_protocols: string[] | null;
  capability_set: Record<string, unknown> | null;
  status: Generated<string>;
  config_schema_version: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProviderResourceTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_id: string;
  name: string;
  mode: "API" | "CODING_PLAN";
  credential_type: "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION";
  credential_ciphertext: string | null; // JSON {ciphertext, nonce, tag}
  credential_fingerprint: string | null;
  credential_version: number | null;
  upstream_models: string[] | null;
  concurrency_limit: number | null;
  status: Generated<string>;
  api_fallback_enabled: Generated<boolean>;
  // ===== W11（迁移 0010）：资源池与凭证生命周期 =====
  resource_pool_id: string | null;
  credential_expires_at: Date | null;
  credential_refresh_status: Generated<string>; // OK | REFRESHING | FAILED
  last_refresh_at: Date | null;
  refresh_error_classification: string | null;
  consecutive_failures: Generated<number>;
  cooldown_until: Date | null;
  last_probe_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** W11：资源状态迁移审计（不可覆盖；每次迁移一行）。 */
export interface ResourceStatusEventTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  from_status: string | null;
  to_status: string;
  reason: string; // domain STATE_REASON
  error_classification: string | null;
  consecutive_failures: number | null;
  cooldown_until: Date | null;
  actor: Generated<string>; // system | admin
  created_at: Generated<Date>;
}

/** W14：资源并发租约（0012）。 */
export interface ConcurrencyLeaseTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  ai_request_id: string | null;
  acquired_at: Generated<Date>;
  expires_at: Date;
  released_at: Date | null;
}

/** W15：供给预测快照（0013）。 */
export interface SupplyForecastTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  rate_1h: string | null;
  rate_24h: string | null;
  rate_7d: string | null;
  forecast_exhaust_at: Date | null;
  next_recover_at: Date | null;
  coverage_hours: string | null;
  remaining_quota: string | null;
  confidence: string;
  data_points: Generated<number>;
  not_calculable_reason: string | null;
  algorithm_version: string;
  snapshot_at: Generated<Date>;
}

export interface UnifiedModelTable {
  id: Generated<string>;
  enterprise_id: string;
  alias: string;
  display_name: string;
  required_capabilities: string[] | null;
  status: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ModelRouteTable {
  id: Generated<string>;
  enterprise_id: string;
  unified_model_id: string;
  provider_resource_id: string;
  upstream_model: string;
  priority: Generated<number>;
  weight: Generated<number>;
  enabled: Generated<boolean>;
  fallback_policy: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ===== M2：Gateway 请求/Attempt/账本 =====

export interface AiRequestTable {
  id: string; // 由 Gateway 分配，非自增
  enterprise_id: string;
  principal_id: string;
  principal_key_id: string;
  idempotency_key: string | null;
  protocol: string;
  unified_model: string;
  stream: Generated<boolean>;
  status: Generated<string>;
  client_id: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
  error_classification: string | null;
  error_code: string | null;
}

export interface RouteCandidateTable {
  id: Generated<string>;
  ai_request_id: string;
  enterprise_id: string;
  provider_resource_id: string;
  upstream_model: string;
  priority: number;
  weight: number;
  selected: Generated<boolean>;
  score_factors: Record<string, unknown> | null;
  total_score: string | null;
  reason_code: string | null;
  created_at: Generated<Date>;
}

export interface UpstreamAttemptTable {
  id: Generated<string>;
  ai_request_id: string;
  enterprise_id: string;
  attempt_no: number;
  provider_resource_id: string;
  upstream_model: string;
  started_at: Generated<Date>;
  first_byte_at: Date | null;
  finished_at: Date | null;
  http_status: number | null;
  error_classification: string | null;
  error_code: string | null;
  response_committed: Generated<boolean>;
  switch_reason: string | null;
}

export interface UsageEventTable {
  id: Generated<string>;
  ai_request_id: string;
  enterprise_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  input_tokens: Generated<bigint>;
  output_tokens: Generated<bigint>;
  cache_tokens: Generated<bigint>;
  usage_quality: string;
  upstream_usage_id: string | null;
  dedup_key: string;
  created_at: Generated<Date>;
}

export interface LedgerLineTable {
  id: Generated<string>;
  ai_request_id: string;
  enterprise_id: string;
  usage_event_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  principal_id: string;
  resource_mode: string;
  raw_input_tokens: bigint;
  raw_output_tokens: bigint;
  raw_cache_tokens: bigint;
  deducted_quota: bigint | null;
  api_cost: string | null;
  usage_quality: string;
  // ===== W13（迁移 0011）：冻结命中的计价规则版本 =====
  billing_rule_id: string | null;
  rule_version: string | null;
  multiplier: string | null;
  created_at: Generated<Date>;
}

/** W13：计价规则版本（0011）。 */
export interface BillingRuleTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string | null;
  upstream_model: string | null;
  rule_type: string;
  rule_version: string;
  effective_from: Date;
  effective_to: Date | null;
  timezone: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  multiplier: string | null;
  cache_hit_price: string | null;
  cache_miss_price: string | null;
  output_price: string | null;
  currency: Generated<string>;
  priority: Generated<number>;
  enabled: Generated<boolean>;
  source: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerTransactionTable {
  id: Generated<string>;
  ai_request_id: string;
  enterprise_id: string;
  principal_id: string;
  total_input_tokens: Generated<bigint>;
  total_output_tokens: Generated<bigint>;
  total_cache_tokens: Generated<bigint>;
  total_deducted_quota: Generated<bigint>;
  total_api_cost: Generated<string>;
  usage_quality: string;
  attempt_count: Generated<number>;
  status: Generated<string>;
  created_at: Generated<Date>;
}

/**
 * Database Schema 根类型。W02 后含 enterprise/admin/principal/audit；
 * W03/W04 追加 principal_key/grant/provider 等表。
 */
export interface Database {
  kysely_migration: KyselyMigrationTable;
  kysely_migration_lock: KyselyMigrationLockTable;
  _w01_baseline_probe: { id: number; note: string | null; created_at: Date };
  enterprise: EnterpriseTable;
  admin_user: AdminUserTable;
  admin_session: AdminSessionTable;
  employee_login: EmployeeLoginTable;
  principal: PrincipalTable;
  principal_key: PrincipalKeyTable;
  principal_grant: PrincipalGrantTable;
  quota_counter: QuotaCounterTable;
  concurrency_lease: ConcurrencyLeaseTable;
  supply_forecast: SupplyForecastTable;
  provider: ProviderTable;
  provider_resource: ProviderResourceTable;
  resource_status_event: ResourceStatusEventTable;
  unified_model: UnifiedModelTable;
  model_route: ModelRouteTable;
  ai_request: AiRequestTable;
  route_candidate: RouteCandidateTable;
  upstream_attempt: UpstreamAttemptTable;
  usage_event: UsageEventTable;
  ledger_line: LedgerLineTable;
  billing_rule: BillingRuleTable;
  ledger_transaction: LedgerTransactionTable;
  operation_log: OperationLogTable;
}

/**
 * 从 DATABASE_URL 构造 Kysely 实例。
 */
export function createKysely(databaseUrl?: string): Kysely<Database> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (set in .env or process.env)");
  }
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url }),
    }),
  });
}
