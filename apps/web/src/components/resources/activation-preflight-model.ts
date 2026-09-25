/**
 * 资金账本初始化预检结果与候选时效的纯模型（WP05 任务 5.3、5.4、5.5）。
 *
 * 三件事在这里收口，全部为纯函数以便单测：
 *  1. **结构化缺口**（PFU-03）：按类别分组，并给出资源 / 账户 / 旧记录 / 月份定位串；
 *  2. **可激活状态的生命周期**（PFU-03 Candidate becomes stale）：候选过期、候选被取代、
 *     候选哈希变化、事实水位漂移、服务端返回 `CANDIDATE_STALE` 时**立即清除**可激活状态；
 *  3. **静默与排空门禁**（PFA-09、PFU-04）：把租约与排空计数翻译成可执行的勾选清单。
 */

import type {
  ActivationCandidateMetadata,
  ActivationDecision,
  ActivationGapCategory,
  ActivationGapCode,
  ActivationGapView,
  ActivationReceiptView,
  QuiescenceView,
} from "../../api/provider-finance-activation-types";

// ===== 缺口标签与分组 =====

export const GAP_CATEGORY_ORDER: readonly ActivationGapCategory[] = [
  "SCOPE", "OPENING_BALANCE", "RECHARGE", "PURCHASE", "PERIOD",
  "LEGACY_RECORD", "USAGE", "TOKEN", "BALANCE", "OPERATING_BILL", "QUIESCENCE",
];

export const GAP_CATEGORY_LABELS: Record<ActivationGapCategory, string> = {
  SCOPE: "激活范围",
  OPENING_BALANCE: "API 期初余额",
  RECHARGE: "历史 API 充值",
  PURCHASE: "Coding Plan 购买",
  PERIOD: "服务周期归属",
  LEGACY_RECORD: "旧购买记录关闭",
  USAGE: "用量费用状态",
  TOKEN: "Token 守恒",
  BALANCE: "余额守恒",
  OPERATING_BILL: "经营账单完整性",
  QUIESCENCE: "静默与排空",
};

const GAP_CODE_LABELS: Partial<Record<ActivationGapCode, string>> = {
  MISSING_OPENING_BALANCE: "必要币种账户缺少原始期初余额",
  DUPLICATE_OPENING_BALANCE: "同一账户存在多条原始期初",
  MISSING_OPENING_EVIDENCE: "期初缺少说明或证据引用",
  OPENING_TIME_MISMATCH: "期初时点不是资金切换时点",
  RESOURCE_MODE_MISMATCH: "事实与资源模式不匹配",
  UNKNOWN_RESOURCE: "草稿引用了激活范围外的资源",
  REQUIRED_CURRENCY_UNRESOLVED: "无法确定必要币种集合",
  MISSING_RECHARGE_AMOUNT: "历史充值缺少到账金额",
  MISSING_RECHARGE_CASH_PAID: "历史充值缺少人民币实付",
  MISSING_PURCHASE_AMOUNT: "购买缺少原币金额",
  MISSING_PURCHASE_CASH_PAID: "购买缺少人民币实付",
  MISSING_EVIDENCE: "缺少证据引用",
  UNATTRIBUTED_PLAN_USAGE: "Coding Plan 用量无法唯一归属周期",
  OVERLAPPING_PERIOD: "存在重叠且归属不唯一的周期",
  INVALID_SERVICE_PERIOD: "扣费日期必须等于服务开始日",
  LEGACY_RECORD_UNCLOSED: "旧购买记录没有唯一关闭结果",
  LEGACY_RECORD_UNKNOWN: "关闭决定引用了范围外的旧购买记录",
  LEGACY_MIGRATION_REFERENCE_MISSING: "MIGRATED 缺少外部订单引用",
  LEGACY_REPRESENTATION_MISMATCH: "ALREADY_REPRESENTED 引用的资金事件语义不匹配",
  LEGACY_REJECTION_EVIDENCE_MISSING: "拒绝关闭缺少原因或证据",
  UNKNOWN_COST: "API 用量费用状态未明确（UNKNOWN_COST）",
  MISSING_API_CURRENCY: "已定价 API 用量缺少结算币种",
  CONFLICTING_API_CURRENCY: "结算币种与计价快照冲突",
  MISSING_SETTLEMENT_TIME: "用量缺少结算时间",
  TOKEN_CONSERVATION_MISMATCH: "Usage 与 Ledger Token 不守恒",
  BALANCE_FORMULA_MISMATCH: "余额公式不守恒",
  NEGATIVE_BALANCE: "余额为负",
  INCOMPLETE_OPERATING_BILL: "涉及月份的经营账单不完整",
  NOT_QUIESCENT: "企业静默或排空条件不满足",
  RESOURCE_FINANCE_NOT_READY: "资源资金未就绪",
};

