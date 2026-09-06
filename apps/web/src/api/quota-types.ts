// ---------- /billing-rules（snake_case 直传） ----------

export interface BillingRuleWindow {
  timezone: string;
  days_of_week: number[] | null;
  start_time: string;
  end_time: string;
}

export interface BillingRule {
  pricing_mode?: "ABSOLUTE" | "MULTIPLIER";
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
  archived_at: string | null;
  archived_by_admin_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingRulesResult {
  rules: BillingRule[];
}

// ---------- /dispatch-policies（camelCase，含全部生命周期状态） ----------

export interface DispatchPolicy {
  archivedAt?: string | null;
  version?: number;
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
  copiedFromPolicyId: string | null;
  createdByAdminId: string | null;
  validatedAt: string | null;
  validatedByAdminId: string | null;
  publishedAt: string | null;
  publishedByAdminId: string | null;
  effectiveAt: string | null;
  retiredAt: string | null;
  retiredByAdminId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchPoliciesResult {
  policies: DispatchPolicy[];
}

export interface UnifiedModel {
  id: string;
  enterprise_id: string;
  alias: string;
  display_name: string;
  required_capabilities: string[] | null;
  status: string;
  version: number;
  archived_at: string | null;
  archived_by_admin_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnifiedModelsResult {
  models: UnifiedModel[];
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
  archived_at: string | null;
  archived_by_admin_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelRoutesResult {
  routes: ModelRouteItem[];
}
