/**
 * @qianliu/database 子导出：厂商资源、网关账本与用量域。
 *
 * 由 src/index.ts 按域拆分而来（质量门禁单文件上限）；src/index.ts 以 `export *`
 * 再导出本模块，包对外导出面与历史调用点保持不变。
 *
 * 本文件只做再导出，不含实现，新增导出必须归入对应域子模块而非重新堆回 index.ts。
 */
export { CredentialChatProbeRepository, CredentialProbeConflict, credentialProbeView } from "../repositories/credential-chat-probe.js";

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
  type ResourceRouteItem,
  type DeleteProviderResult,
  type UpdateProviderInput,
  type DeleteResourceSafelyResult,
} from "../repositories/provider-repository.js";

export { type ModelProbeRunInput } from "../repositories/provider-model-discovery-repository.js";

export {
  DEFAULT_RESET_TIMEZONE,
  calculateQuotaPeriod,
  projectCurrentOperatingSnapshots,
  type ResetCycle,
  type QuotaPeriod,
  type CurrentProviderOperatingSnapshot,
} from "../repositories/provider-operating.js";

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
} from "../repositories/gateway-ledger-repository.js";

export {
  GatewayLedgerSettlementConflictError,
  summarizeLedgerUsageQuality,
} from "../repositories/gateway-ledger-settlement.js";

export { listEnabledBillingRulesAt } from "../repositories/billing-rule-applicability.js";

export {
  ResourcePoolRepository,
  type ResourceStatusEvent,
  type ProviderResourceRow,
  type ServableResource,
  type HalfOpenProbeLease,
} from "../repositories/resource-pool-repository.js";

export {
  QuotaGateRepository,
  type QuotaReserveOutcome,
} from "../repositories/quota-gate-repository.js";

export {
  DispatchPolicyRepository,
  type CreateDispatchPolicyInput,
  type CreateDispatchDecisionInput,
} from "../repositories/dispatch-policy-repository.js";

export {
  ReconciliationRepository,
  type ReconciliationRunInput,
  type ReconciliationOutcome,
} from "../repositories/reconciliation-repository.js";

export {
  DashboardRepository,
  type DashboardSummary,
  type ResourceBreakdownItem,
  type ResourceUsageOverview,
  type OverageItem,
} from "../repositories/dashboard-repository.js";

export {
  getStandardHomeSummary,
} from "../repositories/dashboard-home.js";

export {
  previousShanghaiMonthWindow,
  previousEmployeeWindow,
} from "../repositories/dashboard-home-metrics.js";

export { loadStandardHomeResources } from "../repositories/dashboard-home-providers.js";

export {
  loadWindowOperatingFinance,
  loadWindowBridgeCosts,
} from "../repositories/dashboard-home-costs.js";

export {
  type StandardHomeSummary,
  type StandardHomeOptions,
  type StandardHomeTokenUsage,
  type StandardHomeMonthlyCost,
  type StandardHomeActiveEmployees,
  type StandardHomeActiveProjects,
  type StandardHomeResources,
  type StandardHomeProviderRow,
  type StandardHomeWindow,
  type ProviderStatusCategory,
} from "../repositories/dashboard-home-types.js";

export {
  SupplyForecastRepository,
  type SupplyForecastTickResult,
} from "../repositories/supply-forecast-repository.js";

export {
  UsageRepository,
  type UsageQuery,
  type UsageRecord,
  type UsageResult,
  type AgentUsageSummary,
} from "../repositories/usage-repository.js";

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
} from "../repositories/usage-overview-repository.js";

export {
  UsageAggregateRepository,
  markUsageAggregateDirtyForRequest,
  type UsageAggregateGranularity,
  type UsageAggregateBucketKey,
  type UsageAggregateRebuildResult,
  type UsageAggregateRangeResult,
} from "../repositories/usage-aggregate-repository.js";

export {
  ProviderQuotaWindowRepository,
  type QuotaWindowUpsertInput,
  type CurrentQuotaWindow,
} from "../repositories/provider-quota-window-repository.js";

export { OperationalFaultRepository } from "../repositories/operational-fault-repository.js";

export {
  savePricingConfiguration,
  PricingConfigurationError,
} from "../repositories/quota-pricing-configuration.js";

export { archiveDispatchPolicy } from "../repositories/dispatch-policy-archive.js";

export {
  listPricingReadyRoutes,
  policyPricingReadiness,
} from "../repositories/dispatch-pricing-readiness.js";

export { PricingModeConflictError } from "../repositories/pricing-write-guard.js";

export { sumAllocatedQuota } from "../repositories/dashboard-breakdown.js";
