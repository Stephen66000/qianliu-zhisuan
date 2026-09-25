/**
 * 资金账本初始化：契约面——固定常量、草稿/规范化类型、结构化缺口、水位与回执类型、
 * 状态机与静默租约判定。
 *
 * 对应 OpenSpec：PFA-01/PFA-03/PFA-06/PFA-09、PFH-01～PFH-05。
 * 本模块由 provider-finance-activation.ts 按「契约面」分段下沉而来；
 * 该文件已超出质量门禁单文件上限。迁移后 `provider-finance-activation.ts`
 * 通过 `export *` 再导出本模块，包对外导出面保持不变。
 *
 * 工程约束（计划 v1.2 §5、design §4～§6）：
 * - 本模块必须无数据库访问、无时钟读取、无随机数。
 * - 候选哈希只覆盖领域事实与事实水位；展示名称、客户端管理员 ID、激活幂等键、
 *   生成时间、随机候选 ID、UI 排序均不得进入哈希输入。
 */

// ===== 版本与固定常量（PFA-03、PFA-09、PFH-01、PFH-03） =====

/** 候选草稿协议版本；进入候选哈希，任何字段语义变化必须升版。 */
export const PROVIDER_FINANCE_ACTIVATION_SCHEMA_VERSION = "1" as const;

/** 固定资金切换时点（UTC）= Asia/Shanghai 2026-09-01 00:00:00。 */
export const PROVIDER_FINANCE_CUTOVER_ISO = "2026-08-31T16:00:00.000Z" as const;

/** 候选有效期固定 30 分钟，且不因读取、失败或重放滑动续期（PFA-03）。 */
export const ACTIVATION_CANDIDATE_TTL_SECONDS = 1800 as const;

/** 企业级静默租约上限 60 分钟（PFA-09）。 */
export const ACTIVATION_QUIESCENCE_MAX_SECONDS = 3600 as const;

/** 激活开始时静默租约剩余时间下限 5 分钟（PFA-09）。 */
export const ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS = 300 as const;

/** 账户金额标度：八位小数。 */
export const ACTIVATION_ACCOUNT_AMOUNT_SCALE = 8 as const;

/** 人民币实付标度：两位小数。 */
export const ACTIVATION_CASH_PAID_CNY_SCALE = 2 as const;

/** 草稿数组上限（任务 1.1：数组上限使用严格校验）。 */
export const ACTIVATION_MAX_DRAFT_ROWS = 500 as const;

/** 说明与证据长度上限，与既有资金合同保持一致。 */
export const ACTIVATION_DESCRIPTION_MAX_LENGTH = 1000 as const;
export const ACTIVATION_EVIDENCE_MAX_LENGTH = 4000 as const;

export type ActivationCurrency = "CNY" | "USD";
export type ActivationResourceMode = "API" | "CODING_PLAN";

// ===== 草稿契约（任务 1.1） =====

export interface OpeningBalanceDraftItem {
  resource_id: string;
  account_currency: ActivationCurrency;
  account_amount: string;
  occurred_at: string;
  description: string;
  evidence_ref: string;
  source_record_id: string | null;
}

export interface HistoricalRechargeDraftItem {
  resource_id: string;
  account_currency: ActivationCurrency;
  account_amount: string;
  cash_paid_cny: string;
  occurred_at: string;
  external_reference: string;
  description: string;
  evidence_ref: string;
  source_record_id: string;
  record_idempotency_key: string;
}

export interface CodingPlanPurchaseDraftItem {
  resource_id: string;
  kind: "PURCHASE" | "RENEWAL";
  product_name: string;
  account_amount: string;
  account_currency: ActivationCurrency;
  cash_paid_cny: string;
  /** 上海自然日，页面口径的服务开始日。 */
  service_period_start: string;
  /** 上海自然日的服务结束日（含当日）；null 表示采用默认周期。 */
  service_period_end: string | null;
  /** 扣费时间，必须落在服务开始日的上海自然日内。 */
  occurred_at: string;
  external_reference: string;
  auto_renew: boolean;
  description: string;
  evidence_ref: string;
  source_record_id: string | null;
  carryover_snapshot_id: string | null;
  record_idempotency_key: string;
}

export interface CodingPlanCarryoverDraftItem {
  resource_id: string;
  product_name: string;
  /** 跨切换时点的既有周期，上海自然日。 */
  period_start: string;
  /** 上海自然日的结束日（含当日）。 */
  period_end: string;
  snapshot_id: string;
  description: string;
  evidence_ref: string;
}

export type LegacyPurchaseResolutionKind =
  | "MIGRATED" | "ALREADY_REPRESENTED" | "REJECTED_WITH_EVIDENCE";

