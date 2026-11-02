/** UI 结构校验与草稿内防重；业务缺口仍由服务端只读投影判定。 */
import {
  ACTIVATION_DESCRIPTION_MAX_LENGTH, ACTIVATION_EVIDENCE_MAX_LENGTH,
  ACTIVATION_MAX_DRAFT_ROWS, ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH,
  ACTIVATION_REASON_MAX_LENGTH, ACTIVATION_RECORD_KEY_MIN_LENGTH,
  ACTIVATION_RECORD_KEY_MAX_LENGTH, countActiveRows,
  isOpeningRowBlank, isRechargeRowBlank, isCostRowBlank,
  isPurchaseRowBlank, isCarryoverRowBlank, isLegacyRowBlank,
  type ActivationDraftState, type DraftIssue, type DraftSection,
  type OpeningRowState, type RechargeRowState, type HistoricalCostRowState,
  type PurchaseRowState, type CarryoverRowState, type LegacyRowState,
} from "./activation-draft-state";

// ===== 格式校验（与服务端正则同形） =====

const ACCOUNT_AMOUNT_PATTERN = /^\d+(?:\.\d{1,8})?$/;
const CASH_PAID_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const SHANGHAI_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAccountAmount(value: string): boolean {
  return ACCOUNT_AMOUNT_PATTERN.test(value);
}

/** 人民币实付：最多两位小数且必须大于 0（服务端 `CashPaidCny`）。 */
export function isValidCashPaidCny(value: string): boolean {
  return CASH_PAID_PATTERN.test(value) && Number(value) > 0;
}