export function gapCodeLabel(gap: ActivationGapView): string {
  return GAP_CODE_LABELS[gap.code] ?? gap.message;
}

/**
 * `UNKNOWN_COST` 缺口（PFH-02 Scenario: Rejection cannot close unknown usage cost）。
 * 这类缺口**不能**被任何 `REJECTED_WITH_EVIDENCE` 决定关闭，UI 必须始终原样展示，
 * 且不得提供任何「忽略/关闭」入口。
 */
export function isUnknownCostGap(gap: ActivationGapView): boolean {
  return gap.code === "UNKNOWN_COST";
}

export interface GapGroup {
  category: ActivationGapCategory;
  label: string;
  gaps: ActivationGapView[];
}

/** 按类别分组并保持确定性顺序（与领域层 `compareActivationGaps` 的意图一致）。 */
export function groupGapsByCategory(gaps: readonly ActivationGapView[]): GapGroup[] {
  return GAP_CATEGORY_ORDER
    .map((category) => ({
      category, label: GAP_CATEGORY_LABELS[category],
      gaps: gaps.filter((gap) => gap.category === category),
    }))
    .filter((group) => group.gaps.length > 0);
}

/** 缺口定位串：资源 / 币种 / 月份 / 旧记录 / 用量行，用于「定位到草稿行或事实类别」。 */
export function gapLocator(gap: ActivationGapView, resourceLabel: (resourceId: string) => string): string {
  const parts: string[] = [];
  if (gap.resourceId) parts.push(resourceLabel(gap.resourceId));
  if (gap.accountCurrency) parts.push(gap.accountCurrency);
  if (gap.month) parts.push(gap.month);
  if (gap.legacyRecordId) parts.push(`旧记录 ${gap.legacyRecordId.slice(0, 8)}`);
  if (gap.ledgerLineId) parts.push(`用量行 ${gap.ledgerLineId.slice(0, 8)}`);
  return parts.length === 0 ? "企业级" : parts.join(" · ");
}

// ===== 可激活状态的生命周期（PFU-03） =====

export interface PreviewHold {
  candidateId: string;
  candidateHash: string;
  factWatermarkHash: string;
  expiresAt: string;
  decision: ActivationDecision;
}

export interface HoldEvaluation {
  /** 是否允许提交激活。 */
  activatable: boolean;
  /** 不可激活时给管理员的原因（同时用于提示「需重新预检」）。 */
  reason: string | null;
  /** 是否属于「候选已失效」，调用方应清除持有的候选并强制重新预检。 */
  cleared: boolean;
}

const NOT_PREVIEWED: HoldEvaluation = { activatable: false, reason: "尚未执行预检", cleared: false };

export interface HoldAuthorityContext {
  /**
   * `latest` 读模型是否**新于**本次预检，即服务端已经确认过该候选。
   *
   * 预检成功会写候选元数据并触发 `activation-state` 失效刷新；在刷新返回之前，
   * 容器拿到的 `latest_candidate` 仍是**预检之前**的旧值（首次预检为 `null`）。
   * 此时不能据旧值判定候选失效，否则刚拿到的 GO 候选会被同帧清除、激活按钮永久禁用。
   *
   * 默认 `true`（视为权威），保持既有调用语义不变。
   */
  latestAuthoritative?: boolean;
}

