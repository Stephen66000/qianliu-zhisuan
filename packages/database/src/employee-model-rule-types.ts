import type { Generated } from "kysely";

/** POOL-029：员工模型授权规则的数据库表类型。 */
export interface EmployeeModelTarget {
  unified_model_id: string;
  provider_resource_id: string;
}

/** POOL-035：批量规则厂商级池额度，与单人侧 PoolSpec 形态对齐。jsonb 内 bigint 用字符串承载。 */
export interface EmployeeModelPoolQuota {
  provider_code: string;
  quota_value: string;
  allow_overage: boolean;
  valid_until: string | null;
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
  /** POOL-033：允许 NULL，表示额度不在规则上（已迁移到主体×厂商池）；旧版本数值仅用于回放。 */
  quota_value: bigint | null;
  allow_overage: Generated<boolean>;
  valid_from: Date;
  valid_until: Date | null;
  /** POOL-035：厂商级池额度；空数组或 NULL 时回退版本级 quota_value/allow_overage/valid_until。 */
  pool_quotas: Generated<EmployeeModelPoolQuota[] | null>;
  lock_version: Generated<number>;
  validation_snapshot: Record<string, unknown> | null;
  publish_idempotency_key: string | null;
  publish_request_hash: string | null;
  published_at: Date | null;
  disabled_at: Date | null;
  created_by_admin_user_id: string;
  /** POOL-033：单人规则归属主体（决策点①）；批量规则为 NULL。每主体至多一条单人规则。 */
  owner_principal_id: string | null;
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
