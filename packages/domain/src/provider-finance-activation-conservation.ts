/**
 * 资金账本初始化：守恒检查段——上海自然月窗口、逐月缺口抵消与归属/分类缺口（PFH-03、PFH-05）。
 *
 * 由 provider-finance-activation-projection.ts 按「守恒检查」分段下沉而来。
 *
 * 工程约束：
 * - 经营账单缺口的权威口径是数据库层 `countFinanceGaps`（SQL 单一来源）。
 *   本模块只对草稿与用量修复带来的**增量**做确定性抵消，不重新定义缺口规则。
 * - 缺口必须结构化且可定位到资源、账户、旧记录、用量行或月份；不得只返回一条错误字符串。
 */
import {
  type ActivationGap,
  type ActivationGapCode,
} from "./provider-finance-activation.js";
import {
  accountKey,
  compareStrings,
  gap,
  hasTokens,
  isWithin,
  ledgerEffectiveAt,
  type ActivationProjectionInput,
} from "./provider-finance-activation-inputs.js";
import type { UsageRepairPlan } from "./provider-finance-activation-draft.js";

// ===== 上海自然月窗口 =====

/** UTC 瞬间所属的上海自然月（YYYY-MM）。 */
export function shanghaiMonthOf(instant: string | Date): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error("不是合法时间");
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 7);
}