/**
 * 判定持有的候选是否仍可激活。
 *
 * `cleared=true` 表示候选已经不可能被激活（过期 / 被取代 / 哈希或水位漂移 / 服务端已失效），
 * 调用方必须**立即清除**可激活状态并提示重新预检，不得继续用旧候选提交（PFU-03）。
 *
 * `context.latestAuthoritative === false` 时读模型尚未反映本次预检：判「未知」而非「已失效」，
 * **不清除**候选并允许进入二次确认——服务端激活事务会在 SERIALIZABLE 事务内独立复核
 * 候选存在性、哈希、事实水位与草稿一致性（`CANDIDATE_NOT_FOUND` / `CANDIDATE_STALE`），
 * 因此这里放宽不会削弱失败关闭语义，只消除 UI 侧的假阳性失效判定。
 */
export function evaluateHold(
  hold: PreviewHold | null,
  latest: ActivationCandidateMetadata | null,
  nowMs: number,
  context: HoldAuthorityContext = {},
): HoldEvaluation {
  if (hold === null) return NOT_PREVIEWED;
  if (hold.decision !== "GO_CANDIDATE") {
    return { activatable: false, reason: "预检结论为 NO_GO：请按缺口补齐草稿后重新预检", cleared: false };
  }
  if (nowMs >= Date.parse(hold.expiresAt)) {
    return { activatable: false, reason: "候选已过期（TTL 30 分钟），请重新预检", cleared: true };
  }
  if (context.latestAuthoritative === false) {
    return { activatable: true, reason: null, cleared: false };
  }
  if (latest === null) {
    return { activatable: false, reason: "服务端已无该候选记录，请重新预检", cleared: true };
  }
  if (latest.candidate_id !== hold.candidateId) {
    return { activatable: false, reason: "候选已被更新的预检取代，请重新预检", cleared: true };
  }
  if (latest.expired) {
    return { activatable: false, reason: "候选已过期，请重新预检", cleared: true };
  }
  if (latest.status !== "PREVIEWED") {
    return { activatable: false, reason: `候选状态为 ${latest.status}，不可再次激活`, cleared: true };
  }
  if (latest.candidate_hash !== hold.candidateHash) {
    return { activatable: false, reason: "候选哈希已变化，请重新预检", cleared: true };
  }
  if (latest.fact_watermark_hash !== hold.factWatermarkHash) {
    return { activatable: false, reason: "事实水位已漂移，请重新预检", cleared: true };
  }
  return { activatable: true, reason: null, cleared: false };
}

/**
 * 服务端失败码是否需要清除候选（失败关闭，PFU-03 / PFU-04）。
 * `ACTIVATION_RETRY_REQUIRED` **不在**其中：事务已整体回滚且候选仍然有效，
 * 管理员可用**同一个幂等键**人工重试。
 */
const HOLD_CLEARING_CODES = new Set([
  "activation_candidate_stale", "activation_candidate_expired",
  "activation_candidate_not_found", "activation_candidate_not_ready",
]);

export function shouldClearHoldForError(errorCode: string | null): boolean {
  return errorCode !== null && HOLD_CLEARING_CODES.has(errorCode);
}

/** 激活失败码 → 管理员可读提示。覆盖全部 409 语义，未知码回退到服务端消息。 */
const ACTIVATION_ERROR_MESSAGES: Record<string, string> = {
  invalid_request: "请求参数不合法，请检查草稿后重试",
  activation_not_quiescent: "企业静默或排空未完成，无法预检或激活",
  activation_in_progress: "已有激活事务在进行中，请稍后重试",
  activation_retry_required: "事务已回滚，可人工重试",
  activation_candidate_stale: "事实水位或候选已变化，请重新预检",
  activation_candidate_expired: "候选已过期，请重新预检",
  activation_candidate_not_found: "候选不存在或不属于本企业，请重新预检",
  activation_candidate_not_ready: "候选不是可激活的 GO_CANDIDATE",
  already_activated: "企业已完成激活，无需重复激活",
  idempotency_conflict: "该幂等键已绑定其他候选，请重新预检后再激活",
  session_enterprise_mismatch: "确认企业与当前会话企业不一致，已拒绝",
  activation_contract_conflict: "以现有事实无法完成激活，请重新预检",
  resource_finance_not_ready: "存在资金未就绪的资源",
  resource_finance_conflict: "资源资金事实冲突",
};

