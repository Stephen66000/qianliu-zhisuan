/**
 * 资金账本初始化草稿的纯模型（WP05 任务 5.2、5.5；PFU-02、PFU-05、PFH-01～PFH-03）。
 *
 * 本模块不含 React 与网络，只做「草稿行状态 → 请求载荷」的确定性转换与前置校验，
 * 便于对零值/空值、严格格式与行省略规则做单元测试。
 *
 * 校验分层（与 WP04 的 `activation-contracts.ts` 对齐，但**服务端始终是最终门禁**）：
 *  - 本地校验只拦「结构上无法构成合法请求体」的行，避免必然 400 的无效往返；
 *  - **业务缺口**（必要账户缺期初、旧记录未关闭、UNKNOWN_COST 等）一律交给服务端
 *    只读投影判定并返回结构化 `NO_GO`，本地不得替服务端下结论（PFU-03）。
 *
 * 零值 vs 空值（PFU-05、PFH-01 Scenario: Explicit zero opening）：
 *  - 金额填写 `0` 是**有效零值**，原样发送；
 *  - 金额留空表示**未填写**，绝不自动转换为 `0`；整行内容皆空时整行省略，
 *    由服务端投影给出 `MISSING_OPENING_BALANCE` 缺口。
 */

import type {
  ActivationDraftPayload,
  CodingPlanCarryoverDraftPayload,
  CodingPlanPurchaseDraftPayload,
  HistoricalRechargeDraftPayload,
  LegacyPurchaseResolutionDraftPayload,
  LegacyResolution,
  OpeningBalanceDraftPayload,
} from "../../api/provider-finance-activation-types";

/**
 * 客户端侧的合同常量镜像。权威定义在 `@qianliu/domain`（`provider-finance-activation.ts`），
 * web 包不依赖 domain 包，因此此处只镜像「前置校验需要」的数值；一旦不一致，
 * 服务端的 Zod 与投影仍会拦下，最坏结果是多一次 400 往返而不会放宽门禁。
 */
export const ACTIVATION_SCHEMA_VERSION = "1";
export const ACTIVATION_DESCRIPTION_MAX_LENGTH = 1000;
export const ACTIVATION_EVIDENCE_MAX_LENGTH = 4000;
export const ACTIVATION_MAX_DRAFT_ROWS = 500;
export const ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH = 255;
export const ACTIVATION_REASON_MAX_LENGTH = 1000;
export const ACTIVATION_RECORD_KEY_MIN_LENGTH = 8;
export const ACTIVATION_RECORD_KEY_MAX_LENGTH = 128;

export type FinanceCurrencyCode = "CNY" | "USD";
export type PurchaseKind = "PURCHASE" | "RENEWAL";

export interface OpeningRowState {
  id: string;
  resourceId: string;
  accountCurrency: FinanceCurrencyCode;
  accountAmount: string;
  description: string;
  evidenceRef: string;
  sourceRecordId: string;
}

export interface RechargeRowState {
  id: string;
  resourceId: string;
  accountCurrency: FinanceCurrencyCode;
  accountAmount: string;
  cashPaidCny: string;
  occurredAtLocal: string;
  externalReference: string;
  description: string;
  evidenceRef: string;
  sourceRecordId: string;
  recordIdempotencyKey: string;
}

export interface PurchaseRowState {
  id: string;
  resourceId: string;
  kind: PurchaseKind;
  productName: string;
  accountAmount: string;
  accountCurrency: FinanceCurrencyCode;
  cashPaidCny: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  occurredAtLocal: string;
  externalReference: string;
  autoRenew: boolean;
  description: string;
  evidenceRef: string;
  sourceRecordId: string;
  carryoverSnapshotId: string;
  recordIdempotencyKey: string;
}

export interface CarryoverRowState {
  id: string;
  resourceId: string;
  productName: string;
  periodStart: string;
  periodEnd: string;
  snapshotId: string;
  description: string;
  evidenceRef: string;
}

export interface LegacyRowState {
  id: string;
  legacyRecordId: string;
  resourceId: string;
  resolution: LegacyResolution;
  financeEventId: string;
  migratedExternalReference: string;
  reason: string;
  evidenceRef: string;
}

export interface ActivationDraftState {
  apiOpeningBalances: OpeningRowState[];
  historicalApiRecharges: RechargeRowState[];
  codingPlanPurchases: PurchaseRowState[];
  codingPlanCarryovers: CarryoverRowState[];
  legacyResolutions: LegacyRowState[];
}

export type DraftSection = keyof ActivationDraftState;

