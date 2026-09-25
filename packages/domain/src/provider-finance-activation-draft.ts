/**
 * 资金账本初始化：草稿规范化段——虚拟周期展开与用量修复计划（PFH-03、PFH-04）。
 *
 * 由 provider-finance-activation-projection.ts 按「草稿规范化」分段下沉而来。
 * 计划（v1.2 §4.5）要求预检与激活复用同一套修复计划与字段基准，
 * 因此本模块只做纯计算：无数据库访问、无时钟读取、无随机数。
 */
import {
  USAGE_REPAIR_FIELDS,
  hashStable,
  type NormalizedActivationCandidate,
  type UsageRepairBaselineRow,
  type UsageRepairField,
} from "./provider-finance-activation.js";
import {
  compareStrings,
  hasTokens,
  instantOf,
  ledgerEffectiveAt,
  type LedgerLineFactRow,
  type UsageRepairTarget,
} from "./provider-finance-activation-inputs.js";

// ===== 历史修复字段基准（PFH-04） =====

const TARGET_FIELD_PROPERTIES = ["settledAt", "apiCostCurrency", "apiCostStatus", "subscriptionPeriodId"] as const;

/**
 * 逐行目标/非目标字段基准摘要。
 *
 * 目标字段固定为 `USAGE_REPAIR_FIELDS` 的四个，其余字段全部属于非目标集合。
 * 摘要使用领域层稳定哈希（键排序、null 归一），与既有回填
 * （`provider-finance-usage-backfill.ts` 的 `to_jsonb(line) - <四列>`）语义一致：
 * 逐行比对的门槛都是「非目标字段一个都不能变」。
 *
 * 预检与激活必须调用**同一个**本函数；激活侧从数据库行重建同一 `LedgerLineFactRow` 形状。
 */
export function usageRepairFieldDigests(line: LedgerLineFactRow): {
  targetFieldsBeforeHash: string;
  nonTargetFieldsBeforeHash: string;
} {
  const target = new Map<string, unknown>([
    ["settled_at", line.settledAt],
    ["api_cost_currency", line.apiCostCurrency],
    ["api_cost_status", line.apiCostStatus],
    ["subscription_period_id", line.subscriptionPeriodId],
  ]);
  const targetFieldsBeforeHash = hashStable([...target.entries()]);
  const nonTargetFieldsBeforeHash = hashStable(
    Object.entries(line)
      .filter(([key]) => !(TARGET_FIELD_PROPERTIES as readonly string[]).includes(key))
      .sort(([left], [right]) => compareStrings(left, right)),
  );
  return { targetFieldsBeforeHash, nonTargetFieldsBeforeHash };
}

export function eligibleFieldsFor(line: LedgerLineFactRow, target: UsageRepairTarget): UsageRepairField[] {
  const fields: UsageRepairField[] = [];
  if (line.settledAt === null && target.settledAt !== null) fields.push("settled_at");
  if (line.apiCostCurrency === null && target.apiCostCurrency !== null) fields.push("api_cost_currency");
  if (line.apiCostStatus === null && target.apiCostStatus !== null) fields.push("api_cost_status");
  if (line.subscriptionPeriodId === null && target.subscriptionPeriodId !== null) {
    fields.push("subscription_period_id");
  }
  return fields.filter((field) => (USAGE_REPAIR_FIELDS as readonly string[]).includes(field));
}

// ===== 用量修复计划 =====

export interface UsageRepairPlan {
  baseline: UsageRepairBaselineRow[];
  targets: UsageRepairTarget[];
  repairByLine: Map<string, UsageRepairTarget>;
  /** 因周期歧义而无法唯一归属的行（NO_GO）。 */
  ambiguousPeriodLines: Array<{ line: LedgerLineFactRow; periodIds: string[] }>;
  /** 覆盖周期数为 0 且尚无归属的套餐用量行。 */
  unattributedPlanLines: LedgerLineFactRow[];
}

export interface PeriodCandidate {
  id: string;
  resourceId: string;
  periodStart: string;
  periodEndExclusive: string;
  reversed: boolean;
}

/** 覆盖某用量行的未冲销周期（按 id 稳定排序；多于一个即歧义，不得任意选择）。 */
export function coveringPeriods(
  line: LedgerLineFactRow, periods: readonly PeriodCandidate[],
): PeriodCandidate[] {
  const at = instantOf(ledgerEffectiveAt(line));
  return periods
    .filter((period) => period.resourceId === line.resourceId
      && !period.reversed
      && instantOf(period.periodStart) <= at
      && instantOf(period.periodEndExclusive) > at)
    .sort((left, right) => compareStrings(left.id, right.id));
}

