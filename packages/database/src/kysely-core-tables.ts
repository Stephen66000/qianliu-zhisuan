import type { Generated } from "kysely";

export interface KyselyMigrationTable {
  name: string;
}
export interface KyselyMigrationLockTable {
  id: number;
}
export interface EnterpriseTable {
  session_minutes: Generated<number>;
  login_max_failures: Generated<number>;
  login_lock_minutes: Generated<number>;
  force_initial_password_change: Generated<boolean>;
  security_version: Generated<number>;
  id: Generated<string>;
  name: string;
  management_contact: string | null;
  contact_email: string | null;
  status: Generated<string>;
  timezone: Generated<string>;
  default_currency: Generated<string>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AdminUserTable {
  role_code: Generated<"SUPER_ADMIN" | "CUSTOM">;
  id: Generated<string>;
  enterprise_id: string;
  username: string;
  display_name: Generated<string>;
  password_hash: string;
  must_change_password: Generated<boolean>;
  status: Generated<string>;
  archived_at: Generated<Date | null>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AdminSessionTable {
  user_agent: string | null;
  ip_address: string | null;
  last_seen_at: Date | null;
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
  person_id: string | null;
  owner_person_id: string | null;
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
  authorization_rule_version_id: string | null;
  pool_model_alias: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface PrincipalAccessIdempotencyTable {
  enterprise_id: string;
  principal_id: string;
  idempotency_key: string;
  request_hash: string;
  response_snapshot: Record<string, unknown>;
  created_at: Generated<Date>;
}
export interface PrincipalAccessConfigStateTable {
  enterprise_id: string;
  principal_id: string;
  config_version: Generated<number>;
  updated_at: Generated<Date>;
}
export interface PrincipalProviderDisabledModelTable {
  enterprise_id: string;
  principal_id: string;
  provider: string;
  unified_model_id: string;
  disabled_at: Generated<Date>;
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