export const DRAFT_SECTION_LABELS: Record<DraftSection, string> = {
  apiOpeningBalances: "API 期初余额",
  historicalApiRecharges: "历史 API 充值",
  codingPlanPurchases: "Coding Plan 购买/续费",
  codingPlanCarryovers: "跨切换周期",
  legacyResolutions: "旧购买记录关闭",
};

export interface DraftIssue {
  section: DraftSection;
  rowId: string;
  field: string;
  message: string;
}

export function newLocalRowId(): string {
  return crypto.randomUUID();
}

export function newRecordIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function emptyDraftState(): ActivationDraftState {
  return {
    apiOpeningBalances: [], historicalApiRecharges: [], codingPlanPurchases: [],
    codingPlanCarryovers: [], legacyResolutions: [],
  };
}

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
    requireText(row.externalReference, "厂商订单号", ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH));
  collect(issues, section, row.id, "description",
    requireText(row.description, "事实说明", ACTIVATION_DESCRIPTION_MAX_LENGTH));
  collect(issues, section, row.id, "evidenceRef",
    requireText(row.evidenceRef, "证据引用", ACTIVATION_EVIDENCE_MAX_LENGTH));
  collect(issues, section, row.id, "sourceRecordId", requireUuid(row.sourceRecordId, "对应旧购买记录"));
  collect(issues, section, row.id, "recordIdempotencyKey", requireRecordKey(row.recordIdempotencyKey));
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
  collect(issues, section, row.id, "snapshotId", requireUuid(row.snapshotId, "跨切换快照"));
  collect(issues, section, row.id, "description",
    requireText(row.description, "事实说明", ACTIVATION_DESCRIPTION_MAX_LENGTH));
  collect(issues, section, row.id, "evidenceRef",
    requireText(row.evidenceRef, "证据引用", ACTIVATION_EVIDENCE_MAX_LENGTH));
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

// ===== 整行是否为空（空行省略，不产生缺口也不产生本地错误） =====

function isBlank(values: readonly string[]): boolean {
  return values.every((value) => value.trim() === "");
}

function isOpeningRowBlank(row: OpeningRowState): boolean {
  return isBlank([row.resourceId, row.accountAmount, row.description, row.evidenceRef, row.sourceRecordId]);
}

function isRechargeRowBlank(row: RechargeRowState): boolean {
  return isBlank([row.resourceId, row.accountAmount, row.cashPaidCny, row.occurredAtLocal,
    row.externalReference, row.description, row.evidenceRef, row.sourceRecordId]);
}

function isPurchaseRowBlank(row: PurchaseRowState): boolean {
  return isBlank([row.resourceId, row.productName, row.accountAmount, row.cashPaidCny,
    row.servicePeriodStart, row.servicePeriodEnd, row.occurredAtLocal, row.externalReference,
    row.description, row.evidenceRef, row.sourceRecordId, row.carryoverSnapshotId]);
}

function isCarryoverRowBlank(row: CarryoverRowState): boolean {
  return isBlank([row.resourceId, row.productName, row.periodStart, row.periodEnd,
    row.snapshotId, row.description, row.evidenceRef]);
}

/** 旧记录关闭行一旦被加入就视为有意图（选择了解析方式即非空），因此只按标识判断。 */
function isLegacyRowBlank(row: LegacyRowState): boolean {
  return isBlank([row.legacyRecordId, row.resourceId, row.financeEventId,
    row.migratedExternalReference, row.reason, row.evidenceRef]);
}

export function countActiveRows(state: ActivationDraftState): Record<DraftSection, number> {
  return {
    apiOpeningBalances: state.apiOpeningBalances.filter((row) => !isOpeningRowBlank(row)).length,
    historicalApiRecharges: state.historicalApiRecharges.filter((row) => !isRechargeRowBlank(row)).length,
    codingPlanPurchases: state.codingPlanPurchases.filter((row) => !isPurchaseRowBlank(row)).length,
    codingPlanCarryovers: state.codingPlanCarryovers.filter((row) => !isCarryoverRowBlank(row)).length,
    legacyResolutions: state.legacyResolutions.filter((row) => !isLegacyRowBlank(row)).length,
  };
}

// ===== 载荷构造 =====

function collectOpeningIssues(state: ActivationDraftState, cutoverAt: string | null): DraftIssue[] {
  return state.apiOpeningBalances.filter((row) => !isOpeningRowBlank(row))
    .flatMap((row) => validateOpeningRow(row, cutoverAt));
}

