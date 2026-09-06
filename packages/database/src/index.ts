/**
 * @qianliu/database — Kysely dialect、Schema 类型、迁移框架入口与仓储。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * TRD §4：Kysely 0.28.7 + pg 8.16.3；金额字段使用 PostgreSQL numeric + decimal.js。
 */
export { createKysely, type Database } from "./kysely.js";
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
} from "./kysely-directory-tables.js";
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
  DirectoryRepository,
  DirectoryRepositoryError,
  type CreateDirectoryRunInput,
  type DirectoryImportItem,
  type DirectoryImportRun,
  type DirectoryMemberPage,
  type DirectoryMemberQuery,
  type DirectoryMemberView,
  type DirectorySource,
  type DirectorySourceView,
  type OrganizationUnit,
  type StageDirectoryItemInput,
  type StageDirectoryRunInput,
  type UpsertDirectorySourceInput,
} from "./repositories/directory-repository.js";
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
  GrantNotArchivableError,
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
  ModelRouteNotReadyError,
  ModelValidationInProgressError,
  type Provider,
  type ProviderResource,
  type ProviderResourceOperatingSnapshot,
  type ProviderOperatingSyncState,
  type OperatingSnapshotInput,
  type UnifiedModel,
  type ModelRoute,
  type CreateProviderInput,
  type CreateProviderResourceInput,
  type ModelValidationResult,
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
  type PersistAttemptUsageAccountingInput,
  type FinalizeRejectedAttemptSettlementInput,
  type CreateLedgerTransactionInput,
  type FinalizeLedgerSettlementInput,
} from "./repositories/gateway-ledger-repository.js";
export {
  GatewayLedgerSettlementConflictError,
  summarizeLedgerUsageQuality,
} from "./repositories/gateway-ledger-settlement.js";
export { listEnabledBillingRulesAt } from "./repositories/billing-rule-applicability.js";
export {
  ResourcePoolRepository,
  type ResourceStatusEvent,
  type ProviderResourceRow,
  type ServableResource,
  type HalfOpenProbeLease,
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
  type ResourceUsageOverview,
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
  UsageOverviewRepository,
  UsageOverviewEnterpriseNotFoundError,
  UsageOverviewSubjectNotFoundError,
  type UsageOverviewQuery,
  type UsageOverviewSubjectType,
  type UsageOverviewPeriod,
  type UsageOverviewMetrics,
  type UsageOverviewPoint,
  type UsageOverviewRankingItem,
  type UsageOverviewResult,
} from "./repositories/usage-overview-repository.js";
export {
  UsageAggregateRepository,
  markUsageAggregateDirtyForRequest,
  type UsageAggregateGranularity,
  type UsageAggregateBucketKey,
  type UsageAggregateRebuildResult,
  type UsageAggregateRangeResult,
} from "./repositories/usage-aggregate-repository.js";
export {
  OperatingBillRepository,
  InvalidOperatingBillMonthError,
  OperatingBillClosedError,
  OperatingBillAlreadyClosedError,
  OperatingBillNotClosedError,
  OperatingBillReferenceError,
  OperatingBillCloseNoteRequiredError,
  OperatingBillFutureOpeningBalanceError,
  OperatingBillOpeningBalanceCurrencyMismatchError,
  OperatingBillOpeningBalanceAlreadyAvailableError,
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
  loadMonthlyOperatingCosts,
  type ApiSpendStatus,
  type MonthlyOperatingCosts,
  type MonthlyOperatingCostResource,
  type MonthlyOperatingCostSummary,
} from "./repositories/monthly-operating-cost.js";
export {
  acquireOperatingBillMonthWriteBarrier,
  guardOperatingBillLedgerWrite,
  operatingBillMonthAt,
} from "./repositories/operating-bill-write-barrier.js";
export {
  loadDepartmentBill,
  loadDepartmentCloseEvidence,
  assertDepartmentCostConserved,
  DepartmentBillEvidenceUnavailableError,
  DepartmentCostNotConservedError,
  type DepartmentCloseEvidence,
  type FrozenDepartmentAttributionFact,
  type FrozenDepartmentBudgetFact,
  type FrozenResourcePurchaseFact,
} from "./repositories/department-cost-evidence.js";
export type {
  DepartmentBillView,
  DepartmentBudgetView,
  DepartmentBudgetStatus,
  DepartmentCostRow,
} from "./repositories/department-cost-types.js";
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
  CurrentSubscriptionPeriodRequiredError,
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
export {
  ProviderFinanceRepository,
} from "./repositories/provider-finance-repository.js";
export {
  ProviderFinanceCutoverRepository,
} from "./repositories/provider-finance-cutover-repository.js";
export type {
  FinanceCarryoverCandidate,
  FinanceConservationReport,
  FinanceOpeningCandidate,
  FinancePreflightReport,
  FinancePurchaseCandidate,
  FinanceUsageBackfillReport,
  LegacyApiCostResolutionInput,
  LegacyApiCostResolutionView,
} from "./repositories/provider-finance-cutover-types.js";
export {
  PROVIDER_FINANCE_CUTOVER,
  PROVIDER_FINANCE_LEGACY_COST_CUTOFF,
  ProviderFinanceError,
  type FinanceBalanceState,
  type FinanceBalanceView,
  type FinanceCurrency,
  type FinanceEventInput,
  type FinanceEventType,
  type FinanceEventView,
  type MonthlyFinanceSummary,
  type ResourceFinanceView,
  type OpeningCorrectionInput,
  type ReconciliationCaseInput,
  type ReverseFinanceEventInput,
  type SubscriptionInput,
} from "./repositories/provider-finance-types.js";

export const DATABASE_VERSION = "0.3.0" as const;
export { savePricingConfiguration, PricingConfigurationError } from "./repositories/quota-pricing-configuration.js";
export { archiveDispatchPolicy } from "./repositories/dispatch-policy-archive.js";
export { listPricingReadyRoutes, policyPricingReadiness } from "./repositories/dispatch-pricing-readiness.js";
export { PricingModeConflictError } from "./repositories/pricing-write-guard.js";

export { loadOperatingAnalysis } from "./repositories/operating-analysis-repository.js";

export {
  readPrincipalAccounting,
  savePrincipalAccounting,
  savePrincipalAccountingInTransaction,
  PrincipalAccountingError,
} from "./repositories/principal-accounting.js";

export { loadOperatingDepartmentAccounts } from "./repositories/operating-department-accounts.js";
