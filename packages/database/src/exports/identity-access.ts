/**
 * @qianliu/database 子导出：身份、目录与权限域。
 *
 * 由 src/index.ts 按域拆分而来（质量门禁单文件上限）；src/index.ts 以 `export *`
 * 再导出本模块，包对外导出面与历史调用点保持不变。
 *
 * 本文件只做再导出，不含实现，新增导出必须归入对应域子模块而非重新堆回 index.ts。
 */
export type {
  DirectoryImportItemStatus,
  DirectoryImportItemTable,
  DirectoryImportRunStatus,
  DirectoryImportRunTable,
  DirectoryPersonExternalIdentityTable,
  DirectoryPersonTable,
  DirectorySourceTable,
  OrganizationMembershipTable,
  OrganizationUnitTable,
} from "../kysely-directory-tables.js";

export {
  PrincipalRepository,
  PrincipalNotActiveError,
  type Principal,
  type CreatePrincipalInput,
  type UpdatePrincipalInput,
  type PrincipalCleanupPreview,
  type PrincipalDeactivationResult,
  type PrincipalDeleteResult,
  type PrincipalLifecycleAudit,
} from "../repositories/principal-repository.js";

export {
  activateEmployeePrincipal,
  applyPublishedEmployeeRules,
} from "../repositories/directory-import-apply.js";

export {
  DirectoryRepository,
  DirectoryRepositoryError,
  type CreateDirectoryRunInput,
  type DirectoryImportItem,
  type DirectoryImportRun,
  type DirectoryMemberActivationInput,
  type DirectoryMemberActivationResult,
  type DirectoryMemberPage,
  type DirectoryMemberQuery,
  type DirectoryMemberView,
  type DirectorySource,
  type DirectorySourceView,
  type OrganizationUnit,
  type StageDirectoryItemInput,
  type StageDirectoryRunInput,
  type UpsertDirectorySourceInput,
} from "../repositories/directory-repository.js";

export {
  AuditRepository,
  type OperationLog,
  type WriteAuditInput,
} from "../repositories/audit-repository.js";

export {
  AdminRepository,
  AdminNotFoundError,
  AdminMustBeDisabledError,
  SelfDisableError,
  SelfCleanupError,
  LastActiveAdminError,
  type AdminUser,
  type AdminSession,
} from "../repositories/admin-repository.js";

export {
  KeyRepository,
  ActiveKeyExistsError,
  type PrincipalKey,
  type CreatedKey,
} from "../repositories/key-repository.js";

export {
  GrantRepository,
  GrantNotArchivableError,
  type PrincipalGrant,
  type CreateGrantInput,
} from "../repositories/grant-repository.js";

export {
  EmployeeModelRuleRepository,
  EmployeeModelRuleError,
  type EmployeeModelRuleVersion,
  type EmployeeModelRuleInput,
  type RuleValidationResult,
  type RuleReadinessIssue,
} from "../repositories/employee-model-rule-repository.js";

export { type EmployeeModelPoolQuota } from "../employee-model-rule-types.js";

export {
  PrincipalAccessConfigRepository,
  PrincipalAccessConfigError,
  type PoolSpec,
  type AccessConfigPutInput,
  computeAllowedModelIds,
} from "../repositories/principal-access-config-repository.js";

export {
  AdminWriteRepository,
  AdminCredentialRotationRequiredError,
  AdminRecoverNotFoundError,
  CurrentSubscriptionPeriodRequiredError,
} from "../repositories/admin-write-repository.js";