export function activationErrorMessage(errorCode: string | null, fallback: string): string {
  return (errorCode === null ? undefined : ACTIVATION_ERROR_MESSAGES[errorCode]) ?? fallback;
}

// ===== 静默与排空（PFA-09、PFU-04） =====

export const QUIESCENCE_MIN_REMAINING_SECONDS = 300;

export interface QuiescenceGate {
  ready: boolean;
  blockers: string[];
}

/**
 * **预检门**阻断项 —— 与 `assertPrePreviewQuiescent` 同形：租约有效性、剩余时间，
 * 以及三类**永不豁免**的在途工作（在途请求 / 未结束上游尝试 / 待结算账本事务）。
 *
 * 注意这里**不含**未配对用量行：服务端对未配对用量行的排空判定发生在只读投影**之后**，
 * 且会用一个豁免集（候选自己冻结、将在同一激活事务内确定性修复的行）重算
 * （`assertDrainedForCandidate`）。若把它当作预检前置条件，首次预检将永远无法进行，
 * 而这恰恰是初始化功能存在的场景。
 */
export function prePreviewBlockers(quiescence: QuiescenceView): string[] {
  const blockers: string[] = [];
  const { drain } = quiescence;
  if (!quiescence.active) blockers.push("静默租约未启动或已到期");
  if (quiescence.active && quiescence.insufficient_for_activation) {
    blockers.push(`静默租约剩余时间不足 ${QUIESCENCE_MIN_REMAINING_SECONDS / 60} 分钟`);
  }
  if (drain.in_progress_requests > 0) blockers.push(`仍有 ${drain.in_progress_requests} 个在途请求未排空`);
  if (drain.open_attempts > 0) blockers.push(`仍有 ${drain.open_attempts} 个未结束上游尝试`);
  if (drain.pending_ledger_transactions > 0) {
    blockers.push(`仍有 ${drain.pending_ledger_transactions} 笔待结算账本事务`);
  }
  return blockers;
}

/**
 * **落库门**阻断项 —— 与 `assertDrainedForCandidate` 同形：未配对用量行。
 * 这些行会在预检内按候选修复集豁免后重算，因此只作展示与解释，不阻断预检。
 */
export function prePersistBlockers(quiescence: QuiescenceView): string[] {
  const { drain } = quiescence;
  if (drain.unpaired_usage_lines > 0) {
    return [`仍有 ${drain.unpaired_usage_lines} 条未配对用量行（预检时会按候选的确定性修复集重算）`];
  }
  return [];
}

/** 展示用阻断项全集（预检门 + 落库门）。 */
export function quiescenceBlockers(quiescence: QuiescenceView): string[] {
  return [...prePreviewBlockers(quiescence), ...prePersistBlockers(quiescence)];
}

/** 决定「是否可以开始预检」的门：只看预检门。 */
export function evaluateQuiescenceGate(quiescence: QuiescenceView): QuiescenceGate {
  const blockers = prePreviewBlockers(quiescence);
  return { ready: blockers.length === 0, blockers };
}

export function formatRemainingSeconds(seconds: number): string {
  if (seconds <= 0) return "已到期";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

// ===== 回执摘要（PFU-01、PFU-04） =====

export function receiptFactCountSummary(receipt: ActivationReceiptView): string {
  const counts = receipt.factCounts;
  return [
    `期初 ${counts.openings}`, `历史充值 ${counts.recharges}`, `购买/续费 ${counts.purchases}`,
    `跨切换周期 ${counts.carryovers}`, `旧记录关闭 ${counts.legacyResolutions}`,
    `用量修复 ${counts.usageRepairs}`,
  ].join(" · ");
}