function collectRechargeIssues(state: ActivationDraftState): DraftIssue[] {
  return state.historicalApiRecharges.filter((row) => !isRechargeRowBlank(row))
    .flatMap((row) => validateRechargeRow(row));
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

function toOpeningPayload(row: OpeningRowState, cutoverAt: string): OpeningBalanceDraftPayload {
  return {
    resource_id: row.resourceId.trim(),
    account_currency: row.accountCurrency,
    // 零值原样保留；空值不可能到达此处（本地校验已拦截，空行已被省略）。
    account_amount: row.accountAmount.trim(),
    occurred_at: cutoverAt,
    description: row.description.trim(),
    evidence_ref: row.evidenceRef.trim(),
    ...(row.sourceRecordId.trim() === "" ? {} : { source_record_id: row.sourceRecordId.trim() }),
  };
}

function toRechargePayload(row: RechargeRowState): HistoricalRechargeDraftPayload {
  return {
    resource_id: row.resourceId.trim(),
    account_currency: row.accountCurrency,
    account_amount: row.accountAmount.trim(),
    cash_paid_cny: row.cashPaidCny.trim(),
    occurred_at: toInstant(row.occurredAtLocal) ?? "",
    external_reference: row.externalReference.trim(),
    description: row.description.trim(),
    evidence_ref: row.evidenceRef.trim(),
    source_record_id: row.sourceRecordId.trim(),
    record_idempotency_key: row.recordIdempotencyKey,
  };
}

function toPurchasePayload(row: PurchaseRowState): CodingPlanPurchaseDraftPayload {
  return {
    resource_id: row.resourceId.trim(),
    kind: row.kind,
    product_name: row.productName.trim(),
    account_amount: row.accountAmount.trim(),
    account_currency: row.accountCurrency,
    cash_paid_cny: row.cashPaidCny.trim(),
    service_period_start: row.servicePeriodStart.trim(),
    ...(row.servicePeriodEnd.trim() === "" ? {} : { service_period_end: row.servicePeriodEnd.trim() }),
    occurred_at: toInstant(row.occurredAtLocal) ?? "",
    external_reference: row.externalReference.trim(),
    auto_renew: row.autoRenew,
    description: row.description.trim(),
    evidence_ref: row.evidenceRef.trim(),
    ...(row.sourceRecordId.trim() === "" ? {} : { source_record_id: row.sourceRecordId.trim() }),
    ...(row.carryoverSnapshotId.trim() === "" ? {} : { carryover_snapshot_id: row.carryoverSnapshotId.trim() }),
    record_idempotency_key: row.recordIdempotencyKey,
  };
}

function toCarryoverPayload(row: CarryoverRowState): CodingPlanCarryoverDraftPayload {
  return {
    resource_id: row.resourceId.trim(),
    product_name: row.productName.trim(),
    period_start: row.periodStart.trim(),
    period_end: row.periodEnd.trim(),
    snapshot_id: row.snapshotId.trim(),
    description: row.description.trim(),
    evidence_ref: row.evidenceRef.trim(),
  };
}

function toLegacyPayload(row: LegacyRowState): LegacyPurchaseResolutionDraftPayload {
  return {
    legacy_record_id: row.legacyRecordId.trim(),
    resource_id: row.resourceId.trim(),
    resolution: row.resolution,
    ...(row.financeEventId.trim() === "" ? {} : { finance_event_id: row.financeEventId.trim() }),
    ...(row.migratedExternalReference.trim() === ""
      ? {} : { migrated_external_reference: row.migratedExternalReference.trim() }),
    ...(row.reason.trim() === "" ? {} : { reason: row.reason.trim() }),
    ...(row.evidenceRef.trim() === "" ? {} : { evidence_ref: row.evidenceRef.trim() }),
  };
}

/**
 * 构造预检请求体。载荷中**只有业务草稿**：不含 `enterprise_id` / `admin_id`
 * （PFU-02、PFA-07），权威身份由服务端从会话取得。
 */
export function buildActivationDraft(
  state: ActivationDraftState, cutoverAt: string,
): ActivationDraftPayload {
  return {
    schema_version: ACTIVATION_SCHEMA_VERSION,
    api_opening_balances: state.apiOpeningBalances.filter((row) => !isOpeningRowBlank(row))
      .map((row) => toOpeningPayload(row, cutoverAt)),
    historical_api_recharges: state.historicalApiRecharges.filter((row) => !isRechargeRowBlank(row))
      .map(toRechargePayload),
    coding_plan_purchases: state.codingPlanPurchases.filter((row) => !isPurchaseRowBlank(row))
      .map(toPurchasePayload),
    coding_plan_carryovers: state.codingPlanCarryovers.filter((row) => !isCarryoverRowBlank(row))
      .map(toCarryoverPayload),
    legacy_purchase_resolutions: state.legacyResolutions.filter((row) => !isLegacyRowBlank(row))
      .map(toLegacyPayload),
  };
}
