/**
 * @qianliu/database — Kysely dialect、Schema 类型、迁移框架入口与仓储。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * TRD §4：Kysely 0.28.7 + pg 8.16.3；金额字段使用 PostgreSQL numeric + decimal.js。
 */
export { createKysely, type Database } from "./kysely.js";
export {
  MIGRATIONS_PATH,
  listMigrations,
  migrateToLatest,
  migrateDown,
} from "./migrator.js";
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
} from "./repositories/principal-repository.js";
export {
  AuditRepository,
  type OperationLog,
  type WriteAuditInput,
} from "./repositories/audit-repository.js";
export {
  DeploymentLogRepository,
  DeploymentLogImmutableError,
  type DeploymentLog,
  type DeploymentLogEvent,
  type DeploymentManifest,
  type DeploymentStatus,
} from "./repositories/deployment-log-repository.js";
export {
  AdminRepository,
  AdminNotFoundError,
  SelfDisableError,
  LastActiveAdminError,
  type AdminUser,
  type AdminSession,
} from "./repositories/admin-repository.js";
export {
  KeyRepository,
  ActiveKeyExistsError,
  type PrincipalKey,
  type CreatedKey,
} from "./repositories/key-repository.js";
export {
  GrantRepository,
  type PrincipalGrant,
  type CreateGrantInput,
} from "./repositories/grant-repository.js";
export {
  EmployeeModelRuleRepository,
  EmployeeModelRuleError,
  type EmployeeModelRuleVersion,
  type EmployeeModelRuleInput,
  type RuleValidationResult,
  type RuleReadinessIssue,
} from "./repositories/employee-model-rule-repository.js";
export { type EmployeeModelPoolQuota } from "./employee-model-rule-types.js";
export {
  PrincipalAccessConfigRepository,
  PrincipalAccessConfigError,
  type PoolSpec,
  type AccessConfigPutInput,
  computeAllowedModelIds,
} from "./repositories/principal-access-config-repository.js";
export {
  ProviderRepository,
  EnterpriseReferenceError,
  IdempotencyConflictError,
  type Provider,
  type ProviderResource,
  type ProviderResourceOperatingSnapshot,
  type OperatingSnapshotInput,
  type UnifiedModel,
  type ModelRoute,
  type CreateProviderInput,
  type CreateProviderResourceInput,
} from "./repositories/provider-repository.js";
export {
  DEFAULT_RESET_TIMEZONE,
  calculateQuotaPeriod,
  projectCurrentOperatingSnapshots,
  type ResetCycle,
  type QuotaPeriod,
  type CurrentProviderOperatingSnapshot,
} from "./repositories/provider-operating.js";
export {
  GatewayLedgerRepository,
  type AiRequest,
  type UpstreamAttempt,
  type UsageEvent,
  type LedgerLine,
  type LedgerTransaction,
  type RouteCandidate,
  type CreateRequestInput,
  type ClaimRequestResult,
  type CreateAttemptInput,
  type UsageInput,
  type LedgerLineInput,
  type CreateUsageLedgerLineInput,
  type UsageLedgerLineResult,
  type CreateLedgerTransactionInput,
  type FinalizeLedgerSettlementInput,
} from "./repositories/gateway-ledger-repository.js";
export {
  GatewayLedgerSettlementConflictError,
  summarizeLedgerUsageQuality,
} from "./repositories/gateway-ledger-settlement.js";
export {
  ResourcePoolRepository,
  type ResourceStatusEvent,
  type ProviderResourceRow,
  type ServableResource,
} from "./repositories/resource-pool-repository.js";
export {
  QuotaGateRepository,
  type QuotaReserveOutcome,
} from "./repositories/quota-gate-repository.js";
export {
  DispatchPolicyRepository,
  type CreateDispatchPolicyInput,
  type CreateDispatchDecisionInput,
} from "./repositories/dispatch-policy-repository.js";
export {
  ReconciliationRepository,
  type ReconciliationRunInput,
  type ReconciliationOutcome,
} from "./repositories/reconciliation-repository.js";
export {
  DashboardRepository,
  type DashboardSummary,
  type ResourceBreakdownItem,
  type OverageItem,
} from "./repositories/dashboard-repository.js";
export {
  SupplyForecastRepository,
  type SupplyForecastTickResult,
} from "./repositories/supply-forecast-repository.js";
export {
  UsageRepository,
  type UsageQuery,
  type UsageRecord,
  type UsageResult,
  type AgentUsageSummary,
} from "./repositories/usage-repository.js";
export {
  OperatingBillRepository,
  InvalidOperatingBillMonthError,
  OperatingBillClosedError,
  OperatingBillAlreadyClosedError,
  OperatingBillNotClosedError,
  OperatingBillReferenceError,
  OperatingBillCloseNoteRequiredError,
  OperatingBillConcurrentModificationError,
  OperatingBillIncompleteError,
  operatingBillMonthRange,
  type OperatingBillView,
  type OperatingBillSnapshot,
  type OperatingBillProviderRow,
  type OperatingBillSubjectRow,
  type OperatingBillGap,
  type OperatingBillValueItemView,
} from "./repositories/operating-bill-repository.js";
export {
  OperatingBillAccountRepository,
  OperatingBillAccountReferenceError,
  OperatingBillAccountEvidenceUnavailableError,
  type OperatingBillAccountQuery,
  type OperatingBillRequestQuery,
  type OperatingBillUsageQuality,
  type OperatingBillAccountTotals,
  type OperatingBillAccountListView,
  type OperatingBillEmployeeDetailView,
  type OperatingBillRequestListView,
} from "./repositories/operating-bill-account-repository.js";
export {
  AdminWriteRepository,
  AdminRecoverNotFoundError,
} from "./repositories/admin-write-repository.js";
export {
  AlertEventRepository,
  DEFAULT_THRESHOLDS,
  type AlertEvent,
  type AlertThresholds,
} from "./repositories/alert-event-repository.js";
export {
  RuntimeAssuranceRepository,
  RuntimeAssuranceConflictError,
  type Person,
  type PersonView,
  type PersonExternalIdentity,
  type AvailabilityRule,
  type AvailabilityRuleVersion,
  type AvailabilityEvent,
  type NotificationEndpoint,
  type NotificationDelivery,
  type RuleVersionInput,
  type RuleView,
  type SignalInput,
  type SignalResult,
  type DeliveryContext,
  type LegacyUnavailableAssessment,
} from "./repositories/runtime-assurance-repository.js";

export {
  ProviderQuotaWindowRepository,
  type QuotaWindowUpsertInput,
  type CurrentQuotaWindow,
} from "./repositories/provider-quota-window-repository.js";

export const DATABASE_VERSION = "0.3.0" as const;
