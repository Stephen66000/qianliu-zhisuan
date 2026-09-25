/**
 * @qianliu/database 子导出：资金账本与运营账单域。
 *
 * 由 src/index.ts 按域拆分而来（质量门禁单文件上限）；src/index.ts 以 `export *`
 * 再导出本模块，包对外导出面与历史调用点保持不变。
 *
 * 本文件只做再导出，不含实现，新增导出必须归入对应域子模块而非重新堆回 index.ts。
 */
export { countFinanceGaps } from "../repositories/provider-finance-gaps.js";

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
} from "../repositories/operating-bill-repository.js";

export {
  loadMonthlyOperatingCosts,
  type ApiSpendStatus,
  type MonthlyOperatingCosts,
  type MonthlyOperatingCostResource,
  type MonthlyOperatingCostSummary,
} from "../repositories/monthly-operating-cost.js";

export {
  acquireOperatingBillMonthWriteBarrier,
  guardOperatingBillLedgerWrite,
  operatingBillMonthAt,
} from "../repositories/operating-bill-write-barrier.js";

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
} from "../repositories/department-cost-evidence.js";

export type {
  DepartmentBillView,
  DepartmentBudgetView,
  DepartmentBudgetStatus,
  DepartmentCostRow,
} from "../repositories/department-cost-types.js";

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
} from "../repositories/operating-bill-account-repository.js";

export { ProviderFinanceRepository } from "../repositories/provider-finance-repository.js";

export { ProviderFinanceCutoverRepository } from "../repositories/provider-finance-cutover-repository.js";

export { ProviderFinanceActivationRepository } from "../repositories/provider-finance-activation-repository.js";

export {
  isEnterpriseQuiescent,
  listQuiescentEnterpriseIds,
  loadQuiescenceGate,
  type QuiescenceGate,
} from "../repositories/provider-finance-quiescence.js";

export {
  ProviderFinanceActivationPreviewRepository,
  type ActivationPreviewResult,
  type PreviewActivationInput,
  type ReadOnlyCandidateProjection,
} from "../repositories/provider-finance-activation-preview.js";

export {
  ProviderFinanceActivationCoordinator,
  mapActivationFailure,
  type ActivateInput,
  type ActivationOutcome,
} from "../repositories/provider-finance-activation-coordinator.js";

export {
  applyUsageRepairsTx,
  usageRepairColumn,
  type UsageRepairApplyInput,
  type UsageRepairApplyResult,
} from "../repositories/provider-finance-usage-repairs.js";

export {
  assertSameShanghaiDay,
  assertShanghaiMidnight,
  closeLegacyPurchaseTx,
  insertCarryoverPeriodTx,
  insertFinanceEventTx,
  insertOpeningBalanceTx,
  insertRechargeTx,
  insertSubscriptionTx,
  LEGACY_PURCHASE_MARKER_PREFIX,
  legacySourceMarker,
  shanghaiDayOf,
  writeActivationAuditTx,
  type ActivationAuditWriteInput,
  type CarryoverPeriodWriteInput,
  type FinanceEventInsert,
  type LegacyPurchaseClosureWriteInput,
  type OpeningBalanceWriteInput,
  type SubscriptionWriteInput,
} from "../repositories/provider-finance-activation-writes.js";

export {
  buildFactWatermark,
  FACT_WATERMARK_SECTIONS,
  loadActivationScope,
  loadLedgerLines,
  loadProjectionFacts,
  type ActivationScope,
  type FactWatermarkSectionName,
  type ProjectionFacts,
} from "../repositories/provider-finance-activation-facts.js";

export {
  loadBalanceFactTotals,
  loadOpenReconciliationCaseId,
  loadUnknownCostRows,
  toBalanceComponents,
  type BalanceFactTotals,
  type BalanceFactWindow,
  type UnknownCostRow,
} from "../repositories/provider-finance-balance-facts.js";

export {
  assessResourceFinanceEnablement,
  evaluateResourceEnablementDecision,
  type ResourceBalanceEvidence,
  type ResourceEnablementAssessment,
  type ResourceEnablementBlocker,
  type ResourceEnablementBlockerCode,
} from "../repositories/provider-finance-resource-enablement.js";

export {
  ProviderFinanceActivationError,
  type ActivationCandidateView,
  type MarkResourceFinanceReadyInput,
  type PendingResourceCheck,
  type ProviderFinanceActivationErrorCode,
  type QuiescenceDrainReport,
  type QuiescenceLeaseRow,
  type RecordActivationCandidateInput,
  type ResourceFinanceStateView,
  type StartQuiescenceInput,
} from "../repositories/provider-finance-activation-types.js";

export type {
  FinanceCarryoverCandidate,
  FinanceConservationReport,
  FinanceOpeningCandidate,
  FinancePreflightReport,
  FinancePurchaseCandidate,
  FinanceUsageBackfillReport,
  LegacyApiCostResolutionInput,
  LegacyApiCostResolutionView,
} from "../repositories/provider-finance-cutover-types.js";

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
} from "../repositories/provider-finance-types.js";

export { loadOperatingAnalysis } from "../repositories/operating-analysis-repository.js";

export {
  readPrincipalAccounting,
  savePrincipalAccounting,
  savePrincipalAccountingInTransaction,
  PrincipalAccountingError,
} from "../repositories/principal-accounting.js";

export { loadOperatingDepartmentAccounts } from "../repositories/operating-department-accounts.js";

export { previewPrincipalAttributionBackfill, confirmPrincipalAttributionBackfill } from "../repositories/principal-attribution-backfill.js";

export { getSubscriptionAutoRenewal, cancelSubscriptionAutoRenewal, renewDueSubscription, runSubscriptionAutoRenewals } from "../repositories/provider-finance-renewal.js";
