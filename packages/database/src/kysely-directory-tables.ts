import type { Generated } from "kysely";
import type {
  PersonExternalIdentityTable as LegacyPersonExternalIdentityTable,
  PersonTable as LegacyPersonTable,
} from "./kysely-availability-tables.js";

/** MIG-A：Person 增加企业归属和稳定员工编号；企业归属可由兼容触发器推导。 */
export interface DirectoryPersonTable extends LegacyPersonTable {
  enterprise_id: Generated<string>;
  employee_number: string | null;
  email: string | null;
  mobile: string | null;
}

/** MIG-A：外部身份按企业和可选通讯录来源隔离；provider_user_id 即外部成员 ID。 */
export interface DirectoryPersonExternalIdentityTable
  extends Omit<LegacyPersonExternalIdentityTable, "provider"> {
  enterprise_id: Generated<string>;
  directory_source_id: string | null;
  provider: "WECOM" | "FEISHU";
}

export interface DirectorySourceTable {
  id: Generated<string>;
  enterprise_id: string;
  type: "WECOM" | "FEISHU";
  config_ciphertext: string;
  config_fingerprint: string;
  config_key_version: Generated<number>;
  connector_version: Generated<string>;
  cursor: string | null;
  status: Generated<"ACTIVE" | "DISABLED">;
  last_successful_sync_at: Date | null;
  last_error_code: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrganizationUnitTable {
  id: Generated<string>;
  enterprise_id: string;
  parent_id: string | null;
  name: string;
  external_source_id: string | null;
  /** 接口来源填外部部门 ID；Excel 来源填标准化部门路径。 */
  external_unit_id: string | null;
  status: Generated<"ACTIVE" | "INACTIVE">;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrganizationMembershipTable {
  id: Generated<string>;
  enterprise_id: string;
  person_id: string;
  organization_unit_id: string;
  is_primary: Generated<boolean>;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  source: "WECOM" | "FEISHU" | "EXCEL";
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type DirectoryImportRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";

export interface DirectoryImportRunTable {
  id: Generated<string>;
  enterprise_id: string;
  directory_source_id: string | null;
  mode: "SYNC" | "EXCEL";
  job_type: "DIRECTORY_SYNC" | "DIRECTORY_IMPORT_APPLY";
  template_version: string | null;
  connector_version: string | null;
  source_snapshot_id: string | null;
  /** 接口标准化快照或 Excel 原文件的 SHA-256；不保存文件正文。 */
  content_sha256: string | null;
  request_hash: string;
  idempotency_key: string;
  created_by_admin_user_id: string;
  status: Generated<DirectoryImportRunStatus>;
  total_count: Generated<number>;
  matched_count: Generated<number>;
  created_count: Generated<number>;
  updated_count: Generated<number>;
  conflict_count: Generated<number>;
  skipped_count: Generated<number>;
  failed_count: Generated<number>;
  failure_reason_code: string | null;
  source_data_at: Date | null;
  attempt: Generated<number>;
  next_attempt_at: Date | null;
  lease_until: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type DirectoryImportItemStatus =
  | "STAGED"
  | "PROCESSING"
  | "MATCHED"
  | "CREATED"
  | "UPDATED"
  | "CONFLICT"
  | "SKIPPED"
  | "FAILED";

export interface DirectoryImportItemTable {
  id: Generated<string>;
  enterprise_id: string;
  run_id: string;
  row_number: number;
  external_member_id: string | null;
  employee_number: string | null;
  normalized_name: string | null;
  normalized_department_path: string | null;
  normalized_email: string | null;
  normalized_mobile: string | null;
  external_department_id: string | null;
  existing_principal_id: string | null;
  status: Generated<DirectoryImportItemStatus>;
  reason_code: string | null;
  person_id: string | null;
  principal_id: string | null;
  organization_unit_id: string | null;
  attempt: Generated<number>;
  lease_until: Date | null;
  processed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