export function isValidShanghaiDay(value: string): boolean {
  return SHANGHAI_DAY_PATTERN.test(value);
}

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** 上海自然日时间输入（`datetime-local`）→ 带偏移的 ISO 瞬时；空值返回 null。 */
export function toInstant(localValue: string): string | null {
  if (localValue.trim() === "") return null;
  const parsed = new Date(`${localValue}:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ===== 单行校验 =====

function requireText(value: string, label: string, maxLength: number): string | null {
  if (value.trim() === "") return `${label}不能为空`;
  if (value.trim().length > maxLength) return `${label}不得超过 ${maxLength} 字`;
  return null;
}

function requireUuid(value: string, label: string): string | null {
  return isValidUuid(value.trim()) ? null : `${label}必须为有效标识`;
}

function requireAccountAmount(value: string, label: string): string | null {
  if (value.trim() === "") return `${label}未填写（空值与 0 不同，如需零值请显式填写 0）`;
  return isValidAccountAmount(value.trim()) ? null : `${label}必须为非负且最多八位小数`;
}

function requireCashPaid(value: string): string | null {
  if (value.trim() === "") return "人民币实付未填写";
  return isValidCashPaidCny(value.trim()) ? null : "人民币实付必须大于 0 且最多两位小数";
}

function requireInstant(value: string, label: string): string | null {
  return toInstant(value) === null ? `${label}必须填写有效的上海时间` : null;
}

function requireShanghaiDay(value: string, label: string): string | null {
  return isValidShanghaiDay(value.trim()) ? null : `${label}必须为 YYYY-MM-DD 上海自然日`;
}

function requireRecordKey(value: string): string | null {
  const length = value.trim().length;
  if (length < ACTIVATION_RECORD_KEY_MIN_LENGTH || length > ACTIVATION_RECORD_KEY_MAX_LENGTH) {
    return `记录级幂等键长度必须为 ${ACTIVATION_RECORD_KEY_MIN_LENGTH}～${ACTIVATION_RECORD_KEY_MAX_LENGTH}`;
  }
  return null;
}

function collect(issues: DraftIssue[], section: DraftSection, rowId: string, field: string, message: string | null): void {
  if (message !== null) issues.push({ section, rowId, field, message });
}

export function validateOpeningRow(row: OpeningRowState, cutoverAt: string | null): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const section: DraftSection = "apiOpeningBalances";
  collect(issues, section, row.id, "resourceId", requireUuid(row.resourceId, "厂商资源"));
  collect(issues, section, row.id, "accountAmount", requireAccountAmount(row.accountAmount, "期初余额"));
  collect(issues, section, row.id, "description",
    requireText(row.description, "事实说明", ACTIVATION_DESCRIPTION_MAX_LENGTH));
  collect(issues, section, row.id, "evidenceRef",
    requireText(row.evidenceRef, "证据引用", ACTIVATION_EVIDENCE_MAX_LENGTH));
  if (cutoverAt === null) {
    collect(issues, section, row.id, "occurredAt", "尚未取得资金切换时点，无法登记期初");
  }
  collect(issues, section, row.id, "sourceRecordId",
    row.sourceRecordId.trim() === "" ? null : requireUuid(row.sourceRecordId, "来源旧记录"));
  return issues;
}

export function validateRechargeRow(row: RechargeRowState): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const section: DraftSection = "historicalApiRecharges";
  collect(issues, section, row.id, "resourceId", requireUuid(row.resourceId, "厂商资源"));
  collect(issues, section, row.id, "accountAmount", requireAccountAmount(row.accountAmount, "到账金额"));
  collect(issues, section, row.id, "cashPaidCny", requireCashPaid(row.cashPaidCny));
  collect(issues, section, row.id, "occurredAt", requireInstant(row.occurredAtLocal, "充值时间"));
  collect(issues, section, row.id, "externalReference",
    requireText(row.externalReference, "充值订单号", ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH));
  return issues;
}

/**
 * 历史 API 消耗行校验：金额必须为正数且最多八位小数；截止时间必须是有效上海时间，
 * 且不得早于资金切换时点（期间开始固定为切换时点）、不得晚于当前时间。
 */
export function validateHistoricalCostRow(row: HistoricalCostRowState, cutoverAt: string | null): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const section: DraftSection = "historicalApiCosts";
  collect(issues, section, row.id, "resourceId", requireUuid(row.resourceId, "厂商资源"));
  if (row.costAmount.trim() === "") {
    collect(issues, section, row.id, "costAmount", "实际消耗金额未填写");
  } else if (!isValidAccountAmount(row.costAmount.trim())) {
    collect(issues, section, row.id, "costAmount", "实际消耗金额必须为正数且最多八位小数");
  } else if (!(Number(row.costAmount.trim()) > 0)) {
    collect(issues, section, row.id, "costAmount", "实际消耗金额必须大于 0（负向落账由系统完成）");
  }
  const untilInstant = toInstant(row.costUntilLocal);
  if (untilInstant === null) {
    collect(issues, section, row.id, "costUntil", "成本截止时间必须填写有效的上海时间");
  } else {
    if (cutoverAt !== null && untilInstant < cutoverAt) {
      collect(issues, section, row.id, "costUntil", "成本截止时间不得早于资金切换时点");
    }
    if (untilInstant > new Date().toISOString()) {
      collect(issues, section, row.id, "costUntil", "成本截止时间不得晚于当前时间");
    }
  }
  return issues;
}

export function validatePurchaseRow(row: PurchaseRowState): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const section: DraftSection = "codingPlanPurchases";
  collect(issues, section, row.id, "resourceId", requireUuid(row.resourceId, "厂商资源"));
  collect(issues, section, row.id, "productName",
    requireText(row.productName, "产品名称", ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH));
  collect(issues, section, row.id, "accountAmount", requireAccountAmount(row.accountAmount, "订阅金额"));
  collect(issues, section, row.id, "cashPaidCny", requireCashPaid(row.cashPaidCny));
  collect(issues, section, row.id, "servicePeriodStart", requireShanghaiDay(row.servicePeriodStart, "服务开始日"));
  collect(issues, section, row.id, "occurredAt", requireInstant(row.occurredAtLocal, "扣费时间"));
  collect(issues, section, row.id, "externalReference",
    requireText(row.externalReference, "外部引用", ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH));
  collect(issues, section, row.id, "description",
    requireText(row.description, "事实说明", ACTIVATION_DESCRIPTION_MAX_LENGTH));
  collect(issues, section, row.id, "evidenceRef",
    requireText(row.evidenceRef, "证据引用", ACTIVATION_EVIDENCE_MAX_LENGTH));
  collect(issues, section, row.id, "recordIdempotencyKey", requireRecordKey(row.recordIdempotencyKey));
  if (row.servicePeriodEnd.trim() !== "") {
    collect(issues, section, row.id, "servicePeriodEnd",
      requireShanghaiDay(row.servicePeriodEnd, "服务结束日"));
    if (isValidShanghaiDay(row.servicePeriodEnd) && isValidShanghaiDay(row.servicePeriodStart)
      && row.servicePeriodEnd < row.servicePeriodStart) {
      collect(issues, section, row.id, "servicePeriodEnd", "服务周期结束日不得早于开始日");
    }
  }
  return issues;
}

export function validateCarryoverRow(row: CarryoverRowState): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const section: DraftSection = "codingPlanCarryovers";
  collect(issues, section, row.id, "resourceId", requireUuid(row.resourceId, "厂商资源"));
  collect(issues, section, row.id, "productName",
    requireText(row.productName, "产品名称", ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH));
  collect(issues, section, row.id, "periodStart", requireShanghaiDay(row.periodStart, "周期开始日"));
  collect(issues, section, row.id, "periodEnd", requireShanghaiDay(row.periodEnd, "周期结束日"));
  // 空快照引用 = 管理员声明路径（UI 不再提供输入框）；非空时保持严格 UUID 校验。
  if (row.snapshotId.trim() !== "") {
    collect(issues, section, row.id, "snapshotId", requireUuid(row.snapshotId, "跨切换快照"));
  }
  if (isValidShanghaiDay(row.periodEnd) && isValidShanghaiDay(row.periodStart)
    && row.periodEnd < row.periodStart) {
    collect(issues, section, row.id, "periodEnd", "周期结束日不得早于开始日");
  }
  return issues;
}

export function validateLegacyRow(row: LegacyRowState): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const section: DraftSection = "legacyResolutions";
  collect(issues, section, row.id, "legacyRecordId", requireUuid(row.legacyRecordId, "旧购买记录"));
  collect(issues, section, row.id, "resourceId", requireUuid(row.resourceId, "厂商资源"));
  if (row.resolution === "ALREADY_REPRESENTED") {
    collect(issues, section, row.id, "financeEventId",
      requireUuid(row.financeEventId, "既有资金事件"));
  }
  if (row.resolution === "MIGRATED") {
    collect(issues, section, row.id, "migratedExternalReference",
      requireText(row.migratedExternalReference, "外部订单引用", ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH));
  }
  if (row.resolution === "REJECTED_WITH_EVIDENCE") {
    collect(issues, section, row.id, "reason",
      requireText(row.reason, "拒绝原因", ACTIVATION_REASON_MAX_LENGTH));
    collect(issues, section, row.id, "evidenceRef",
      requireText(row.evidenceRef, "拒绝证据", ACTIVATION_EVIDENCE_MAX_LENGTH));
  }
  return issues;
}

function collectOpeningIssues(state: ActivationDraftState, cutoverAt: string | null): DraftIssue[] {
  return state.apiOpeningBalances.filter((row) => !isOpeningRowBlank(row))
    .flatMap((row) => validateOpeningRow(row, cutoverAt));
}

function collectRechargeIssues(state: ActivationDraftState): DraftIssue[] {
  const rows = state.historicalApiRecharges.filter((row) => !isRechargeRowBlank(row));
  const issues = rows.flatMap((row) => validateRechargeRow(row));
  // 草稿内防重：同一厂商资源下充值订单号不得重复（服务端还有数据库唯一索引兜底）。
  const byKey = new Map<string, RechargeRowState[]>();
  for (const row of rows) {
    const key = `${row.resourceId.trim()}|${row.externalReference.trim()}`;
    const group = byKey.get(key);
    if (group) group.push(row); else byKey.set(key, [row]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      issues.push({ section: "historicalApiRecharges", rowId: row.id, field: "externalReference",
        message: "同一厂商资源下充值订单号不得重复" });
    }
  }
  return issues;
}

function collectCostIssues(state: ActivationDraftState, cutoverAt: string | null): DraftIssue[] {
  const rows = state.historicalApiCosts.filter((row) => !isCostRowBlank(row));
  const issues = rows.flatMap((row) => validateHistoricalCostRow(row, cutoverAt));
  // 草稿内防重（复核修复 R2）：期间开始固定为切换时点，同一（厂商资源、币种）
  // 的第二条历史消耗与第一条区间必然重叠并重复扣减——不同截止时间或金额也不放行。
  // 直接在草稿内拦下，避免必然失败的预检往返；服务端与数据库唯一索引兜底。
  const byKey = new Map<string, HistoricalCostRowState[]>();
  for (const row of rows) {
    const key = `${row.resourceId.trim()}|${row.accountCurrency}`;
    const group = byKey.get(key);
    if (group) group.push(row); else byKey.set(key, [row]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      issues.push({ section: "historicalApiCosts", rowId: row.id, field: "costUntil",
        message: "同一厂商资源与币种最多只能登记一条历史 API 消耗"
          + "（期间开始固定为资金切换时点，多条必然重叠并重复扣减）" });
    }
  }
  return issues;
}

function collectPurchaseIssues(state: ActivationDraftState): DraftIssue[] {
  return state.codingPlanPurchases.filter((row) => !isPurchaseRowBlank(row))
    .flatMap((row) => validatePurchaseRow(row));
}

function collectCarryoverIssues(state: ActivationDraftState): DraftIssue[] {
  return state.codingPlanCarryovers.filter((row) => !isCarryoverRowBlank(row))
    .flatMap((row) => validateCarryoverRow(row));
}

function collectLegacyIssues(state: ActivationDraftState): DraftIssue[] {
  return state.legacyResolutions.filter((row) => !isLegacyRowBlank(row))
    .flatMap((row) => validateLegacyRow(row));
}

export function validateDraft(state: ActivationDraftState, cutoverAt: string | null): DraftIssue[] {
  const issues = [
    ...collectOpeningIssues(state, cutoverAt), ...collectRechargeIssues(state),
    ...collectCostIssues(state, cutoverAt),
    ...collectPurchaseIssues(state), ...collectCarryoverIssues(state), ...collectLegacyIssues(state),
  ];
  for (const [section, count] of Object.entries(countActiveRows(state))) {
    if (count > ACTIVATION_MAX_DRAFT_ROWS) {
      issues.push({
        section: section as DraftSection, rowId: "", field: "rows",
        message: `单类草稿行数不得超过 ${ACTIVATION_MAX_DRAFT_ROWS}`,
      });
    }
  }
  return issues;
}
