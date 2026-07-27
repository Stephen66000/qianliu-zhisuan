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
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  provider: ProviderTable;
  provider_resource: ProviderResourceTable;
  unified_model: UnifiedModelTable;
  model_route: ModelRouteTable;
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
