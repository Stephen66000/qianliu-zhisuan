/** 草稿行状态、合同常量与空行识别；不做校验、载荷构造或网络操作。 */
import type { LegacyResolution } from "../../api/provider-finance-activation-types";

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

/**
 * 历史 API 充值行：管理员只填写六项（厂商资源、币种、到账金额、人民币实付、
 * 充值时间、充值订单号）。事实说明、证据引用、来源旧记录与记录级幂等键属于
 * 系统内部字段，由服务端按确定性规则自动生成（充值表单最小修复 2026-09-27）。
 */
export interface RechargeRowState {
  id: string;
  resourceId: string;
  accountCurrency: FinanceCurrencyCode;
  accountAmount: string;
  cashPaidCny: string;
  occurredAtLocal: string;
  externalReference: string;
}

/**
 * 历史 API 消耗行：管理员只填四项；`costAmount` 必须是正数
 * （负向落账由服务端统一取负，管理员不得输入负数）。
 */
export interface HistoricalCostRowState {
  id: string;
  resourceId: string;
  accountCurrency: FinanceCurrencyCode;
  costAmount: string;
  costUntilLocal: string;
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
  historicalApiCosts: HistoricalCostRowState[];
  codingPlanPurchases: PurchaseRowState[];
  codingPlanCarryovers: CarryoverRowState[];
  legacyResolutions: LegacyRowState[];
}

export type DraftSection = keyof ActivationDraftState;

export const DRAFT_SECTION_LABELS: Record<DraftSection, string> = {
  apiOpeningBalances: "API 期初余额",
  historicalApiRecharges: "历史 API 充值",
  historicalApiCosts: "历史 API 消耗",
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
    apiOpeningBalances: [], historicalApiRecharges: [], historicalApiCosts: [],
    codingPlanPurchases: [], codingPlanCarryovers: [], legacyResolutions: [],
  };
}

// ===== 整行是否为空（空行省略，不产生缺口也不产生本地错误） =====

function isBlank(values: readonly string[]): boolean {
  return values.every((value) => value.trim() === "");
}

export function isOpeningRowBlank(row: OpeningRowState): boolean {
  return isBlank([row.resourceId, row.accountAmount, row.description, row.evidenceRef, row.sourceRecordId]);
}

export function isRechargeRowBlank(row: RechargeRowState): boolean {
  return isBlank([row.resourceId, row.accountAmount, row.cashPaidCny, row.occurredAtLocal,
    row.externalReference]);
}

export function isCostRowBlank(row: HistoricalCostRowState): boolean {
  return isBlank([row.resourceId, row.costAmount, row.costUntilLocal]);
}

export function isPurchaseRowBlank(row: PurchaseRowState): boolean {
  return isBlank([row.resourceId, row.productName, row.accountAmount, row.cashPaidCny,
    row.servicePeriodStart, row.servicePeriodEnd, row.occurredAtLocal, row.externalReference,
    row.description, row.evidenceRef, row.sourceRecordId, row.carryoverSnapshotId]);
}

export function isCarryoverRowBlank(row: CarryoverRowState): boolean {
  return isBlank([row.resourceId, row.productName, row.periodStart, row.periodEnd,
    row.snapshotId, row.description, row.evidenceRef]);
}

/** 旧记录关闭行一旦被加入就视为有意图（选择了解析方式即非空），因此只按标识判断。 */
export function isLegacyRowBlank(row: LegacyRowState): boolean {
  return isBlank([row.legacyRecordId, row.resourceId, row.financeEventId,
    row.migratedExternalReference, row.reason, row.evidenceRef]);
}

export function countActiveRows(state: ActivationDraftState): Record<DraftSection, number> {
  return {
    apiOpeningBalances: state.apiOpeningBalances.filter((row) => !isOpeningRowBlank(row)).length,
    historicalApiRecharges: state.historicalApiRecharges.filter((row) => !isRechargeRowBlank(row)).length,
    historicalApiCosts: state.historicalApiCosts.filter((row) => !isCostRowBlank(row)).length,
    codingPlanPurchases: state.codingPlanPurchases.filter((row) => !isPurchaseRowBlank(row)).length,
    codingPlanCarryovers: state.codingPlanCarryovers.filter((row) => !isCarryoverRowBlank(row)).length,
    legacyResolutions: state.legacyResolutions.filter((row) => !isLegacyRowBlank(row)).length,
  };
}
