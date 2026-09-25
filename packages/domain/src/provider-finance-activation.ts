/**
 * 资金账本初始化：实现面——金额/时间规范化、稳定序列化与哈希、草稿规范化与候选哈希。
 *
 * 对应 OpenSpec：PFA-01/PFA-03/PFA-06、PFH-01～PFH-05。
 *
 * 工程约束（计划 v1.2 §5、design §4～§6）：
 * - 本模块必须无数据库访问、无时钟读取、无随机数；预检与激活复用同一套函数，
 *   禁止在仓储层另行实现第二套金额规范化或冲销符号公式。
 * - 候选哈希只覆盖领域事实与事实水位；展示名称、客户端管理员 ID、激活幂等键、
 *   生成时间、随机候选 ID、UI 排序均不得进入哈希输入。
 * - 金额：账户金额固定八位小数，人民币实付固定两位小数；空值规范为 null，
 *   不得依赖对象属性插入顺序。
 *
 * 分段说明（质量门禁单文件上限）：契约面（常量、类型、缺口、状态机、静默租约）
 * 已下沉到 provider-finance-activation-contract.ts，本模块 `export *` 再导出，
 * 保证包对外导出面与历史调用点零变化。
 */
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  ACTIVATION_ACCOUNT_AMOUNT_SCALE,
  ACTIVATION_CASH_PAID_CNY_SCALE,
  PROVIDER_FINANCE_CUTOVER_ISO,
  type ActivationCurrency,
  type ActivationDraft,
  type FactWatermarkSection,
  type NormalizedActivationCandidate,
  type NormalizedCodingPlanCarryover,
  type NormalizedCodingPlanPurchase,
  type NormalizedLegacyPurchaseResolution,
  type NormalizedOpeningBalance,
  type NormalizedRecharge,
} from "./provider-finance-activation-contract.js";

export * from "./provider-finance-activation-contract.js";

// ===== 金额与时间规范化 =====

function toDecimal(value: string | number, label: string): Decimal {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    throw new Error(`${label} 不是合法十进制数`);
  }
  if (!decimal.isFinite()) throw new Error(`${label} 必须是有限十进制数`);
  return decimal;
}

/** 账户金额规范为八位小数字符串；允许显式 0，拒绝负值与超过八位小数。 */
export function normalizeAccountAmount(value: string | number, label = "账户金额"): string {
  const decimal = toDecimal(value, label);
  if (decimal.isNegative()) throw new Error(`${label} 不得为负`);
  if (decimal.decimalPlaces() > ACTIVATION_ACCOUNT_AMOUNT_SCALE) {
    throw new Error(`${label} 最多保留 ${ACTIVATION_ACCOUNT_AMOUNT_SCALE} 位小数`);
  }
  return decimal.toFixed(ACTIVATION_ACCOUNT_AMOUNT_SCALE);
}

/** 人民币实付规范为两位小数字符串；必须大于 0。 */
export function normalizeCashPaidCny(value: string | number, label = "人民币实付"): string {
  const decimal = toDecimal(value, label);
  if (!decimal.gt(0)) throw new Error(`${label} 必须大于 0`);
  if (decimal.decimalPlaces() > ACTIVATION_CASH_PAID_CNY_SCALE) {
    throw new Error(`${label} 最多保留 ${ACTIVATION_CASH_PAID_CNY_SCALE} 位小数`);
  }
  return decimal.toFixed(ACTIVATION_CASH_PAID_CNY_SCALE);
}

