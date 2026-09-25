/**
 * @qianliu/database — Kysely dialect、Schema 类型、迁移框架入口与仓储。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * TRD §4：Kysely 0.28.7 + pg 8.16.3；金额字段使用 PostgreSQL numeric + decimal.js。
 */

export * from "./exports/provider-finance.js";
export * from "./exports/identity-access.js";
export * from "./exports/runtime-assurance.js";
export * from "./exports/delivery-ledger.js";

export { createKysely, type Database } from "./kysely.js";

export {
  MIGRATIONS_PATH,
  listMigrations,
  migrateToLatest,
  migrateDown,
} from "./migrator.js";

/**
 * @qianliu/database — Kysely dialect、Schema 类型、迁移框架入口与仓储。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * TRD §4：Kysely 0.28.7 + pg 8.16.3；金额字段使用 PostgreSQL numeric + decimal.js。
 */

export { type ProbeRunEndpointScope } from "./kysely-operations-tables.js";

export {
  createProjectMembership, reviseProjectMembership, listProjectMemberships,
  MembershipOverlapConflictError, MembershipRevisionConflictError, MembershipNotFoundError,
  type CreateMembershipInput, type MembershipMutationResult, type MembershipWeightInput,
  type ListMembershipsParams, type MembershipListResult, type MembershipListRow,
  type ReviseMembershipInput,
} from "./repositories/project-membership-repository.js";
export {
  reviseProjectAccountingLifecycle, getProjectAccountingProfile,
  AccountingVersionConflictError,
  AccountingAlreadyEndedError, AccountingEffectiveBeforeStartError,
  type ReviseAccountingLifecycleInput, type AccountingLifecycleResult,
  type ProjectAccountingProfileView,
} from "./repositories/project-accounting-lifecycle-repository.js";
export {
  publishEmployeeRules, publishProjectIntent,
  AllocationPolicyVersionConflictError, AllocationRuleConflictError,
  type PublishRulesInput, type PublishRulesOutcome, type DesiredRuleInput,
  type ProjectIntentSegment,
} from "./repositories/employee-allocation-policy-repository.js";
export {
  getEmployeePolicyOverview, previewPolicyChange,
  type EmployeePolicyOverview, type PolicyPreviewResult, type PolicyPreviewSegment,
} from "./repositories/employee-allocation-policy-preview.js";
export {
  enumerateShanghaiMonths, markAllocationDirty, resolveAllocationPrincipal,
  lockEmployeeAllocationScope, lockProjectAccountingScope, allocationInputHash,
  PrincipalNotAccessibleError, AllocationRunNotAccessibleError, resolveAllocationRunRef,
  type AllocationDb, type AllocationPrincipalType, type ActiveMembershipRevision,
} from "./repositories/project-allocation-common.js";
export {
  loadAllocationSourceLines, loadAllocationContexts, enableProjectAllocation,
  enqueueAllocationRun, claimNextAllocationRun, executeAllocationRun, runDueAllocationRuns,
  ALLOCATION_SCHEMA_VERSION, ALLOCATION_ALGORITHM_VERSION,
  type EnableAllocationInput, type EnqueueRunResult, type ExecuteRunResult,
} from "./repositories/project-allocation-run-repository.js";
export {
  getAllocationRunStatus, listProjectAllocationSummaries, getUnallocatedSummary,
  listAllocationLines, listUnallocatedLines,
  type AllocationRunStatus, type ProjectAllocationSummary, type UnallocatedSummary,
  type AllocationLineRow, type UnallocatedLineRow,
} from "./repositories/project-allocation-read-repository.js";
export { freezeProjectAllocationForClose, AllocationNotReadyError } from "./repositories/project-allocation-freeze.js";
export { projectAllocationTick, type AllocationScanResult } from "./repositories/project-allocation-scan.js";

export const DATABASE_VERSION = "0.3.0" as const;
