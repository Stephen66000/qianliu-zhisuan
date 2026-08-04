import type { Generated } from "kysely";

/** POOL-029：员工模型授权规则的数据库表类型。 */
export interface EmployeeModelTarget {
  unified_model_id: string;
  provider_resource_id: string;
}

export interface EmployeeModelRuleVersionTable {
  id: Generated<string>;
  enterprise_id: string;
  rule_id: string;
  version: number;
  name: string;
  status: Generated<"DRAFT" | "VALIDATED" | "PUBLISHED" | "DISABLED">;
  employee_scope: "SELECTED" | "ALL";
  principal_ids: string[];
  model_scope: "SELECTED" | "ALL";
  model_targets: EmployeeModelTarget[];
  quota_value: bigint;
  allow_overage: Generated<boolean>;
  valid_from: Date;
  valid_until: Date | null;
  lock_version: Generated<number>;
  validation_snapshot: Record<string, unknown> | null;
  publish_idempotency_key: string | null;
  published_at: Date | null;
  disabled_at: Date | null;
  created_by_admin_user_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeModelRuleAssignmentTable {
  id: Generated<string>;
  enterprise_id: string;
  rule_version_id: string;
  principal_id: string;
  unified_model_id: string;
  provider_resource_id: string;
  grant_id: string;
  status: Generated<"ACTIVE" | "DISABLED">;
  created_at: Generated<Date>;
  disabled_at: Date | null;
}

export interface PrincipalModelManualAuthorizationTable {
  enterprise_id: string;
  principal_id: string;
  unified_model_id: string;
  created_at: Generated<Date>;
}
