/**
 * Kysely 实例工厂与强类型 Database Schema 根。
 *
 * 随 W02-W04 迁移文件逐步扩充。金额字段统一用 string + numeric（decimal.js 处理）。
 */
import { Kysely, PostgresDialect, type Generated } from "kysely";
import { Pool } from "pg";
import type {
  DeploymentLogEventTable,
  DeploymentLogTable,
  OperatingBillEventTable,
  OperatingBillPeriodTable,
  OperatingBillRequestProjectAssignmentTable,
  OperatingBillValueItemTable,
  OperatingBillVersionTable,
  OperationLogTable,
  ProviderModelDiscoveryItemTable,
  ProviderModelDiscoveryTable,
  ProviderModelOnboardingTable,
  ProviderResourceOperatingSnapshotTable,
} from "./kysely-operations-tables.js";
import type { EmployeeModelRuleAssignmentTable, EmployeeModelRuleVersionTable, PrincipalModelManualAuthorizationTable } from "./employee-model-rule-types.js";
import type {
  AvailabilityEventTable,
  AvailabilityRuleTable,
  AvailabilityRuleVersionTable,
  NotificationDeliveryTable,
  NotificationEndpointTable,
} from "./kysely-availability-tables.js";
import type {
  DirectoryImportItemTable,
  DirectoryImportRunTable,
  DirectoryPersonExternalIdentityTable,
  DirectoryPersonTable,
  DirectorySourceTable,
  OrganizationMembershipTable,
  OrganizationUnitTable,
} from "./kysely-directory-tables.js";
import type { ProviderQuotaWindowTable } from "./provider-quota-window-types.js";
import type { OperatingBillResourceConfirmationTable, ProjectDepartmentAssignmentTable, ProviderResourceOperatingSyncAttemptTable, RequestAttributionSnapshotTable, UsageAggregateBucketStateTable, UsageAggregateDirtyBucketTable, UsageBucketAggregateTable } from "./kysely-w20-tables.js";

export type * from "./kysely-operations-tables.js"; export type * from "./employee-model-rule-types.js";
export type * from "./kysely-availability-tables.js";
export type * from "./kysely-directory-tables.js";
export type * from "./provider-quota-window-types.js";
export type * from "./kysely-w20-tables.js";

export interface KyselyMigrationTable { name: string }
export interface KyselyMigrationLockTable { id: number }