export interface LegacyPurchaseResolutionDraftItem {
  legacy_record_id: string;
  resource_id: string;
  resolution: LegacyPurchaseResolutionKind;
  /** ALREADY_REPRESENTED 必须引用同企业同资源且语义匹配的资金事件。 */
  finance_event_id: string | null;
  /** MIGRATED 时必须给出外部引用或订单号。 */
  migrated_external_reference: string | null;
  /** REJECTED_WITH_EVIDENCE 必须给出原因与证据。 */
  reason: string | null;
  evidence_ref: string | null;
}

export interface ActivationDraft {
  schema_version: string;
  api_opening_balances: OpeningBalanceDraftItem[];
  historical_api_recharges: HistoricalRechargeDraftItem[];
  coding_plan_purchases: CodingPlanPurchaseDraftItem[];
  coding_plan_carryovers: CodingPlanCarryoverDraftItem[];
  legacy_purchase_resolutions: LegacyPurchaseResolutionDraftItem[];
}

// ===== 规范化候选（任务 1.2） =====

export interface NormalizedOpeningBalance {
  resourceId: string;
  accountCurrency: ActivationCurrency;
  accountAmount: string;
  occurredAt: string;
  description: string;
  evidenceRef: string;
  sourceRecordId: string | null;
}

export interface NormalizedRecharge {
  resourceId: string;
  accountCurrency: ActivationCurrency;
  accountAmount: string;
  cashPaidCny: string;
  occurredAt: string;
  externalReference: string;
  description: string;
  evidenceRef: string;
  sourceRecordId: string;
  recordIdempotencyKey: string;
}

export interface NormalizedCodingPlanPurchase {
  resourceId: string;
  kind: "PURCHASE" | "RENEWAL";
  productName: string;
  accountAmount: string;
  accountCurrency: ActivationCurrency;
  cashPaidCny: string;
  servicePeriodStart: string;
  servicePeriodEndInclusive: string;
  periodStart: string;
  periodEndExclusive: string;
  occurredAt: string;
  externalReference: string;
  autoRenew: boolean;
  description: string;
  evidenceRef: string;
  sourceRecordId: string | null;
  carryoverSnapshotId: string | null;
  recordIdempotencyKey: string;
}

export interface NormalizedCodingPlanCarryover {
  resourceId: string;
  productName: string;
  periodStart: string;
  periodEndExclusive: string;
  snapshotId: string;
  description: string;
  evidenceRef: string;
}

export interface NormalizedLegacyPurchaseResolution {
  legacyRecordId: string;
  resourceId: string;
  resolution: LegacyPurchaseResolutionKind;
  financeEventId: string | null;
  migratedExternalReference: string | null;
  reason: string | null;
  evidenceRef: string | null;
}

export interface NormalizedActivationCandidate {
  schemaVersion: string;
  cutoverAt: string;
  apiOpeningBalances: NormalizedOpeningBalance[];
  historicalApiRecharges: NormalizedRecharge[];
  codingPlanPurchases: NormalizedCodingPlanPurchase[];
  codingPlanCarryovers: NormalizedCodingPlanCarryover[];
  legacyPurchaseResolutions: NormalizedLegacyPurchaseResolution[];
}

// ===== 结构化缺口（PFA-02、PFU-03） =====

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

export interface ActivationGap {
  code: ActivationGapCode;
  category: ActivationGapCategory;
  message: string;
  resourceId: string | null;
  accountCurrency: ActivationCurrency | null;
  legacyRecordId: string | null;
  ledgerLineId: string | null;
  month: string | null;
  detail: string | null;
}