/** 上海自然月的 `[start, endExclusive)`。 */
export function shanghaiMonthBounds(month: string): { start: Date; endExclusive: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`${month} 不是合法月份`);
  const [year, monthNumber] = month.split("-").map(Number);
  const nextYear = monthNumber === 12 ? year! + 1 : year!;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber! + 1;
  return {
    start: new Date(`${month}-01T00:00:00+08:00`),
    endExclusive: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`),
  };
}

/**
 * 守恒窗口涉及的月份（PFH-05：切换时点至候选水位，覆盖所有涉及月份）。
 * 首月起点不早于切换时点，末月终点不晚于候选水位；
 * 末月被截断时终点取 `snapshot_at + 1ms`，使比较式 `>= start AND < end` 恰好包含该瞬间。
 */
export interface ConservationMonth {
  month: string;
  start: string;
  endExclusive: string;
  /** true 表示该月被候选水位截断（未走完整个自然月）。 */
  clipped: boolean;
}

export function conservationMonths(cutoverIso: string, snapshotAtIso: string): ConservationMonth[] {
  const cutover = new Date(cutoverIso);
  const snapshotAt = new Date(snapshotAtIso);
  if (Number.isNaN(cutover.getTime()) || Number.isNaN(snapshotAt.getTime())) {
    throw new Error("守恒窗口边界不是合法时间");
  }
  if (snapshotAt.getTime() < cutover.getTime()) throw new Error("候选水位不得早于切换时点");
  const firstMonth = shanghaiMonthOf(cutover);
  const lastMonth = shanghaiMonthOf(snapshotAt);
  const months: ConservationMonth[] = [];
  let cursor = firstMonth;
  // 月份单调递增；计数上限避免非法输入造成死循环。
  for (let guard = 0; guard < 1200; guard += 1) {
    const bounds = shanghaiMonthBounds(cursor);
    const start = bounds.start.getTime() < cutover.getTime() ? cutover : bounds.start;
    const monthEnd = bounds.endExclusive;
    const clipped = monthEnd.getTime() > snapshotAt.getTime();
    months.push({
      month: cursor,
      start: start.toISOString(),
      endExclusive: (clipped ? new Date(snapshotAt.getTime() + 1) : monthEnd).toISOString(),
      clipped,
    });
    if (cursor === lastMonth) break;
    const [year, monthNumber] = cursor.split("-").map(Number);
    cursor = monthNumber === 12 ? `${year! + 1}-01` : `${year}-${String(monthNumber! + 1).padStart(2, "0")}`;
  }
  return months;
}

// ===== 经营账单缺口的草稿增量抵消 =====

const MONTHLY_GAP_CODES = [
  "API_USAGE_COST_UNKNOWN", "API_COST_CURRENCY_MISSING", "API_COST_CURRENCY_CONFLICT",
  "OPENING_BALANCE_MISSING", "SUBSCRIPTION_PERIOD_MISSING", "CASH_PAID_CNY_MISSING",
] as const;

export function mapMonthlyGapCode(code: string): ActivationGapCode {
  switch (code) {
    case "API_USAGE_COST_UNKNOWN": return "UNKNOWN_COST";
    case "API_COST_CURRENCY_MISSING": return "MISSING_API_CURRENCY";
    case "API_COST_CURRENCY_CONFLICT": return "CONFLICTING_API_CURRENCY";
    case "OPENING_BALANCE_MISSING": return "MISSING_OPENING_BALANCE";
    case "SUBSCRIPTION_PERIOD_MISSING": return "UNATTRIBUTED_PLAN_USAGE";
    case "CASH_PAID_CNY_MISSING": return "MISSING_RECHARGE_CASH_PAID";
    default: return "INCOMPLETE_OPERATING_BILL";
  }
}

/**
 * 逐月缺口 = 权威 SQL 口径的真实缺口 − 草稿与修复带来的抵消数。
 *
 * 只做计数抵消，不重新定义缺口规则；抵消数必须可追溯到具体草稿行或具体用量行。
 * 抵消数被 `Math.min` 限制在真实计数以内，因此**只可能减少已知缺口，不可能掩盖真实缺口**。
 */
export function computeMonthlyGapDeltas(
  input: ActivationProjectionInput,
  plan: UsageRepairPlan,
  draftOpeningKeys: ReadonlySet<string>,
  window: readonly ConservationMonth[],
): Array<{ month: string; gaps: string[] }> {
  const realByMonth = new Map(input.monthlyGaps.map((entry) => [entry.month, entry.gaps]));
  return window.map((entry) => {
    const real = new Map((realByMonth.get(entry.month) ?? []).map((row) => [row.code, row.count]));
    const closed = new Map<string, number>(MONTHLY_GAP_CODES.map((code) => [code, 0]));

    let unknownClosed = 0;
    let currencyMissingClosed = 0;
    let currencyConflictClosed = 0;
    let periodMissingClosed = 0;
    const pricedAccountsInMonth = new Set<string>();
    for (const line of input.ledgerLines) {
      if (!isWithin(ledgerEffectiveAt(line), entry.start, entry.endExclusive)) continue;
      const repaired = plan.repairByLine.get(line.id);
      if (repaired) {
        if (line.apiCostStatus === null && (repaired.apiCostStatus === "PRICED_USAGE"
          || (line.apiCost === null && repaired.apiCostStatus === "CONFIRMED_ZERO_NO_UPSTREAM"))) {
          unknownClosed += 1;
        }
        if (line.apiCostCurrency === null && repaired.apiCostCurrency !== null) currencyMissingClosed += 1;
        if (line.apiCostCurrency !== null && repaired.apiCostCurrency !== null
          && repaired.apiCostCurrency === line.billingRuleSnapshotCurrency) currencyConflictClosed += 1;
        if (line.subscriptionPeriodId === null && repaired.subscriptionPeriodId !== null) periodMissingClosed += 1;
      }
      if (line.resourceMode !== "API" || !line.operatingConsumption) continue;
      const status = repaired?.apiCostStatus ?? line.apiCostStatus;
      const currency = repaired ? repaired.apiCostCurrency : line.apiCostCurrency;
      if (status === "PRICED_USAGE" && currency !== null) {
        pricedAccountsInMonth.add(accountKey(line.resourceId, currency));
      }
    }
    closed.set("API_USAGE_COST_UNKNOWN", unknownClosed);
    closed.set("API_COST_CURRENCY_MISSING", currencyMissingClosed);
    closed.set("API_COST_CURRENCY_CONFLICT", currencyConflictClosed);
    closed.set("SUBSCRIPTION_PERIOD_MISSING", periodMissingClosed);
    // 只有草稿新补的账户才能抵消该月缺口；已有事实造成的缺口由权威 SQL 计数负责，不得再次抵扣。
    closed.set("OPENING_BALANCE_MISSING",
      [...draftOpeningKeys].filter((key) => pricedAccountsInMonth.has(key)).length);
    closed.set("CASH_PAID_CNY_MISSING",
      [...input.draft.historicalApiRecharges.map((row) => row.occurredAt),
        ...input.draft.codingPlanPurchases.map((row) => row.occurredAt)]
        .filter((occurredAt) => isWithin(occurredAt, entry.start, entry.endExclusive)).length);

    const remaining = MONTHLY_GAP_CODES.filter((code) => {
      const count = real.get(code) ?? 0;
      if (count <= 0) return false;
      return count - Math.min(count, closed.get(code) ?? 0) > 0;
    });
    return { month: entry.month, gaps: [...remaining] };
  });
}

/** Coding Plan 用量唯一归属（PFH-03）。 */
export function collectPlanAttributionGaps(plan: UsageRepairPlan, gaps: ActivationGap[]): void {
  for (const ambiguous of plan.ambiguousPeriodLines) {
    gaps.push(gap("OVERLAPPING_PERIOD", "PERIOD",
      "同一套餐用量被多个未冲销周期覆盖，无法唯一归属", {
        resourceId: ambiguous.line.resourceId, ledgerLineId: ambiguous.line.id,
        detail: ambiguous.periodIds.join(","),
      }));
  }
  for (const line of plan.unattributedPlanLines) {
    gaps.push(gap("UNATTRIBUTED_PLAN_USAGE", "USAGE",
      "套餐用量没有任何覆盖周期，无法唯一归属", {
        resourceId: line.resourceId, ledgerLineId: line.id,
        month: shanghaiMonthOf(ledgerEffectiveAt(line)),
      }));
  }
}

/** 用量费用分类与 Token 守恒（失败关闭 #4、#6）；返回 Token 是否守恒。 */
export function collectUsageClassificationGaps(
  input: ActivationProjectionInput, plan: UsageRepairPlan, gaps: ActivationGap[],
): boolean {
  let tokenConserved = true;
  const usageEventById = new Map(input.usageEvents.map((usage) => [usage.id, usage]));
  for (const line of [...input.ledgerLines].sort((left, right) => compareStrings(left.id, right.id))) {
    const repaired = plan.repairByLine.get(line.id);
    const statusAfter = repaired?.apiCostStatus ?? line.apiCostStatus;
    const currencyAfter = repaired ? repaired.apiCostCurrency : line.apiCostCurrency;
    if (line.resourceMode === "API") {
      if ((statusAfter === "UNKNOWN_COST"
        || (statusAfter === null && (line.apiCost === null || hasTokens(line))))
        && !line.legacyCostResolved) {
        gaps.push(gap("UNKNOWN_COST", "USAGE", "API 用量费用状态未明确（UNKNOWN_COST）", {
          resourceId: line.resourceId, ledgerLineId: line.id,
          month: shanghaiMonthOf(ledgerEffectiveAt(line)),
        }));
      }
      if (line.apiCost !== null && currencyAfter === null
        && statusAfter !== "CONFIRMED_ZERO_NO_UPSTREAM") {
        gaps.push(gap("MISSING_API_CURRENCY", "USAGE", "已定价 API 用量缺少结算币种",
          { resourceId: line.resourceId, ledgerLineId: line.id }));
      }
      if (currencyAfter !== null && line.billingRuleSnapshotCurrency !== null
        && currencyAfter !== line.billingRuleSnapshotCurrency) {
        gaps.push(gap("CONFLICTING_API_CURRENCY", "USAGE", "结算币种与计价规则快照币种冲突", {
          resourceId: line.resourceId, ledgerLineId: line.id,
          detail: `${currencyAfter} vs ${line.billingRuleSnapshotCurrency}`,
        }));
      }
      if ((repaired?.settledAt ?? line.settledAt) === null) {
        gaps.push(gap("MISSING_SETTLEMENT_TIME", "USAGE", "用量缺少结算时间",
          { resourceId: line.resourceId, ledgerLineId: line.id }));
      }
    }
    const usage = usageEventById.get(line.usageEventId);
    const tokensMatch = usage !== undefined
      && usage.inputTokens === line.rawInputTokens
      && usage.outputTokens === line.rawOutputTokens
      && usage.cacheTokens === line.rawCacheTokens
      && usage.reasoningTokens === line.rawReasoningTokens;
    if (!tokensMatch) {
      tokenConserved = false;
      gaps.push(gap("TOKEN_CONSERVATION_MISMATCH", "TOKEN", "Usage 与 Ledger Token 不守恒",
        { resourceId: line.resourceId, ledgerLineId: line.id }));
    }
  }
  return tokenConserved;
}