export interface EnterpriseTable {
  id: Generated<string>;
  name: string;
  status: Generated<string>;
  timezone: Generated<string>;
  default_currency: Generated<string>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AdminUserTable {
  id: Generated<string>;
  enterprise_id: string;
  username: string;
  display_name: Generated<string>;
  password_hash: string; // Argon2id
  must_change_password: Generated<boolean>;
  status: Generated<string>;
  version: Generated<number>;
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
  archived_at: Generated<Date | null>;
  /** RA-W01：人主体关联人员；RA-W02 完成映射后启用业务强校验。 */
  person_id: string | null;
  /** RA-W01：项目主体负责人。 */
  owner_person_id: string | null;
  /** RA-W01：主体关系写操作的单调乐观锁。 */
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  /** POOL-029：null 表示既有手工 Grant；非 null 表示由员工使用规则管理。 */
  authorization_rule_version_id: string | null;
  /** POOL-033：'*' 表示主体×厂商额度池（model_alias 同步为 '*'）；null 表示旧型号级手工 Grant（过渡/识别用）。 */
  pool_model_alias: string | null;
  /** W19/P2-01：单调版本号（乐观锁，替代 updated_at 毫秒截断）。 */
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** POOL-033：接入配置编排端点幂等存档。 */
export interface PrincipalAccessIdempotencyTable {
  enterprise_id: string;
  principal_id: string;
  idempotency_key: string;
  request_hash: string;
  response_snapshot: Record<string, unknown>;
  created_at: Generated<Date>;
}

/** POOL-033：单主体配置乐观锁版本。 */
export interface PrincipalAccessConfigStateTable {
  enterprise_id: string;
  principal_id: string;
  config_version: Generated<number>;
  updated_at: Generated<Date>;
}

/** POOL-033：主体×厂商的显式禁用型号清单（决策点④：新型号默认并入，掐型号走显式记录）。 */
export interface PrincipalProviderDisabledModelTable {
  enterprise_id: string;
  principal_id: string;
  provider: string;
  unified_model_id: string;
  disabled_at: Generated<Date>;
  /** 掐掉该型号的规则版本（追溯用）。 */
  disable_rule_version_id: string | null;
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
  /** W19/P2-01：单调版本号（乐观锁）。 */
  version: Generated<number>;
  /** 2.0：API 资源月预算分母；只用于经营利用率，不进入 Gateway。 */
  monthly_budget_amount: Generated<string | null>;
  monthly_budget_currency: Generated<string | null>;
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
  consumption_unit: Generated<string | null>;
  forecast_key: Generated<string | null>;
  snapshot_at: Generated<Date>;
}

/** W16：经营调度策略（0014）。 */
export interface DispatchPolicyTable {
  id: Generated<string>;
  enterprise_id: string;
  status: Generated<string>; // DRAFT/VALIDATED/PUBLISHED/RETIRED
  match_unified_model: string | null;
  match_resource_mode: string | null; // API|CODING_PLAN
  match_provider_resource_id: string | null;
  match_timezone: string | null;
  match_days_of_week: number[] | null;
  match_start_time: string | null;
  match_end_time: string | null;
  match_price_multiplier_min: string | null;
  match_remaining_quota_ratio_max: string | null;
  match_forecast_exhaust_risk: boolean | null;
  match_principal_scope: string[] | null;
  action: string; // ALLOW/SWITCH/RATE_LIMIT/REJECT/ALLOW_OVERAGE
  switch_equivalent_group: string[] | null;
  rate_limit_per_minute: number | null;
  policy_version: string;
  priority: Generated<number>;
  description: string | null;
  source: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** W16：请求前经营决策快照（0014，不可覆盖）。 */
export interface DispatchDecisionTable {
  id: Generated<string>;
  enterprise_id: string;
  ai_request_id: string;
  dispatch_input: Record<string, unknown> | null;
  matched_policy_id: string | null;
  matched_policy_version: string | null;
  matched_policy_action: string | null;
  final_action: string;
  reason_code: string;
  reason_detail: string | null;
  switch_target_resource_id: string | null;
  counterfactual_cost: string | null;
  actual_cost: string | null;
  dispatch_saving: string | null;
  saving_calculable: Generated<boolean>;
  not_calculable_reason: string | null;
  decided_at: Generated<Date>;
}

/** W17：对账运行汇总（0015）。 */
export interface ReconciliationRunTable {
  id: Generated<string>;
  enterprise_id: string;
  range_from: Date;
  range_to: Date;
  requests_scanned: Generated<number>;
  usage_events_scanned: Generated<number>;
  ledger_lines_scanned: Generated<number>;
  transactions_scanned: Generated<number>;
  duplicate_count: Generated<number>;
  missing_count: Generated<number>;
  mismatch_count: Generated<number>;
  total_discrepancies: Generated<number>;
  result: string; // PASS/FAIL/REVIEW
  duplicate_rate: string | null;
  missing_rate: string | null;
  summary: Record<string, unknown> | null;
  algorithm_version: string;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

/** W17：对账差异明细 / 异常队列（0015）。 */
export interface ReconciliationDiscrepancyTable {
  id: Generated<string>;
  enterprise_id: string;
  reconciliation_run_id: string;
  discrepancy_type: string; // DUPLICATE_USAGE/MISSING_LEDGER_LINE/MISSING_USAGE/ORPHAN_LEDGER_LINE/SETTLEMENT_MISMATCH
  ai_request_id: string | null;
  usage_event_id: string | null;
  ledger_line_id: string | null;
  ledger_transaction_id: string | null;
  detail: Record<string, unknown> | null;
  severity: Generated<string>; // HIGH/MEDIUM/LOW
  status: Generated<string>; // OPEN/INVESTIGATING/RESOLVED/IGNORED
  resolution_note: string | null;
  created_at: Generated<Date>;
  resolved_at: Date | null;
}

/** W20/P1-05：告警事实表（0017）—— 独立于 reconciliation_discrepancy，保存触发/恢复/处置历史。 */
export interface AlertEventTable {
  id: Generated<string>;
  enterprise_id: string;
  /** 稳定派生键（domain:signal:entity），活跃告警幂等挂载点。 */
  alert_key: string;
  domain: string; // RESOURCE_UNAVAILABLE/USAGE_SPIKE/QUOTA_ANOMALY/CREDENTIAL_INVALID
  signal: string; // 八类技术信号（TRD §13）
  severity: Generated<string>; // HIGH/MEDIUM/LOW
  title: string;
  detail: string | null;
  resource_id: string | null;
  principal_id: string | null;
  ai_request_id: string | null;
  status: Generated<string>; // OPEN/INVESTIGATING/RESOLVED/IGNORED/AUTO_RESOLVED
  first_seen_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  resolved_at: Date | null;
  /** 源事实最近一次恢复时间；用于区分持续异常与恢复后的再次触发。 */
  source_cleared_at: Date | null;
  resolution_note: string | null;
  resolved_by: string | null;
  /** RA-W01：可选关联正式熔断事件；异常事实不复制熔断事实。 */
  availability_event_id: string | null;
}

export interface UnifiedModelTable {
  id: Generated<string>;
  enterprise_id: string;
  alias: string;
  display_name: string;
  required_capabilities: string[] | null;
  status: Generated<string>;
  /** W19/P2-01：单调版本号（乐观锁）。 */
  version: Generated<number>;
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
  /** W19/P2-01：单调版本号（乐观锁）。 */
  version: Generated<number>;
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
  /** 客户端 x-request-id，仅作追踪，允许跨工具回合复用。 */
  client_request_id: string | null;
  /** 业务幂等请求的规范化请求体 SHA-256；绝不保存请求正文。 */
  request_fingerprint: string | null;
  protocol: string;
  /** POOL-043：统计稳定身份；unified_model 仍保留请求发生时 alias。 */
  unified_model: string; unified_model_id: Generated<string | null>;
  stream: Generated<boolean>;
  status: Generated<string>;
  client_id: string | null;
  agent_family: Generated<string>;
  agent_version: string | null;
  agent_identity_source: Generated<string>;
  agent_identity_confidence: Generated<string>;
  client_identity_rule_version: Generated<string>;
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
  failure_layer: string | null;
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
  reasoning_tokens: Generated<bigint>;
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
  raw_reasoning_tokens: Generated<bigint>;
  deducted_quota: bigint | null;
  api_cost: string | null;
  usage_quality: string;
  // ===== W13（迁移 0011）：冻结命中的计价规则版本 =====
  billing_rule_id: string | null;
  rule_version: string | null;
  multiplier: string | null;
  /** POOL-001：命中时段、价格或倍率的不可变结算快照。 */
  billing_rule_snapshot: Record<string, unknown> | null;
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
  /** POOL-001：同一规则的有序时间窗；第一窗同时镜像到旧单窗列。 */
  time_windows: Generated<BillingRuleWindow[] | null>;
  multiplier: string | null;
  cache_hit_price: string | null;
  cache_miss_price: string | null;
  output_price: string | null;
  currency: Generated<string>;
  priority: Generated<number>;
  enabled: Generated<boolean>;
  source: string | null;
  /** P1-02：管理端编辑使用单调版本号，避免并发覆盖。 */
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BillingRuleWindow {
  timezone: string;
  days_of_week: number[] | null;
  start_time: string;
  end_time: string;
}

export interface LedgerTransactionTable {
  id: Generated<string>;
  ai_request_id: string;
  enterprise_id: string;
  principal_id: string;
  total_input_tokens: Generated<bigint>;
  total_output_tokens: Generated<bigint>;
  total_cache_tokens: Generated<bigint>;
  total_reasoning_tokens: Generated<bigint>;
  total_deducted_quota: Generated<bigint>;
  total_api_cost: Generated<string>;
  /** POOL-012：请求结算时冻结的超额事实；null=迁移前历史未知，禁止按当前 Grant 重算。 */
  overage: Generated<boolean | null>;
  usage_quality: string;
  attempt_count: Generated<number>;
  status: Generated<string>;
  created_at: Generated<Date>;
}

export interface PrincipalAgentExpectationTable {
  id: Generated<string>;
  enterprise_id: string;
  principal_id: string;
  agent_family: string;
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
  principal_agent_expectation: PrincipalAgentExpectationTable;
  person: DirectoryPersonTable;
  person_external_identity: DirectoryPersonExternalIdentityTable;
  directory_source: DirectorySourceTable;
  organization_unit: OrganizationUnitTable;
  organization_membership: OrganizationMembershipTable;
  directory_import_run: DirectoryImportRunTable;
  directory_import_item: DirectoryImportItemTable;
  principal_key: PrincipalKeyTable;
  principal_grant: PrincipalGrantTable;
  principal_access_idempotency: PrincipalAccessIdempotencyTable;
  principal_access_config_state: PrincipalAccessConfigStateTable;
  principal_provider_disabled_model: PrincipalProviderDisabledModelTable;
  employee_model_rule_version: EmployeeModelRuleVersionTable; employee_model_rule_assignment: EmployeeModelRuleAssignmentTable; principal_model_manual_authorization: PrincipalModelManualAuthorizationTable;
  quota_counter: QuotaCounterTable;
  concurrency_lease: ConcurrencyLeaseTable;
  supply_forecast: SupplyForecastTable;
  dispatch_policy: DispatchPolicyTable;
  dispatch_decision: DispatchDecisionTable;
  reconciliation_run: ReconciliationRunTable;
  reconciliation_discrepancy: ReconciliationDiscrepancyTable;
  alert_event: AlertEventTable;
  availability_rule: AvailabilityRuleTable;
  availability_rule_version: AvailabilityRuleVersionTable;
  availability_event: AvailabilityEventTable;
  notification_endpoint: NotificationEndpointTable;
  notification_delivery: NotificationDeliveryTable;
  provider: ProviderTable;
  provider_resource: ProviderResourceTable;
  provider_resource_operating_snapshot: ProviderResourceOperatingSnapshotTable;
  provider_resource_operating_sync_attempt: ProviderResourceOperatingSyncAttemptTable;
  provider_quota_window: ProviderQuotaWindowTable;
  provider_model_discovery: ProviderModelDiscoveryTable;
  provider_model_discovery_item: ProviderModelDiscoveryItemTable;
  provider_model_onboarding: ProviderModelOnboardingTable;
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
  usage_bucket_aggregate: UsageBucketAggregateTable;
  usage_aggregate_dirty_bucket: UsageAggregateDirtyBucketTable;
  usage_aggregate_bucket_state: UsageAggregateBucketStateTable;
  project_department_assignment: ProjectDepartmentAssignmentTable;
  request_attribution_snapshot: RequestAttributionSnapshotTable;
  operation_log: OperationLogTable;
  deployment_log: DeploymentLogTable;
  deployment_log_event: DeploymentLogEventTable;
  operating_bill_period: OperatingBillPeriodTable;
  operating_bill_value_item: OperatingBillValueItemTable;
  operating_bill_version: OperatingBillVersionTable;
  operating_bill_event: OperatingBillEventTable;
  operating_bill_request_project_assignment: OperatingBillRequestProjectAssignmentTable;
  operating_bill_resource_confirmation: OperatingBillResourceConfirmationTable;
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
