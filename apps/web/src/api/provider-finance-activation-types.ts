/**
 * 资金账本初始化激活接口的 HTTP 合同类型（WP05；对接 WP04 的 control-api 路由）。
 *
 * 命名约定：HTTP 面（`activation-state` / `activation-preview` / `activation-quiescence`）
 * 统一使用 snake_case；只有少数**透传的领域对象**保持 camelCase ——
 * 激活回执 `ActivationReceipt` 与投影摘要 `ProjectedFinanceSummary` 由领域层构造后
 * 原样存入 `activation_result` / `projection_summary` 并原样返回，服务端不做字段改名。
 * 因此本文件的类型严格照抄服务端实际返回，不做「统一命名」的二次加工。
 *
 * 安全：请求体一律不含 `enterprise_id` / `admin_id`；权威企业与管理员只来自认证会话（PFA-07）。
 */

export type ProviderFinanceActivationMode = "OFF" | "DARK" | "ACTIVE";
export type ActivationDecision = "GO_CANDIDATE" | "NO_GO";
export type ActivationCandidateStatus = "PREVIEWED" | "ACTIVATED" | "EXPIRED" | "REJECTED";

export type ActivationGapCategory =
  | "OPENING_BALANCE" | "RECHARGE" | "PURCHASE" | "PERIOD" | "LEGACY_RECORD"
  | "USAGE" | "TOKEN" | "BALANCE" | "OPERATING_BILL" | "QUIESCENCE" | "SCOPE";

export type ActivationGapCode =
  | "MISSING_OPENING_BALANCE" | "DUPLICATE_OPENING_BALANCE" | "MISSING_OPENING_EVIDENCE"
  | "OPENING_TIME_MISMATCH" | "RESOURCE_MODE_MISMATCH" | "UNKNOWN_RESOURCE"
  | "REQUIRED_CURRENCY_UNRESOLVED" | "MISSING_RECHARGE_AMOUNT" | "MISSING_RECHARGE_CASH_PAID"
  | "MISSING_PURCHASE_AMOUNT" | "MISSING_PURCHASE_CASH_PAID" | "MISSING_EVIDENCE"
  | "UNATTRIBUTED_PLAN_USAGE" | "OVERLAPPING_PERIOD" | "INVALID_SERVICE_PERIOD"
  | "LEGACY_RECORD_UNCLOSED" | "LEGACY_RECORD_UNKNOWN" | "LEGACY_MIGRATION_REFERENCE_MISSING"
  | "LEGACY_REPRESENTATION_MISMATCH" | "LEGACY_REJECTION_EVIDENCE_MISSING"
  | "UNKNOWN_COST" | "MISSING_API_CURRENCY" | "CONFLICTING_API_CURRENCY"
  | "MISSING_SETTLEMENT_TIME" | "TOKEN_CONSERVATION_MISMATCH"
  | "BALANCE_FORMULA_MISMATCH" | "NEGATIVE_BALANCE" | "INCOMPLETE_OPERATING_BILL"
  | "NOT_QUIESCENT" | "RESOURCE_FINANCE_NOT_READY";

/**
 * 结构化缺口（PFU-03）：按资源、账户、旧记录、月份与缺口类别定位到具体事实。
 *
 * 注意：`activation-preview` 响应中的 `gaps` 是**领域对象原样透传**（`preview.gaps`），
 * 因此这里是 domain 的 `ActivationGap` 形状（camelCase），不是 snake_case。
 */
export interface ActivationGapView {
  code: ActivationGapCode;
  category: ActivationGapCategory;
  message: string;
  resourceId: string | null;
  accountCurrency: "CNY" | "USD" | null;
  legacyRecordId: string | null;
  ledgerLineId: string | null;
  month: string | null;
  detail: string | null;
}

/** 候选元数据（任务 4.1 脱敏投影）：不含草稿载荷、证据引用与逐行修复基准。 */
export interface ActivationCandidateMetadata {
  candidate_id: string;
  candidate_hash: string;
  fact_watermark_hash: string;
  decision: ActivationDecision;
  status: ActivationCandidateStatus;
  created_at: string;
  expires_at: string;
  expired: boolean;
  created_by_admin_user_id: string;
  gap_summary: Array<{ code: string; count: number }>;
  activated_at: string | null;
  activated_by_admin_user_id: string | null;
}

/** 激活范围摘要（activation-state）：来自最近候选存档的投影摘要。 */
export interface ActivationScopeSummaryView {
  account_count: number;
  required_accounts: Array<{ resource_id: string; currency: "CNY" | "USD" }>;
  months_checked: string[];
  token_conserved: boolean;
  coding_plan_usage_attributed: boolean;
  operating_bills_complete: boolean;
  usage_repair_rows: number;
}

/** 预检返回的范围摘要（activation-preview）：直接透传数据库层 `scopeSummary`。 */
export interface ActivationPreviewScopeSummaryView {
  apiResources: number;
  codingPlanResources: number;
  requiredAccounts: number;
  legacyRecords: number;
  months: string[];
}

export interface QuiescenceDrainView {
  in_progress_requests: number;
  open_attempts: number;
  unpaired_usage_lines: number;
  pending_ledger_transactions: number;
  exonerated_usage_lines: number;
  drained: boolean;
}

export interface QuiescenceLeaseView {
  status: string | null;
  started_at: string | null;
  expires_at: string | null;
  started_by_admin_user_id: string | null;
  released_at: string | null;
  release_reason: string | null;
}