/**
 * 把草稿购买/跨切换周期展开为虚拟周期。
 * 激活会在同一事务内先写入这些周期，再执行用量修复，因此
 * `subscription_period_id` 的修复目标允许指向 `draft:<key>`，由激活侧解析为真实 id。
 */
export function virtualPeriodsOf(candidate: NormalizedActivationCandidate): Array<PeriodCandidate & { key: string }> {
  const periods: Array<PeriodCandidate & { key: string }> = [];
  for (const purchase of candidate.codingPlanPurchases) {
    periods.push({
      id: `draft:${purchase.recordIdempotencyKey}`,
      key: purchase.recordIdempotencyKey,
      resourceId: purchase.resourceId,
      periodStart: purchase.periodStart,
      periodEndExclusive: purchase.periodEndExclusive,
      reversed: false,
    });
  }
  for (const carryover of candidate.codingPlanCarryovers) {
    periods.push({
      id: `draft:${carryover.snapshotId}`,
      key: carryover.snapshotId,
      resourceId: carryover.resourceId,
      periodStart: carryover.periodStart,
      periodEndExclusive: carryover.periodEndExclusive,
      reversed: false,
    });
  }
  return periods;
}

export function planUsageRepairs(input: {
  ledgerLines: readonly LedgerLineFactRow[];
  periods: readonly PeriodCandidate[];
}): UsageRepairPlan {
  const repairByLine = new Map<string, UsageRepairTarget>();
  const ambiguousPeriodLines: Array<{ line: LedgerLineFactRow; periodIds: string[] }> = [];
  const unattributedPlanLines: LedgerLineFactRow[] = [];

  for (const line of input.ledgerLines) {
    const target: UsageRepairTarget = {
      ledgerLineId: line.id,
      settledAt: line.settledAt,
      apiCostCurrency: line.apiCostCurrency,
      apiCostStatus: line.apiCostStatus,
      subscriptionPeriodId: line.subscriptionPeriodId,
    };
    let touched = false;
    if (line.settledAt === null) {
      target.settledAt = line.createdAt;
      touched = true;
    }
    if (line.resourceMode === "API" && line.apiCostStatus === null) {
      const snapshotCurrency = line.billingRuleSnapshotCurrency;
      if (line.apiCost !== null && (snapshotCurrency === "CNY" || snapshotCurrency === "USD")
        && (line.apiCostCurrency === null || line.apiCostCurrency === snapshotCurrency)) {
        target.apiCostCurrency = snapshotCurrency;
        target.apiCostStatus = "PRICED_USAGE";
        touched = true;
      } else if (line.zeroConfirmedEligible && Number(line.apiCost ?? "0") === 0
        && line.apiCostCurrency === null && line.billingRuleId === null && !hasTokens(line)) {
        target.apiCostStatus = "CONFIRMED_ZERO_NO_UPSTREAM";
        touched = true;
      } else if (line.apiCost === null && line.apiCostCurrency === null) {
        target.apiCostStatus = "UNKNOWN_COST";
        touched = true;
      }
    }
    if (line.resourceMode === "CODING_PLAN" && line.apiCostStatus === null
      && line.apiCost === null && line.apiCostCurrency === null) {
      target.apiCostStatus = "NOT_APPLICABLE";
      touched = true;
    }
    if (line.resourceMode === "CODING_PLAN" && line.subscriptionPeriodId === null) {
      const covering = coveringPeriods(line, input.periods);
      if (covering.length > 1) {
        ambiguousPeriodLines.push({ line, periodIds: covering.map((period) => period.id) });
      } else if (covering.length === 1) {
        target.subscriptionPeriodId = covering[0]!.id;
        touched = true;
      } else {
        unattributedPlanLines.push(line);
      }
    }
    if (touched) repairByLine.set(line.id, target);
  }

  const baseline = [...repairByLine.values()]
    .map((target): UsageRepairBaselineRow => ({
      ledgerLineId: target.ledgerLineId,
      eligibleRepairs: eligibleFieldsFor(
        input.ledgerLines.find((row) => row.id === target.ledgerLineId)!, target),
      ...usageRepairFieldDigests(
        input.ledgerLines.find((row) => row.id === target.ledgerLineId)!),
    }))
    .sort((left, right) => compareStrings(left.ledgerLineId, right.ledgerLineId));

  return {
    baseline,
    targets: [...repairByLine.values()].sort((left, right) => compareStrings(left.ledgerLineId, right.ledgerLineId)),
    repairByLine,
    ambiguousPeriodLines,
    unattributedPlanLines,
  };
}
