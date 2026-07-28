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

// ---------- /dashboard（camelCase，镜像 DashboardRepository） ----------

export interface EarliestExhaustion {
  resourceId: string;
  resourceName: string;
  providerCode: string;
  forecastExhaustAt: string | null;
  nextRecoverAt: string | null;
  confidence: string;
  notCalculableReason: string | null;
}

export interface ResourceBreakdownItem {
  providerCode: string;
  providerName: string;
  mode: "API" | "CODING_PLAN";
  accountCount: number;
  totalQuota: string | null;
  usedQuota: string | null;
  monthlyCost: string;
  currentRate24h: string | null;
  forecastExhaustAt: string | null;
  /** 当前恒为 "HEALTHY"（W20 才细化），前端不据此渲染异常态。 */
  status: string;
}

export interface OverageItem {
  principalId: string;
  principalName: string;
  principalType: string;
  provider: string;
  modelAlias: string;
  quotaValue: string;
  usedValue: string;
  overageValue: string;
  /** 小数文本（如 "0.0500"），展示百分比时需 ×100。 */
  overageRatio: string;
}

export interface DashboardSummary {
  resourceAccountCount: number;
  activeEmployeeCount: number;
  currentInUseCount: number;
  /** 数据源 gap（无支付表），恒 null，前端按空状态展示，不伪造。 */
  monthlyPackagePayment: string | null;
  monthlyApiCost: string;
  /** 数据源 gap（无充值表），恒 null，同上。 */
  monthlyRechargeAmount: string | null;
  earliestExhaustion: EarliestExhaustion | null;
  monthlyDispatchSaving: string;
  resourceBreakdown: ResourceBreakdownItem[];
  overageList: OverageItem[];
}

// ---------- /usage（camelCase，镜像 UsageRepository） ----------

export interface UsageRecord {
  requestId: string;
  principalId: string;
  principalName: string;
  principalType: string;
  clientId: string | null;
  unifiedModel: string;
  status: string;
  errorClassification: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalCacheTokens: string;
  totalDeductedQuota: string;
  /** 十进制文本；"0" = 套餐内。 */
  totalApiCost: string;
  usageQuality: string;
  attemptCount: number;
}

export interface UsageResult {
  records: UsageRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface UsageQueryParams {
  limit?: number;
  offset?: number;
  principal_id?: string;
  client_id?: string;
  unified_model?: string;
  status?: string;
  from?: string;
  to?: string;
}

// ---------- /billing-rules（snake_case 直传） ----------

export interface BillingRule {
  id: string;
  rule_type: string;
  rule_version: number;
  provider_resource_id: string | null;
  upstream_model: string | null;
  effective_from: string;
  effective_to: string | null;
  timezone: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  multiplier: string | null;
  cache_hit_price: string | null;
  cache_miss_price: string | null;
  output_price: string | null;
  currency: string;
  priority: number;
  enabled: boolean;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingRulesResult {
  rules: BillingRule[];
}

// ---------- /dispatch-policies（camelCase，仅 PUBLISHED） ----------

export interface DispatchPolicy {
  id: string;
  status: string;
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
  policyVersion: number;
  priority: number;
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

export interface AdminSession {
  adminUserId: string;
  enterpriseId: string;
  username: string;
}

export interface LoginResponse {
  admin: {
    id: string;
    username: string;
    enterprise_id: string;
  };
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
  created_at: string;
  updated_at: string;
}

export interface PrincipalsResult {
  principals: Principal[];
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
  upstream_models: string[] | null;
  concurrency_limit: number | null;
  created_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface UnifiedModelsResult {
  models: UnifiedModel[];
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
  created_at: string;
  updated_at: string;
}

export interface GrantsResult {
  grants: PrincipalGrantItem[];
}

// ---------- W20 诊断下钻（camelCase，网关侧已脱敏） ----------

export interface GatewayRequestDetail {
  request: {
    id: string;
    principalId: string;
    protocol: string;
    unifiedModel: string;
    stream: boolean;
    status: string;
    clientId: string | null;
    startedAt: string;
    finishedAt: string | null;
    errorClassification: string | null;
    errorCode: string | null;
  };
  settlement: {
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCacheTokens: string;
    totalDeductedQuota: string;
    totalApiCost: string;
    usageQuality: string;
    attemptCount: number;
    status: string;
  } | null;
}

export interface RouteCandidateItem {
  providerResourceId: string;
  upstreamModel: string;
  priority: number;
  weight: number;
  selected: boolean;
  scoreFactors: Record<string, unknown> | null;
  totalScore: string | null;
  reasonCode: string | null;
}

export interface AttemptItem {
  attemptNo: number;
  providerResourceId: string;
  upstreamModel: string;
  startedAt: string;
  firstByteAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  errorClassification: string | null;
  errorCode: string | null;
  responseCommitted: boolean;
  switchReason: string | null;
}

export interface DispatchDecisionItem {
  finalAction: string;
  reasonCode: string;
  reasonDetail: string | null;
  matchedPolicyId: string | null;
  switchTargetResourceId: string | null;
  counterfactualCost: string | null;
  actualCost: string | null;
  dispatchSaving: string | null;
  savingCalculable: boolean;
  notCalculableReason: string | null;
}

// ---------- W20 异常告警（camelCase，alert_event 生命周期） ----------

export type AlertDomain =
  | "RESOURCE_UNAVAILABLE"
  | "USAGE_SPIKE"
  | "QUOTA_ANOMALY"
  | "CREDENTIAL_INVALID";

export interface AlertItem {
  id: string;
  alertKey: string;
  domain: AlertDomain;
  signal: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string | null;
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
  status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "IGNORED" | "AUTO_RESOLVED";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AlertsResult {
  alerts: AlertItem[];
  /** 已处理历史（仅 ?history=true 时返回）。 */
  history?: AlertItem[];
}

// ---------- 操作日志（snake_case 直传） ----------

export interface OperationLogItem {
  id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  change_summary: Record<string, unknown> | null;
  result: string;
  failure_reason: string | null;
  created_at: string;
}

export interface OperationLogsResult {
  logs: OperationLogItem[];
}