/** 确定性缺口排序：同一候选的缺口列表不依赖查询顺序（PFU-03）。 */
export function compareActivationGaps(left: ActivationGap, right: ActivationGap): number {
  const keys: Array<keyof ActivationGap> = [
    "category", "code", "resourceId", "accountCurrency", "legacyRecordId", "ledgerLineId", "month", "message",
  ];
  for (const key of keys) {
    const a = left[key] ?? "";
    const b = right[key] ?? "";
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

export function sortActivationGaps(gaps: readonly ActivationGap[]): ActivationGap[] {
  return [...gaps].sort(compareActivationGaps);
}

export function summarizeActivationGaps(gaps: readonly ActivationGap[]): Array<{ code: ActivationGapCode; count: number }> {
  const counts = new Map<ActivationGapCode, number>();
  for (const gap of gaps) counts.set(gap.code, (counts.get(gap.code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

// ===== 事实水位（PFA-01、PFA-03） =====

export interface FactWatermarkSection {
  /** 稳定分段名，例如 provider_resource / ledger_line。 */
  section: string;
  /** 该分段参与摘要的事实行数。 */
  count: number;
  /** 该分段业务关键字段稳定排序后的 SHA-256。 */
  digest: string;
}

export interface FactWatermark {
  sections: FactWatermarkSection[];
  hash: string;
}

// ===== 历史修复基准（PFH-04） =====

export const USAGE_REPAIR_FIELDS = [
  "settled_at", "api_cost_currency", "api_cost_status", "subscription_period_id",
] as const;

export type UsageRepairField = (typeof USAGE_REPAIR_FIELDS)[number];

export interface UsageRepairBaselineRow {
  ledgerLineId: string;
  eligibleRepairs: UsageRepairField[];
  targetFieldsBeforeHash: string;
  nonTargetFieldsBeforeHash: string;
}

export interface UsageRepairSummary {
  eligibleRows: number;
  eligibleByField: Record<UsageRepairField, number>;
  newRowsAfterPreview: number;
  nonTargetHashMismatches: number;
}

export function sortUsageRepairBaseline(rows: readonly UsageRepairBaselineRow[]): UsageRepairBaselineRow[] {
  return [...rows].sort((a, b) => (a.ledgerLineId < b.ledgerLineId ? -1 : a.ledgerLineId > b.ledgerLineId ? 1 : 0));
}

// ===== 余额投影摘要（PFH-05） =====

export interface ProjectedAccountBalance {
  resourceId: string;
  currency: ActivationCurrency;
  openingBalance: string;
  openingCorrections: string;
  recharges: string;
  usageDebits: string;
  balanceReconciliations: string;
  legacyCostAdjustments: string;
  reversals: string;
  balance: string;
  formulaMatches: boolean;
}

export interface ProjectedFinanceSummary {
  accounts: ProjectedAccountBalance[];
  monthsChecked: string[];
  tokenConserved: boolean;
  codingPlanUsageAttributed: boolean;
  operatingBillsComplete: boolean;
}

// ===== 激活回执（PFA-04、PFA-06） =====

export interface ActivationReceipt {
  candidateId: string;
  candidateHash: string;
  factWatermarkHash: string;
  activatedAt: string;
  activatedByAdminUserId: string;
  factCounts: {
    openings: number;
    recharges: number;
    purchases: number;
    carryovers: number;
    legacyResolutions: number;
    usageRepairs: number;
  };
  monthsChecked: string[];
  conservationPassed: boolean;
  conservationFailures: Array<{ code: string; count: number }>;
}

export type ActivationDecision = "GO_CANDIDATE" | "NO_GO";
export type ActivationCandidateStatus = "PREVIEWED" | "ACTIVATED" | "EXPIRED" | "REJECTED";

/** 状态机白名单：不存在持久化 ACTIVATING（PFA-04）。 */
export const ACTIVATION_CANDIDATE_TRANSITIONS: Record<ActivationCandidateStatus, readonly ActivationCandidateStatus[]> = {
  PREVIEWED: ["ACTIVATED", "EXPIRED", "REJECTED"],
  ACTIVATED: [],
  EXPIRED: [],
  REJECTED: [],
};

export function canTransitionCandidateStatus(
  from: ActivationCandidateStatus, to: ActivationCandidateStatus,
): boolean {
  return ACTIVATION_CANDIDATE_TRANSITIONS[from].includes(to);
}

// ===== 资源级资金就绪（PFH-07） =====

export type ResourceFinanceState = "PENDING" | "READY";

// ===== 静默租约（PFA-09） =====

export interface QuiescenceLeaseView {
  enterpriseId: string;
  status: "ACTIVE" | "RELEASED" | "EXPIRED";
  startedAt: string;
  expiresAt: string;
}

export interface QuiescenceEvaluation {
  /** 服务端时间判断：ACTIVE 且未过期。 */
  active: boolean;
  remainingSeconds: number;
  /** 剩余时间不足激活下限，需重新建立静默期。 */
  insufficientForActivation: boolean;
}

export function evaluateQuiescenceLease(
  lease: Pick<QuiescenceLeaseView, "status" | "expiresAt"> | null,
  now: Date,
  minRemainingSeconds: number = ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS,
): QuiescenceEvaluation {
  if (!lease || lease.status !== "ACTIVE") {
    return { active: false, remainingSeconds: 0, insufficientForActivation: true };
  }
  const remaining = Math.floor((new Date(lease.expiresAt).getTime() - now.getTime()) / 1000);
  if (remaining <= 0) {
    return { active: false, remainingSeconds: 0, insufficientForActivation: true };
  }
  return {
    active: true,
    remainingSeconds: remaining,
    insufficientForActivation: remaining < minRemainingSeconds,
  };
}