/**
 * 静默视图（`activation-state.quiescence` 与 `activation-quiescence.quiescence`）。
 *
 * 服务端 `quiescenceView` **不**返回 `started_by_admin_user_id`
 * （该字段只出现在 `lease` 视图里），因此这里**不**继承 `QuiescenceLeaseView`。
 */
export interface QuiescenceView {
  status: string | null;
  active: boolean;
  started_at: string | null;
  expires_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  remaining_seconds: number;
  insufficient_for_activation: boolean;
  drain: QuiescenceDrainView;
}

/** `activation-quiescence` 的 `{ lease }` 视图（启动/解除/查询三处同形）。 */
export interface QuiescenceEnvelopeView {
  lease: QuiescenceLeaseView | null;
}

/** 激活回执（领域形状，服务端原样透传）。 */
export interface ActivationReceiptView {
  candidateId: string;
  candidateHash: string;
  factWatermarkHash: string;
  activatedAt: string;
  activatedByAdminUserId: string;
  factCounts: {
    openings: number; recharges: number; purchases: number;
    carryovers: number; legacyResolutions: number; usageRepairs: number;
  };
  monthsChecked: string[];
  conservationPassed: boolean;
  conservationFailures: Array<{ code: string; count: number }>;
}

export interface ActivationStateView {
  mode: ProviderFinanceActivationMode;
  cutover_at: string;
  strict_writes_enabled: boolean;
  scope_summary: ActivationScopeSummaryView | null;
  quiescence: QuiescenceView;
  latest_candidate: ActivationCandidateMetadata | null;
  activation_receipt: ActivationReceiptView | null;
  activated_at: string | null;
  activated_by_admin_user_id: string | null;
}

/** 投影账户余额（`ProjectedFinanceSummary.accounts`，领域 camelCase 透传）。 */
export interface ProjectedAccountBalanceView {
  resourceId: string;
  currency: "CNY" | "USD";
  openingBalance: string;
  openingCorrections: string;
  recharges: string;
  usageDebits: string;
  balanceReconciliations: string;
  legacyCostAdjustments: string;
  reversals: string;
  balance: string;
}

export interface ProjectedFinanceSummaryView {
  accounts: ProjectedAccountBalanceView[];
  monthsChecked: string[];
  tokenConserved: boolean;
  codingPlanUsageAttributed: boolean;
  operatingBillsComplete: boolean;
}

export interface UsageRepairSummaryView {
  eligibleRows: number;
  eligibleByField: Record<string, number>;
  newRowsAfterPreview: number;
  nonTargetHashMismatches: number;
}

export interface ActivationPreviewView {
  candidate_id: string;
  candidate_hash: string;
  fact_watermark_hash: string;
  snapshot_at: string;
  preview_committed_at: string;
  expires_at: string;
  decision: ActivationDecision;
  gaps: ActivationGapView[];
  scope_summary: ActivationPreviewScopeSummaryView;
  usage_repairs: UsageRepairSummaryView;
  projected: ProjectedFinanceSummaryView;
}

export interface ActivationOutcomeView {
  replayed: boolean;
  candidate_id: string;
  receipt: ActivationReceiptView;
}

// ===== 草稿载荷（POST /provider-finance/activation-preview 的请求体） =====

export interface OpeningBalanceDraftPayload {
  resource_id: string;
  account_currency: "CNY" | "USD";
  account_amount: string;
  occurred_at: string;
  description: string;
  evidence_ref: string;
  source_record_id?: string | null;
}

export interface HistoricalRechargeDraftPayload {
  resource_id: string;
  account_currency: "CNY" | "USD";
  account_amount: string;
  cash_paid_cny: string;
  occurred_at: string;
  external_reference: string;
  description: string;
  evidence_ref: string;
  source_record_id: string;
  record_idempotency_key: string;
}

export interface CodingPlanPurchaseDraftPayload {
  resource_id: string;
  kind: "PURCHASE" | "RENEWAL";
  product_name: string;
  account_amount: string;
  account_currency: "CNY" | "USD";
  cash_paid_cny: string;
  service_period_start: string;
  service_period_end?: string | null;
  occurred_at: string;
  external_reference: string;
  auto_renew: boolean;
  description: string;
  evidence_ref: string;
  source_record_id?: string | null;
  carryover_snapshot_id?: string | null;
  record_idempotency_key: string;
}

export interface CodingPlanCarryoverDraftPayload {
  resource_id: string;
  product_name: string;
  period_start: string;
  period_end: string;
  snapshot_id: string;
  description: string;
  evidence_ref: string;
}

export type LegacyResolution = "MIGRATED" | "ALREADY_REPRESENTED" | "REJECTED_WITH_EVIDENCE";

export interface LegacyPurchaseResolutionDraftPayload {
  legacy_record_id: string;
  resource_id: string;
  resolution: LegacyResolution;
  finance_event_id?: string | null;
  migrated_external_reference?: string | null;
  reason?: string | null;
  evidence_ref?: string | null;
}

export interface ActivationDraftPayload {
  schema_version: string;
  api_opening_balances: OpeningBalanceDraftPayload[];
  historical_api_recharges: HistoricalRechargeDraftPayload[];
  coding_plan_purchases: CodingPlanPurchaseDraftPayload[];
  coding_plan_carryovers: CodingPlanCarryoverDraftPayload[];
  legacy_purchase_resolutions: LegacyPurchaseResolutionDraftPayload[];
}

export interface ActivatePayload {
  candidate_id: string;
  candidate_hash: string;
  idempotency_key: string;
  confirm_enterprise_id: string;
}
