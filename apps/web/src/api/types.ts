/**
 * W18 前端 API 类型契约 —— 管理 API 响应类型。
 *
 * 与后端对齐（W18 后端 commit 41e6eb8）：
 *   - /dashboard、/usage：camelCase（仓储手动映射），类型镜像
 *     packages/database/src/repositories/{dashboard,usage}-repository.ts；
 *   - /billing-rules、/supply-forecasts：snake_case 直传（repository 原样返回，项目惯例）；
 *   - /dispatch-policies：camelCase（仅 PUBLISHED 状态）。
 *
 * 金额/额度/token 字段为字符串（十进制或 BigInt 文本），前端只做展示格式化，
 * 不做账本/额度/节省重算（硬约束：详细开发计划行 146）。
 */

/** 后端业务错误体（扁平两字段，非嵌套）。 */
export interface ApiErrorBody {
  error: string;
  message: string;
}

export type * from "./reporting-types";

// ---------- /billing-rules（snake_case 直传） ----------

export interface BillingRuleWindow {
  timezone: string;
  days_of_week: number[] | null;
  start_time: string;
  end_time: string;
}

export interface BillingRule {
  id: string;
  rule_type: string;
  rule_version: string;
  provider_resource_id: string | null;
  upstream_model: string | null;
  effective_from: string;
  effective_to: string | null;
  timezone: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  time_windows: BillingRuleWindow[] | null;
  multiplier: string | null;
  cache_hit_price: string | null;
  cache_miss_price: string | null;
  output_price: string | null;
  currency: string;
  priority: number;
  enabled: boolean;
  source: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface BillingRulesResult {
  rules: BillingRule[];
}

// ---------- /dispatch-policies（camelCase，含全部生命周期状态） ----------

export interface DispatchPolicy {
  id: string;
  status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "RETIRED";
  matchUnifiedModel: string | null;
  matchResourceMode: string | null;
  matchProviderResourceId: string | null;
  matchTimezone: string | null;
  matchDaysOfWeek: number[] | null;
  matchStartTime: string | null;
  matchEndTime: string | null;
  matchPriceMultiplierMin: string | null;
  matchRemainingQuotaRatioMax: string | null;
  matchForecastExhaustRisk: boolean | null;
  matchPrincipalScope: string[] | null;
  action: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  switchEquivalentGroup: string[];
  rateLimitPerMinute: number | null;
  policyVersion: string;
  priority: number;
  description: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchPoliciesResult {
  policies: DispatchPolicy[];
}

// ---------- /supply-forecasts（snake_case 直传，全部快照未去重） ----------

export interface SupplyForecast {
  id: string;
  provider_resource_id: string;
  resource_name: string;
  rate_1h: string | null;
  rate_24h: string | null;
  rate_7d: string | null;
  forecast_exhaust_at: string | null;
  next_recover_at: string | null;
  coverage_hours: string | null;
  remaining_quota: string | null;
  confidence: string;
  data_points: number;
  not_calculable_reason: string | null;
  snapshot_at: string;
}

export interface SupplyForecastsResult {
  forecasts: SupplyForecast[];
}

// ---------- /auth ----------

export type FeatureFlagName =
  | "FEATURE_DIRECTORY_IMPORT"
  | "FEATURE_USAGE_OVERVIEW_V2"
  | "FEATURE_DEPARTMENT_COST"
  | "FEATURE_RESOURCE_UTILIZATION_V2"
  | "FEATURE_PROCUREMENT_REVIEW";

export type FeatureFlags = Record<FeatureFlagName, boolean>;

export interface AdminSession {
  adminUserId: string;
  enterpriseId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
}

export interface LoginResponse {
  admin: {
    id: string;
    username: string;
    display_name: string;
    enterprise_id: string;
    must_change_password: boolean;
  };
  featureFlags: FeatureFlags;
}

export interface AdminAccount {
  id: string;
  enterprise_id: string;
  username: string;
  display_name: string;
  status: "ACTIVE" | "DISABLED";
  must_change_password: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

// ---------- W19 写操作（snake_case 直传为主，镜像后端 schema） ----------

/** GET /principals 响应元素（snake_case）。 */
export interface Principal {
  id: string;
  enterprise_id: string;
  type: "EMPLOYEE" | "PROJECT";
  name: string;
  department_label: string | null;
  status: "ACTIVE" | "DISABLED";
  archived_at: string | null;
  person_id?: string | null;
  owner_person_id?: string | null;
  /** 主体行级乐观并发版本；后端 principal 表始终回传（selectAll）。 */
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PrincipalsResult {
  principals: Principal[];
}

export interface PrincipalCleanupPreview {
  keyCount: number;
  activeKeyCount: number;
  grantCount: number;
  activeGrantCount: number;
  requestCount: number;
  usageCount: number;
  ledgerCount: number;
  employeeLoginCount: number;
  authorizationRuleAssignmentCount?: number;
  canDelete: boolean;
}

/** GET /provider-resources 列表元素（后端已裁剪为公开视图，无密文）。 */
export interface ProviderResourceItem {
  id: string;
  provider_id: string;
  name: string;
  mode: "API" | "CODING_PLAN";
  credential_type: "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION";
  credential_fingerprint: string | null;
  credential_version: number | null;
  status: string;
  /** POOL-031：资源健康详情字段（脱敏运行元数据）。 */
  consecutive_failures: number;
  cooldown_until: string | null;
  last_probe_at: string | null;
  credential_refresh_status: string;
  refresh_error_classification: string | null;
  credential_expires_at: string | null;
  resource_pool_id: string | null;
  upstream_models: string[] | null;
  concurrency_limit: number | null;
  version: number;
  monthly_budget_amount?: string | null;
  monthly_budget_currency?: string | null;
  created_at: string;
  updated_at: string;
  operating_snapshot: ProviderResourceOperatingSnapshot | null;
}

export interface ProviderResourcesResult {
  resources: ProviderResourceItem[];
}

export interface UnifiedModel {
  id: string;
  enterprise_id: string;
  alias: string;
  display_name: string;
  required_capabilities: string[] | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderResourceOperatingSnapshot {
  id: string;
  provider_resource_id: string;
  version: number;
  source: "ADMIN" | "PROVIDER_SYNC" | "BILL_RECONCILIATION";
  collected_at: string;
  currency: string | null;
  recharge_amount: string | null;
  current_balance: string | null;
  cumulative_cost: string | null;
  current_period_cost: string | null;
  cost_period_start: string | null;
  cost_period_end: string | null;
  balance_updated_at: string | null;
  package_name: string | null;
  package_cost: string | null;
  total_quota: string | null;
  quota_unit: string | null;
  used_quota: string | null;
  remaining_quota: string | null;
  effective_from: string | null;
  effective_until: string | null;
  reset_cycle: string | null;
  reset_anchor_at: string | null;
  reset_timezone: string | null;
  usage_calculation: "MANUAL_SNAPSHOT" | "SYSTEM_LEDGER";
  next_reset_at: string | null;
  quota_period_start?: string | null;
  quota_period_end?: string | null;
  calculated_at?: string;
}

/** POOL-032：厂商 Coding Plan 额度窗口快照（GET /provider-resources/:id/quota-windows）。
 * 与 operating_snapshot 的 token 口径独立——这里承载厂商返回的百分比/额度点（100 制）。
 * 日期字段由后端序列化为 ISO 字符串；数值字段为 numeric 字符串或 null。 */
export interface ProviderQuotaWindow {
  id: string;
  provider_resource_id: string;
  window_type: "FIVE_HOUR" | "WEEKLY";
  limit_value: string | null;
  used_value: string | null;
  remaining_value: string | null;
  unit: "PERCENT" | "POINT" | null;
  /** used/limit 比率（0-1 小数文本），便于进度条；可空。 */
  ratio: string | null;
  reset_at: string | null;
  provider_data_at: string | null;
  collected_at: string;
  source: "PROVIDER_SYNC" | "MANUAL_SYNC";
  adapter_version: string;
  sync_status: "SUCCESS" | "STALE" | "FAILED" | "UNSUPPORTED";
  sync_error_code: string | null;
  last_success_at: string | null;
}

export interface ProviderQuotaWindowsResult {
  windows: ProviderQuotaWindow[];
}

/** POOL-031：资源健康详情（服务端聚合，不要求前端解析日志）。 */
export interface ResourceHealth {
  resource_id: string;
  resource_name: string;
  status: string;
  status_label: string;
  available: boolean;
  probe: boolean;
  reason_code: string | null;
  reason_label: string | null;
  error_classification: string | null;
  consecutive_failures: number;
  first_occurred_at: string | null;
  last_occurred_at: string | null;
  last_success_at: string | null;
  cooldown_until: string | null;
  last_probe_at: string | null;
  credential_refresh_status: string;
  refresh_error_classification: string | null;
  credential_expires_at: string | null;
  dispatch_impact: string;
  recovery_guide: string;
  can_recover: boolean;
}

export interface UnifiedModelsResult {
  models: UnifiedModel[];
}

/** GET /providers 响应元素（snake_case）。 */
export interface Provider {
  id: string;
  enterprise_id: string;
  code: string;
  name: string;
  adapter_type: string;
  supported_protocols: string[] | null;
  capability_set: Record<string, unknown> | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProvidersResult {
  providers: Provider[];
}

export interface PrincipalGrantItem {
  id: string;
  principal_id: string;
  provider: string;
  model_alias: string;
  quota_unit: string;
  quota_value: string;
  allow_overage: boolean;
  valid_until: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GrantsResult {
  grants: PrincipalGrantItem[];
}

export interface PrincipalKeyItem {
  id: string;
  key_prefix: string;
  status: "ACTIVE" | "REVOKED";
  /** null 仅用于兼容历史“全部模型”Key；新 Key 始终为显式数组。 */
  allowed_model_ids: string[] | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface PrincipalKeysResult {
  keys: PrincipalKeyItem[];
}

export interface ModelRouteItem {
  id: string;
  enterprise_id: string;
  unified_model_id: string;
  provider_resource_id: string;
  upstream_model: string;
  priority: number;
  weight: number;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ModelRoutesResult {
  routes: ModelRouteItem[];
}

// ---------- POOL-029 员工使用规则 ----------

export interface EmployeeModelTarget {
  unified_model_id: string;
  provider_resource_id: string;
}

/** POOL-035：批量规则厂商级池额度，与单人侧 PoolSpec 形态对齐。 */
export interface EmployeeModelPoolQuota {
  provider_code: string;
  quota_value: string;
  allow_overage: boolean;
  valid_until: string | null;
}

export interface EmployeeModelRuleVersion {
  id: string;
  enterprise_id: string;
  rule_id: string;
  version: number;
  name: string;
  status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "DISABLED";
  employee_scope: "SELECTED" | "ALL";
  principal_ids: string[];
  model_scope: "SELECTED" | "ALL";
  model_targets: EmployeeModelTarget[];
  quota_value: string;
  allow_overage: boolean;
  valid_from: string;
  valid_until: string | null;
  /** POOL-035：厂商级池额度；空数组或缺失时回退版本级 quota_value。 */
  pool_quotas: EmployeeModelPoolQuota[];
  lock_version: number;
  validation_snapshot: EmployeeModelRuleValidation | null;
  published_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmployeeModelRuleValidation {
  ready: boolean;
  principal_ids: string[];
  model_targets: EmployeeModelTarget[];
  issues: Array<{
    code: string;
    message: string;
    principal_id?: string;
    unified_model_id?: string;
    provider_resource_id?: string;
  }>;
  principal_count: number;
  model_count: number;
  assignment_count: number;
  changes: {
    added: EmployeeModelRulePermissionChange[];
    retained: EmployeeModelRulePermissionChange[];
    removed: EmployeeModelRulePermissionChange[];
  };
}

export interface EmployeeModelRulePermissionChange {
  principal_id: string;
  principal_name: string;
  unified_model_id: string;
  model_name: string;
  provider_resource_id: string;
  resource_name: string;
}

export interface EmployeeRuleCatalog {
  principals: Array<Principal & {
    active_key_id: string | null;
    ready: boolean;
    unavailable_reason: string | null;
  }>;
  models: Array<{
    unified_model_id: string;
    alias: string;
    display_name: string;
    model_status: string;
    route_id: string;
    upstream_model: string;
    route_enabled: boolean;
    provider_resource_id: string;
    resource_name: string;
    resource_status: string;
    mode: "API" | "CODING_PLAN";
    provider_code: string;
    provider_name: string;
    provider_status: string;
    ready: boolean;
    unavailable_reasons: string[];
  }>;
}

export * from "./diagnostic-types";

// ===== POOL-033：接入配置（厂商池）类型 =====

export interface AccessConfigModel {
  unified_model_id: string;
  display_name: string;
  alias: string;
  provider_resource_id: string;
  resource_name: string;
  resource_mode: "API" | "CODING_PLAN";
  ready: boolean;
  unavailable_reasons: string[];
  /** 准入开关：该型号是否对本主体开通（池 ACTIVE 且未被显式掐掉）。 */
  enabled: boolean;
}

export interface AccessConfigPool {
  grant_id: string;
  /** 池总额度（字符串承载 bigint）。 */
  quota_value: string;
  quota_used: string;
  allow_overage: boolean;
  valid_until: string | null;
  source: "MANAGED_SINGLE" | "MANAGED_BATCH" | "MANUAL_PENDING";
  over_limit: boolean;
}

export interface AccessConfigProvider {
  provider_code: string;
  provider_name: string;
  pool: AccessConfigPool | null;
  models: AccessConfigModel[];
}

export interface AccessConfiguration {
  principal: {
    id: string;
    name: string;
    status: string;
    department_label: string | null;
  };
  key: {
    key_prefix: string;
    status: string;
    created_at: string;
    authorization_status: "PENDING" | "AUTHORIZED";
  } | null;
  providers: AccessConfigProvider[];
  summary: {
    total_quota: string;
    provider_count: number;
    model_count: number;
  };
  /** 历史手工授权待接管的型号 id 列表。 */
  manual_pending_takeover: string[];
  config_version: number;
}

export interface AccessConfigPoolInput {
  provider_code: string;
  quota_value: string;
  allow_overage: boolean;
  valid_until: string | null;
  enabled_model_ids: string[];
}

export interface AccessConfigPutBody {
  expected_version: number;
  idempotency_key: string;
  providers: AccessConfigPoolInput[];
}

export interface AccessConfigPutResult {
  config_version: number;
  changes: {
    pools_added: string[];
    pools_updated: string[];
    pools_closed: string[];
  };
  takeover: { cleared_manual: number };
  replayed?: boolean;
}
