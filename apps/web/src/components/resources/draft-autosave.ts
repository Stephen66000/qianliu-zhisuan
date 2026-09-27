/**
 * 初始化草稿的本机自动保存（2026-09-27 最小增量·功能 A）。
 *
 * 职责：把 `ActivationDraftState` 版本化地存入浏览器 localStorage，刷新后可恢复。
 * 硬约束：
 *  - key 必须按 `enterpriseId + cutoverAt` 隔离并包含 schema 版本——不同企业、
 *    不同切换时点的草稿不得互相恢复；
 *  - 读取必须失败关闭：无效 JSON、版本不匹配、企业/切换时点不匹配或结构不兼容
 *    一律返回 null 并回退空草稿，不崩溃、不做任何静默金额转换；
 *  - 只保存业务草稿本身：凭证明文、登录信息、静默租约、候选 ID、候选哈希、
 *    激活确认等敏感或易失状态一律不入存储；
 *  - 存储写入可能因隐私模式/配额失败：调用方得到 boolean，不得抛出。
 *
 * 纯函数封装（storage 由调用方注入），便于对保存/恢复/隔离/坏数据做定向单测。
 */
import { emptyDraftState, type ActivationDraftState } from "./activation-draft-model";

/** 草稿存储协议版本；结构语义变化时必须升版（旧版本数据直接忽略）。 */
export const DRAFT_AUTOSAVE_SCHEMA_VERSION = 1 as const;

/** 本机草稿存储键：按企业 + 切换时点隔离，含协议版本。 */
export function draftAutosaveKey(enterpriseId: string, cutoverAt: string): string {
  return `qianliu:provider-finance-activation-draft:v${DRAFT_AUTOSAVE_SCHEMA_VERSION}:${enterpriseId}:${cutoverAt}`;
}

/** 最小存储接口（`Storage` 的子集），便于测试注入内存实现。 */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface DraftAutosaveEnvelope {
  schema_version: number;
  enterprise_id: string;
  cutover_at: string;
  saved_at: string;
  draft: ActivationDraftState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ===== 完整运行时结构校验（复核修复 R1，2026-09-27） =====
//
// 只校验「本版本 ActivationDraftState 所需字段的类型」：字符串字段必须是 string
// （允许空串——草稿允许填到一半），枚举字段必须落在当前枚举集合内，布尔字段必须
// 是 boolean。不做任何金额格式校验或数值转换（服务端是最终门禁）；
// 任何一行结构不兼容 → 整个草稿整体忽略返回 null，绝不部分恢复。

const FINANCE_CURRENCIES = new Set(["CNY", "USD"]);
const PURCHASE_KINDS = new Set(["PURCHASE", "RENEWAL"]);
const LEGACY_RESOLUTIONS = new Set(["MIGRATED", "ALREADY_REPRESENTED", "REJECTED_WITH_EVIDENCE"]);

function hasAllStrings(row: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof row[field] === "string");
}

function hasEnum(row: Record<string, unknown>, field: string, allowed: Set<string>): boolean {
  return typeof row[field] === "string" && allowed.has(row[field] as string);
}

/** 期初行：resourceId / 币种 / 金额 / 说明 / 证据 / 来源旧记录。 */
function isOpeningRow(row: Record<string, unknown>): boolean {
  return hasAllStrings(row, ["resourceId", "accountAmount", "description", "evidenceRef", "sourceRecordId"])
    && hasEnum(row, "accountCurrency", FINANCE_CURRENCIES);
}

/** 历史充值行：管理员六项。 */
function isRechargeRow(row: Record<string, unknown>): boolean {
  return hasAllStrings(row, ["resourceId", "accountAmount", "cashPaidCny", "occurredAtLocal", "externalReference"])
    && hasEnum(row, "accountCurrency", FINANCE_CURRENCIES);
}

/** 历史消耗行：管理员四项。 */
function isCostRow(row: Record<string, unknown>): boolean {
  return hasAllStrings(row, ["resourceId", "costAmount", "costUntilLocal"])
    && hasEnum(row, "accountCurrency", FINANCE_CURRENCIES);
}

/** Coding Plan 购买/续费行：含 kind 枚举与 autoRenew 布尔。 */
function isPurchaseRow(row: Record<string, unknown>): boolean {
  return hasAllStrings(row, ["resourceId", "productName", "accountAmount", "cashPaidCny",
    "servicePeriodStart", "servicePeriodEnd", "occurredAtLocal", "externalReference",
    "description", "evidenceRef", "sourceRecordId", "carryoverSnapshotId", "recordIdempotencyKey"])
    && hasEnum(row, "accountCurrency", FINANCE_CURRENCIES)
    && hasEnum(row, "kind", PURCHASE_KINDS)
    && typeof row.autoRenew === "boolean";
}