/** 时间统一为 UTC ISO（毫秒精度）。 */
export function normalizeInstant(value: string | Date, label = "时间"): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} 不是合法时间`);
  return date.toISOString();
}

const SHANGHAI_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 校验并返回上海自然日（YYYY-MM-DD）。 */
export function normalizeShanghaiDay(value: string, label = "日期"): string {
  if (!SHANGHAI_DAY_PATTERN.test(value)) throw new Error(`${label} 必须是 YYYY-MM-DD 上海自然日`);
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month! - 1 || probe.getUTCDate() !== day) {
    throw new Error(`${label} 不是真实存在的自然日`);
  }
  return value;
}

/**
 * 默认周期结束日（页面口径，含结束日）：下个月同日前一日。
 * 与既有日常订阅接口 `defaultServiceEndDate` 语义完全一致；若目标月无该日则先取下月最后一日。
 */
export function defaultServiceEndInclusive(serviceStartDay: string): string {
  const start = normalizeShanghaiDay(serviceStartDay, "服务开始日");
  const [year, month, day] = start.split("-").map(Number);
  const lastDayOfNextMonth = new Date(Date.UTC(year!, month! + 1, 0)).getUTCDate();
  const nextAnniversary = Date.UTC(year!, month!, Math.min(day!, lastDayOfNextMonth));
  return new Date(nextAnniversary - 24 * 3600_000).toISOString().slice(0, 10);
}

/** 上海自然日 00:00 对应的 UTC 瞬间。 */
export function shanghaiDayStartUtc(day: string): Date {
  return new Date(`${normalizeShanghaiDay(day)}T00:00:00+08:00`);
}

/** 页面含结束日 → 数据库 `[period_start, period_end_exclusive)`（PFH-03）。 */
export function shanghaiPeriodBounds(
  serviceStartDay: string, serviceEndInclusiveDay: string | null,
): { periodStart: string; periodEndExclusive: string; servicePeriodEndInclusive: string } {
  const startDay = normalizeShanghaiDay(serviceStartDay, "服务开始日");
  const endDay = serviceEndInclusiveDay === null
    ? defaultServiceEndInclusive(startDay)
    : normalizeShanghaiDay(serviceEndInclusiveDay, "服务结束日");
  const [year, month, day] = endDay.split("-").map(Number);
  const endExclusive = new Date(Date.UTC(year!, month! - 1, day! + 1) - 8 * 3600_000);
  return {
    periodStart: shanghaiDayStartUtc(startDay).toISOString(),
    periodEndExclusive: endExclusive.toISOString(),
    servicePeriodEndInclusive: endDay,
  };
}

/** 扣费时间必须落在服务开始日的上海自然日内（PFH-03）。 */
export function isWithinShanghaiDay(instant: string | Date, day: string): boolean {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return false;
  const shanghai = new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return shanghai === normalizeShanghaiDay(day);
}

// ===== 稳定序列化与哈希 =====

function normalizeForSerialization(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForSerialization);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = normalizeForSerialization(source[key]);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("稳定序列化不接受非有限数值");
  }
  return value;
}

/** 稳定 JSON：对象键排序、undefined→null、日期→ISO；不依赖属性插入顺序。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForSerialization(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashStable(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** 事实水位哈希：分段摘要再算总哈希。 */
export function computeFactWatermarkHash(sections: readonly FactWatermarkSection[]): string {
  const ordered = [...sections]
    .map((section) => ({ ...section }))
    .sort((a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : 0));
  return hashStable(ordered);
}

/** 集合摘要：按业务键稳定排序后逐行稳定序列化再哈希。 */
export function computeCollectionDigest(rows: readonly unknown[]): string {
  return hashStable(rows);
}

// ===== 草稿规范化（任务 1.2） =====

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireText(value: string | null, label: string): string {
  if (value === null || value.trim().length === 0) throw new Error(`${label} 不能为空`);
  return value;
}

export function normalizeDraftItem(
  draft: ActivationDraft, enterpriseId: string,
): NormalizedActivationCandidate {
  const openings: NormalizedOpeningBalance[] = draft.api_opening_balances.map((item) => ({
    resourceId: item.resource_id,
    accountCurrency: item.account_currency,
    accountAmount: normalizeAccountAmount(item.account_amount),
    occurredAt: normalizeInstant(item.occurred_at, "期初时点"),
    description: requireText(item.description, "期初说明"),
    evidenceRef: requireText(item.evidence_ref, "期初证据"),
    sourceRecordId: item.source_record_id ?? null,
  })).sort((a, b) => compareStrings(a.resourceId, b.resourceId)
    || compareStrings(a.accountCurrency, b.accountCurrency)
    || compareStrings(a.sourceRecordId ?? "", b.sourceRecordId ?? ""));

  const recharges: NormalizedRecharge[] = draft.historical_api_recharges.map((item) => ({
    resourceId: item.resource_id,
    accountCurrency: item.account_currency,
    accountAmount: normalizeAccountAmount(item.account_amount),
    cashPaidCny: normalizeCashPaidCny(item.cash_paid_cny),
    occurredAt: normalizeInstant(item.occurred_at, "充值时间"),
    externalReference: requireText(item.external_reference, "外部引用"),
    description: requireText(item.description, "充值说明"),
    evidenceRef: requireText(item.evidence_ref, "充值证据"),
    sourceRecordId: item.source_record_id,
    recordIdempotencyKey: item.record_idempotency_key,
  })).sort((a, b) => compareStrings(a.resourceId, b.resourceId)
    || compareStrings(a.accountCurrency, b.accountCurrency)
    || compareStrings(a.occurredAt, b.occurredAt)
    || compareStrings(a.sourceRecordId, b.sourceRecordId));

  const purchases: NormalizedCodingPlanPurchase[] = draft.coding_plan_purchases.map((item) => {
    const bounds = shanghaiPeriodBounds(item.service_period_start, item.service_period_end);
    return {
      resourceId: item.resource_id,
      kind: item.kind,
      productName: requireText(item.product_name, "产品名称"),
      accountAmount: normalizeAccountAmount(item.account_amount),
      accountCurrency: item.account_currency,
      cashPaidCny: normalizeCashPaidCny(item.cash_paid_cny),
      servicePeriodStart: item.service_period_start,
      servicePeriodEndInclusive: bounds.servicePeriodEndInclusive,
      periodStart: bounds.periodStart,
      periodEndExclusive: bounds.periodEndExclusive,
      occurredAt: normalizeInstant(item.occurred_at, "扣费时间"),
      externalReference: requireText(item.external_reference, "外部引用"),
      autoRenew: item.auto_renew,
      description: requireText(item.description, "购买说明"),
      evidenceRef: requireText(item.evidence_ref, "购买证据"),
      sourceRecordId: item.source_record_id ?? null,
      carryoverSnapshotId: item.carryover_snapshot_id ?? null,
      recordIdempotencyKey: item.record_idempotency_key,
    };
  }).sort((a, b) => compareStrings(a.resourceId, b.resourceId)
    || compareStrings(a.occurredAt, b.occurredAt)
    || compareStrings(a.sourceRecordId ?? "", b.sourceRecordId ?? "")
    || compareStrings(a.productName, b.productName));

  const carryovers: NormalizedCodingPlanCarryover[] = draft.coding_plan_carryovers.map((item) => {
    const bounds = shanghaiPeriodBounds(item.period_start, item.period_end);
    return {
      resourceId: item.resource_id,
      productName: requireText(item.product_name, "产品名称"),
      periodStart: bounds.periodStart,
      periodEndExclusive: bounds.periodEndExclusive,
      snapshotId: item.snapshot_id,
      description: requireText(item.description, "跨切换周期说明"),
      evidenceRef: requireText(item.evidence_ref, "跨切换周期证据"),
    };
  }).sort((a, b) => compareStrings(a.resourceId, b.resourceId)
    || compareStrings(a.periodStart, b.periodStart)
    || compareStrings(a.snapshotId, b.snapshotId));

  const resolutions: NormalizedLegacyPurchaseResolution[] = draft.legacy_purchase_resolutions.map((item) => ({
    legacyRecordId: item.legacy_record_id,
    resourceId: item.resource_id,
    resolution: item.resolution,
    financeEventId: item.finance_event_id ?? null,
    migratedExternalReference: item.migrated_external_reference ?? null,
    reason: item.reason ?? null,
    evidenceRef: item.evidence_ref ?? null,
  })).sort((a, b) => compareStrings(a.legacyRecordId, b.legacyRecordId)
    || compareStrings(a.resourceId, b.resourceId));

  void enterpriseId;
  return {
    schemaVersion: draft.schema_version,
    cutoverAt: PROVIDER_FINANCE_CUTOVER_ISO,
    apiOpeningBalances: openings,
    historicalApiRecharges: recharges,
    codingPlanPurchases: purchases,
    codingPlanCarryovers: carryovers,
    legacyPurchaseResolutions: resolutions,
  };
}

export interface ActivationCandidateHashInput {
  enterpriseId: string;
  candidate: NormalizedActivationCandidate;
  factWatermarkHash: string;
  /**
   * 排序后的必要币种账户（PFA-03 / 计划 v1.2 §5.1）。
   * 必要币种由事实推导（切换快照、资金事件、已定价用量、历史充值）加上管理员显式声明，
   * 因此把它显式纳入哈希，可在推导来源变化时独立于水位暴露候选失效。
   */
  scopeAccounts?: ReadonlyArray<{ resourceId: string; currency: ActivationCurrency }>;
}

/**
 * 候选哈希（PFA-03）。
 * 包含：schema 版本、会话企业、固定切换时点、规范化草稿（含记录级幂等键）、
 * 排序后的必要币种账户、事实水位哈希。
 * 排除：展示名称、客户端管理员 ID、激活幂等键、生成时间、随机候选 ID、UI 排序状态。
 */
export function computeCandidateHash(input: ActivationCandidateHashInput): string {
  const { candidate } = input;
  const scopeAccounts = input.scopeAccounts === undefined ? null
    : [...input.scopeAccounts]
      .map((account) => ({ resource_id: account.resourceId, currency: account.currency }))
      .sort((left, right) => (left.resource_id < right.resource_id ? -1
        : left.resource_id > right.resource_id ? 1
          : left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0));
  return hashStable({
    schema_version: candidate.schemaVersion,
    enterprise_id: input.enterpriseId,
    cutover_at: candidate.cutoverAt,
    required_accounts: scopeAccounts,
    api_opening_balances: candidate.apiOpeningBalances,
    historical_api_recharges: candidate.historicalApiRecharges,
    coding_plan_purchases: candidate.codingPlanPurchases,
    coding_plan_carryovers: candidate.codingPlanCarryovers,
    legacy_purchase_resolutions: candidate.legacyPurchaseResolutions,
    fact_watermark_hash: input.factWatermarkHash,
  });
}
