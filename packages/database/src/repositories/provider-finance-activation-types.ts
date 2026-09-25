import type {
  ActivationCandidateStatus, ActivationCurrency, ActivationDecision, ActivationDraft,
  ActivationGap, ActivationReceipt, ProjectedFinanceSummary, ResourceFinanceState,
  UsageRepairBaselineRow,
} from "@qianliu/domain";

/** 激活流程错误码：WP04 负责映射为 HTTP 状态与错误体。 */
export type ProviderFinanceActivationErrorCode =
  | "INVALID_REQUEST"
  | "CANDIDATE_NOT_FOUND"
  | "CANDIDATE_EXPIRED"
  | "CANDIDATE_STALE"
  | "CANDIDATE_NOT_READY"
  | "ACTIVATION_IN_PROGRESS"
  | "ACTIVATION_NOT_QUIESCENT"
  | "ACTIVATION_RETRY_REQUIRED"
  | "ALREADY_ACTIVATED"
  | "IDEMPOTENCY_CONFLICT"
  | "SESSION_ENTERPRISE_MISMATCH"
  | "RESOURCE_FINANCE_NOT_READY"
  | "RESOURCE_FINANCE_CONFLICT"
  | "FACT_WRITE_INVALID";

export class ProviderFinanceActivationError extends Error {
  constructor(
    readonly code: ProviderFinanceActivationErrorCode,
    message: string,
    readonly detail?: unknown,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderFinanceActivationError";
  }
}

export interface ActivationCandidateView {
  candidateId: string;
  enterpriseId: string;
  candidateHash: string;
  factWatermarkHash: string;
  decision: ActivationDecision;
  status: ActivationCandidateStatus;
  gaps: Array<{ code: string; count: number }>;
  projection: ProjectedFinanceSummary;
  usageRepairBaseline: UsageRepairBaselineRow[];
  /**
   * 候选业务草稿载荷（0079）。激活接口只接受候选 ID/哈希/幂等键/企业确认，
   * 因此这是激活时唯一可信的草稿来源；读取方**不得**把它直接暴露给客户端
   * （activation-state 只返回元数据，见 WP04 任务 4.1）。
   */
  candidateDraft: ActivationDraft;
  createdByAdminUserId: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  activationIdempotencyKey: string | null;
  activationResult: ActivationReceipt | null;
  activatedByAdminUserId: string | null;
  activatedAt: string | null;
}

export interface RecordActivationCandidateInput {
  enterpriseId: string;
  adminId: string;
  candidateHash: string;
  factWatermarkHash: string;
  decision: ActivationDecision;
  gaps: ActivationGap[];
  gapSummary: Array<{ code: string; count: number }>;
  projection: ProjectedFinanceSummary;
  usageRepairBaseline: UsageRepairBaselineRow[];
  /** 已通过严格 schema 校验并规范化（补 null 默认值）的领域草稿。 */
  candidateDraft: ActivationDraft;
  /** 预检只读事务成功提交后的时间；TTL 固定由此时间加 30 分钟。 */
  previewCommittedAt: Date;
}

export interface QuiescenceLeaseRow {
  enterpriseId: string;
  status: "ACTIVE" | "RELEASED" | "EXPIRED";
  startedByAdminUserId: string;
  startedAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

export interface StartQuiescenceInput {
  enterpriseId: string;
  adminId: string;
  now: Date;
  /** 默认 60 分钟；不得超过 ACTIVATION_QUIESCENCE_MAX_SECONDS。 */
  durationSeconds?: number;
}

export interface ResourceFinanceStateView {
  resourceId: string;
  enterpriseId: string;
  state: ResourceFinanceState;
  requiredCurrencies: ActivationCurrency[];
  readyAt: string | null;
  readyByAdminUserId: string | null;
  version: number;
}

export interface MarkResourceFinanceReadyInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  requiredCurrencies: ActivationCurrency[];
  now: Date;
  /** 乐观并发：与当前 version 不一致时返回 RESOURCE_FINANCE_CONFLICT。 */
  expectedVersion?: number;
}

export interface PendingResourceCheck {
  resourceId: string;
  state: ResourceFinanceState;
}

/** 激活前静默门禁需要排空的在途事实计数（PFA-09）。 */
export interface QuiescenceDrainReport {
  inProgressRequests: number;
  openAttempts: number;
  unpairedUsageLines: number;
  pendingLedgerTransactions: number;
  /**
   * 本次排空实际豁免的「未结算/未分类」行数：即候选已冻结、将在同一激活事务内
   * 被确定性修复的四字段历史用量行。只影响 `unpairedUsageLines`，不影响其余计数。
   */
  exoneratedUsageLines: number;
  drained: boolean;
}