/** 跨切换周期行。 */
function isCarryoverRow(row: Record<string, unknown>): boolean {
  return hasAllStrings(row, ["resourceId", "productName", "periodStart", "periodEnd",
    "snapshotId", "description", "evidenceRef"]);
}

/** 旧购买记录关闭行：resolution 枚举。 */
function isLegacyRow(row: Record<string, unknown>): boolean {
  return hasAllStrings(row, ["legacyRecordId", "resourceId", "financeEventId",
    "migratedExternalReference", "reason", "evidenceRef"])
    && hasEnum(row, "resolution", LEGACY_RESOLUTIONS);
}

const SECTION_ROW_VALIDATORS = {
  apiOpeningBalances: isOpeningRow,
  historicalApiRecharges: isRechargeRow,
  historicalApiCosts: isCostRow,
  codingPlanPurchases: isPurchaseRow,
  codingPlanCarryovers: isCarryoverRow,
  legacyResolutions: isLegacyRow,
} as const satisfies Record<keyof ActivationDraftState, (row: Record<string, unknown>) => boolean>;

/**
 * 结构校验：六类草稿行数组齐全、每行都有 string id，且**逐字段**满足当前版本
 * 行结构（字符串类型、币种/决定/购买类型枚举、布尔字段）。id-only 或缺字段的
 * 旧/损坏行一律判为结构不兼容。
 */
function isActivationDraftState(value: unknown): value is ActivationDraftState {
  if (!isRecord(value)) return false;
  const sections = Object.keys(SECTION_ROW_VALIDATORS) as Array<keyof ActivationDraftState>;
  return sections.every((section) => {
    const rows = value[section];
    if (!Array.isArray(rows)) return false;
    const validateRow = SECTION_ROW_VALIDATORS[section];
    return rows.every((row) => isRecord(row) && typeof row.id === "string" && validateRow(row));
  });
}

/** 结构不兼容时整体回退空草稿（调用方拿到 null），绝不部分恢复或静默转换金额。 */
function parseEnvelope(raw: string, enterpriseId: string, cutoverAt: string): ActivationDraftState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema_version !== DRAFT_AUTOSAVE_SCHEMA_VERSION) return null;
  if (parsed.enterprise_id !== enterpriseId || parsed.cutover_at !== cutoverAt) return null;
  if (typeof parsed.saved_at !== "string") return null;
  if (!isActivationDraftState(parsed.draft)) return null;
  return parsed.draft;
}

/**
 * 首次挂载时安全读取本机草稿。任何异常（无效 JSON、版本不匹配、企业/切换时点
 * 不匹配、结构不兼容）都返回 null——调用方回退空草稿。
 */
export function loadDraftAutosave(
  storage: DraftStorage | null, enterpriseId: string, cutoverAt: string,
): ActivationDraftState | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(draftAutosaveKey(enterpriseId, cutoverAt));
  } catch {
    return null;
  }
  if (raw === null) return null;
  return parseEnvelope(raw, enterpriseId, cutoverAt);
}

/**
 * 草稿变化后自动保存完整 `ActivationDraftState`。
 * 返回 false 表示存储不可用或写入失败（隐私模式、配额等），调用方据此隐藏「已保存」状态。
 */
export function saveDraftAutosave(
  storage: DraftStorage | null, draft: ActivationDraftState,
  enterpriseId: string, cutoverAt: string, savedAt: string,
): boolean {
  if (!storage) return false;
  const envelope: DraftAutosaveEnvelope = {
    schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION,
    enterprise_id: enterpriseId,
    cutover_at: cutoverAt,
    saved_at: savedAt,
    draft,
  };
  try {
    storage.setItem(draftAutosaveKey(enterpriseId, cutoverAt), JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/** 清除本机草稿；存储异常同样吞掉（清除失败只影响下次恢复，不影响业务）。 */
export function clearDraftAutosave(
  storage: DraftStorage | null, enterpriseId: string, cutoverAt: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(draftAutosaveKey(enterpriseId, cutoverAt));
  } catch {
    // 忽略：清除失败等价于「本机无草稿」的保守语义。
  }
}

/** 空草稿快捷构造：恢复失败与清除后共用，保证行数组齐全。 */
export function emptyAutosaveDraft(): ActivationDraftState {
  return emptyDraftState();
}
