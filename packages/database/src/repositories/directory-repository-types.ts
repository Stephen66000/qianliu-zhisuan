import type { Selectable } from "kysely";
import type {
  DirectoryImportItemStatus,
  DirectoryImportItemTable,
  DirectoryImportRunTable,
  DirectorySourceTable,
  OrganizationUnitTable,
} from "../kysely.js";

export type DirectorySource = Selectable<DirectorySourceTable>;
export type DirectoryImportRun = Selectable<DirectoryImportRunTable>;
export type DirectoryImportItem = Selectable<DirectoryImportItemTable>;
export type OrganizationUnit = Selectable<OrganizationUnitTable>;

export type DirectoryRepositoryErrorCode =
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "INVALID_STATE"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SOURCE_INACTIVE"
  | "RUN_BUSY";

export class DirectoryRepositoryError extends Error {
  constructor(
    readonly code: DirectoryRepositoryErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DirectoryRepositoryError";
  }
}

/** API 安全视图：只暴露指纹，不暴露 config_ciphertext。 */
export type DirectorySourceView = Omit<DirectorySource, "config_ciphertext"> & {
  configured: true;
};

export interface UpsertDirectorySourceInput {
  enterpriseId: string;
  type: "WECOM" | "FEISHU";
  actorAdminUserId: string;
  configCiphertext?: string;
  configFingerprint?: string;
  configKeyVersion?: number;
  connectorVersion?: string;
  status?: "ACTIVE" | "DISABLED";
  expectedVersion?: number;
}

export interface CreateDirectoryRunInput {
  enterpriseId: string;
  mode: "SYNC" | "EXCEL";
  idempotencyKey: string;
  requestHash: string;
  createdByAdminUserId: string;
  directorySourceId?: string | null;
  templateVersion?: string | null;
  connectorVersion?: string | null;
  sourceSnapshotId?: string | null;
  contentSha256?: string | null;
  sourceDataAt?: Date | null;
}

export interface StageDirectoryItemInput {
  rowNumber: number;
  externalMemberId?: string | null;
  employeeNumber?: string | null;
  normalizedName?: string | null;
  normalizedDepartmentPath?: string | null;
  externalDepartmentId?: string | null;
  normalizedEmail?: string | null;
  normalizedMobile?: string | null;
  existingPrincipalId?: string | null;
  /** Excel／Adapter 已发现的稳定行错误；不会进入业务匹配。 */
  reasonCode?: string | null;
}

export interface StageDirectoryRunInput {
  enterpriseId: string;
  runId: string;
  items: StageDirectoryItemInput[];
  sourceSnapshotId?: string | null;
  contentSha256?: string | null;
  sourceDataAt?: Date | null;
}

export interface DirectoryMemberView {
  person_id: string;
  employee_number: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  person_status: "ACTIVE" | "DISABLED";
  principal_id: string | null;
  principal_status: "ACTIVE" | "DISABLED" | null;
  organization_unit_id: string | null;
  department_name: string | null;
  department_path: string | null;
  source_type: "WECOM" | "FEISHU" | null;
  external_member_id: string | null;
  access_config_version: number | null;
  key_state: "ACTIVE" | "PENDING_FIRST_CLAIM" | null;
  import_status: DirectoryImportItemStatus | null;
  reason_code: string | null;
}

export interface DirectoryMemberQuery {
  limit?: number;
  offset?: number;
  organizationUnitId?: string;
  importStatus?: DirectoryImportItemStatus;
  search?: string;
}

export interface DirectoryMemberPage {
  members: DirectoryMemberView[];
  total: number;
  limit: number;
  offset: number;
}

