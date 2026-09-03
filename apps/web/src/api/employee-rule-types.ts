import type { Principal } from "./types.js";

export interface EmployeeModelTarget {
  unified_model_id: string;
  provider_resource_id: string;
}

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
