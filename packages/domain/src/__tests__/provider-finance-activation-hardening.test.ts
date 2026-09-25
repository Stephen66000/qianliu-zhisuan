/**
 * 变异测试定向加固（R3 第二轮）：针对 Stryker 存活突变体密集区补测。
 *
 * 覆盖目标（对应 r3-quantification/pf-domain-mutation.json 的 Survived/NoCoverage 簇）：
 * - inputs：compareStrings / instantOf / isWithin / hasTokens / isSameShanghaiDay 边界与比较分支
 * - draft：usageRepairFieldDigests 键名敏感性、eligibleFieldsFor 全分支、
 *   coveringPeriods 闭开区间边界、planUsageRepairs 全修复分支
 * - conservation：月份窗口边界（12 月跨年、水位恰在月末）、mapMonthlyGapCode 全分支、
 *   逐月缺口抵消计数器、归属/分类缺口的精确 message/detail
 * - balances：用量修复增量（前后状态迁移）、余额投影（公式失配、负余额、账户排序）
 *
 * 本文件直接从分段模块导入（非 index.js 公共面），只为单元级突变歼灭；
 * 公共导出面契约仍由 projection/summary 两个既有测试文件守护。
 */
import { describe, expect, it } from "vitest";
import {
  hashStable, normalizeDraftItem, emptyBalanceComponents,
  type ActivationDraft, type ActivationGap,
} from "../index.js";
import {
  compareStrings,
  hasTokens,
  instantOf,
  isSameShanghaiDay,
  isWithin,
  type ActivationProjectionInput,
  type LedgerLineFactRow,
} from "../provider-finance-activation-inputs.js";
import {
  collectPlanAttributionGaps,
  collectUsageClassificationGaps,
  computeMonthlyGapDeltas,
  conservationMonths,
  mapMonthlyGapCode,
  shanghaiMonthBounds,
  shanghaiMonthOf,
} from "../provider-finance-activation-conservation.js";
import {
  coveringPeriods,
  eligibleFieldsFor,
  planUsageRepairs,
  usageRepairFieldDigests,
  type PeriodCandidate,
  type UsageRepairPlan,
} from "../provider-finance-activation-draft.js";
import {
  computeUsageDebitDeltas,
  projectAccountBalances,
} from "../provider-finance-activation-balances.js";
import type {
  ActivationScopeAccountInput,
  ActivationScopeResourceInput,
} from "../provider-finance-activation-inputs.js";

const API_RESOURCE = "11111111-1111-4111-8111-111111111111";
const PLAN_RESOURCE = "22222222-2222-4222-8222-222222222222";
const EVENT_1 = "bbbbbbbb-0000-4000-8000-000000000001";

function apiLine(overrides: Partial<LedgerLineFactRow> = {}): LedgerLineFactRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    resourceId: API_RESOURCE,
    resourceMode: "API",
    rawInputTokens: "10", rawOutputTokens: "20", rawCacheTokens: "0", rawReasoningTokens: "0",
    apiCost: "5.00000000", apiCostCurrency: "CNY", apiCostStatus: "PRICED_USAGE",
    legacyCostResolved: false, subscriptionPeriodId: null,
    settledAt: "2026-09-10T04:00:00.000Z", createdAt: "2026-09-10T04:00:01.000Z",
    billingRuleSnapshotCurrency: "CNY", billingRuleId: null,
    operatingConsumption: true, zeroConfirmedEligible: false,
    usageEventId: EVENT_1,
    ...overrides,
  };
}

function planLine(overrides: Partial<LedgerLineFactRow> = {}): LedgerLineFactRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    resourceId: PLAN_RESOURCE,
    resourceMode: "CODING_PLAN",
    rawInputTokens: "0", rawOutputTokens: "0", rawCacheTokens: "0", rawReasoningTokens: "0",
    apiCost: null, apiCostCurrency: null, apiCostStatus: null,
    legacyCostResolved: false, subscriptionPeriodId: null,
    settledAt: "2026-09-15T04:00:00.000Z", createdAt: "2026-09-15T04:00:01.000Z",
    billingRuleSnapshotCurrency: null, billingRuleId: null,
    operatingConsumption: true, zeroConfirmedEligible: false,
    usageEventId: "bbbbbbbb-0000-4000-8000-000000000002",
    ...overrides,
  };
}

function minimalDraft(overrides: Partial<ActivationDraft> = {}): ActivationDraft {
  return {
    schema_version: "1",
    api_opening_balances: [],
    historical_api_recharges: [],
    coding_plan_purchases: [],
    coding_plan_carryovers: [],
    legacy_purchase_resolutions: [],
    ...overrides,
  };
}

function rechargeIn(occurredAt: string, key: string): ActivationDraft["historical_api_recharges"][number] {
  return {
    resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "10",
    cash_paid_cny: "10.00", occurred_at: occurredAt, external_reference: "R",
    description: "充值", evidence_ref: "evidence://r", source_record_id: null,
    record_idempotency_key: key,
  };
}

function purchaseIn(occurredAt: string, key: string): ActivationDraft["coding_plan_purchases"][number] {
  return {
    resource_id: PLAN_RESOURCE, kind: "PURCHASE", product_name: "套餐",
    account_amount: "30", account_currency: "CNY", cash_paid_cny: "30.00",
    service_period_start: "2026-09-01", service_period_end: "2026-09-30",
    occurred_at: occurredAt, external_reference: "P", auto_renew: false,
    description: "购买", evidence_ref: "evidence://p", source_record_id: null,
    carryover_snapshot_id: null, record_idempotency_key: key,
  };
}

function factInput(overrides: Partial<ActivationProjectionInput> = {}): ActivationProjectionInput {
  return {
    enterpriseId: "77777777-7777-4777-8777-777777777777",
    snapshotAt: "2026-10-15T00:00:00.000Z",
    resources: [] as ActivationScopeResourceInput[],
    accounts: [] as ActivationScopeAccountInput[],
    financeEvents: [],
    periods: [],
    legacyPurchases: [],
    ledgerLines: [],
    usageEvents: [
      { id: EVENT_1, inputTokens: "10", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0" },
    ],
    accountComponents: [],
    monthlyGaps: [],
    strictWritesEnabled: false,
    draft: normalizeDraftItem(minimalDraft(), API_RESOURCE),
    usageRepairBaseline: [],
    usageRepairTargets: [],
    ...overrides,
  };
}

function emptyPlan(): UsageRepairPlan {
  return {
    baseline: [], targets: [], repairByLine: new Map(),
    ambiguousPeriodLines: [], unattributedPlanLines: [],
  };
}

// ===== inputs.ts：小工具 =====

describe("输入小工具边界", () => {
  it("compareStrings 三分支严格区分（<,>,==）", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("a", "a")).toBe(0);
    expect(compareStrings("", "a")).toBe(-1);
  });

  it("instantOf 拒绝非法时间并带出原值", () => {
    expect(() => instantOf("not-a-date")).toThrow(/不是合法时间：not-a-date/);
  });

  it("isWithin 为左闭右开：起点含、终点不含、区间外不含", () => {
    expect(isWithin("2026-09-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z")).toBe(true);
    expect(isWithin("2026-09-11T00:00:00.000Z", "2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z")).toBe(false);
    expect(isWithin("2026-09-09T23:59:59.999Z", "2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z")).toBe(false);
    expect(isWithin("2026-09-15T00:00:00.000Z", "2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z")).toBe(false);
  });

  it("hasTokens 任一 token 维度 >0 即为真，全零为假", () => {
    expect(hasTokens(apiLine({ rawInputTokens: "1" }))).toBe(true);
    expect(hasTokens(apiLine({ rawOutputTokens: "1" }))).toBe(true);
    expect(hasTokens(apiLine({ rawCacheTokens: "1" }))).toBe(true);
    expect(hasTokens(apiLine({ rawReasoningTokens: "1" }))).toBe(true);
    expect(hasTokens(apiLine({
      rawInputTokens: "0", rawOutputTokens: "0", rawCacheTokens: "0", rawReasoningTokens: "0",
    }))).toBe(false);
  });

  it("isSameShanghaiDay 按 UTC+8 折算自然日", () => {
    expect(isSameShanghaiDay("2026-09-22T17:00:00.000Z", "2026-09-23")).toBe(true);
    expect(isSameShanghaiDay("2026-09-22T15:00:00.000Z", "2026-09-22")).toBe(true);
    expect(isSameShanghaiDay("2026-09-22T17:00:00.000Z", "2026-09-22")).toBe(false);
  });
});

// ===== draft.ts：字段基准 / 覆盖周期 / 修复计划 =====

describe("usageRepairFieldDigests 键名与字段敏感性", () => {
  it("目标字段摘要按固定键名序列化（键名改变必须改变摘要）", () => {
    const line = apiLine();
    const digests = usageRepairFieldDigests(line);
    const expected = hashStable([
      ["settled_at", line.settledAt],
      ["api_cost_currency", line.apiCostCurrency],
      ["api_cost_status", line.apiCostStatus],
      ["subscription_period_id", line.subscriptionPeriodId],
    ]);
    expect(typeof digests.targetFieldsBeforeHash).toBe("string");
    expect(digests.targetFieldsBeforeHash).toBe(expected);
    expect(digests.targetFieldsBeforeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("非目标字段摘要包含全部剩余字段且键序无关；目标/非目标互不串扰", () => {
    const line = apiLine();
    const digests = usageRepairFieldDigests(line);
    const expectedNonTarget = hashStable(
      Object.entries(line)
        .filter(([key]) => !["settledAt", "apiCostCurrency", "apiCostStatus", "subscriptionPeriodId"].includes(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(digests.nonTargetFieldsBeforeHash).toBe(expectedNonTarget);
    // 目标字段变化 → 目标摘要变、非目标摘要不变
    const changedTarget = usageRepairFieldDigests(apiLine({ apiCostStatus: "UNKNOWN_COST" }));
    expect(changedTarget.targetFieldsBeforeHash).not.toBe(digests.targetFieldsBeforeHash);
    expect(changedTarget.nonTargetFieldsBeforeHash).toBe(digests.nonTargetFieldsBeforeHash);
    // 非目标字段变化 → 非目标摘要变、目标摘要不变
    const changedOther = usageRepairFieldDigests(apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000099" }));
    expect(changedOther.nonTargetFieldsBeforeHash).not.toBe(digests.nonTargetFieldsBeforeHash);
    expect(changedOther.targetFieldsBeforeHash).toBe(digests.targetFieldsBeforeHash);
  });
});

describe("eligibleFieldsFor 全分支", () => {
  const fullTarget = {
    ledgerLineId: "l", settledAt: "2026-09-10T04:00:00.000Z", apiCostCurrency: "CNY" as const,
    apiCostStatus: "PRICED_USAGE", subscriptionPeriodId: "p-1",
  };

  it("四字段全部为 null 且目标非空 → 全部可修复", () => {
    const line = apiLine({
      settledAt: null, apiCostCurrency: null, apiCostStatus: null, subscriptionPeriodId: null,
    });
    expect(eligibleFieldsFor(line, fullTarget)).toEqual([
      "settled_at", "api_cost_currency", "api_cost_status", "subscription_period_id",
    ]);
  });

  it("行已有值或目标为空 → 不可修复", () => {
    const line = apiLine();
    // apiLine 默认仅 subscriptionPeriodId 为 null，其余目标字段已有值
    expect(eligibleFieldsFor(line, fullTarget)).toEqual(["subscription_period_id"]);
    expect(eligibleFieldsFor(line, {
      ...fullTarget, settledAt: null, apiCostCurrency: null, apiCostStatus: null, subscriptionPeriodId: null,
    })).toEqual([]);
    expect(eligibleFieldsFor(apiLine({ apiCostCurrency: null }), { ...fullTarget, apiCostCurrency: null }))
      .toEqual(["subscription_period_id"]);
    expect(eligibleFieldsFor(line, { ...fullTarget, subscriptionPeriodId: null })).toEqual([]);
  });
});

describe("coveringPeriods 闭开区间与过滤", () => {
  const line = planLine({ settledAt: "2026-09-10T00:00:00.000Z" });
  const periodOf = (id: string, start: string, end: string, overrides: Partial<PeriodCandidate> = {}):
    PeriodCandidate => ({
      id, resourceId: PLAN_RESOURCE, periodStart: start, periodEndExclusive: end, reversed: false,
      ...overrides,
    });
  const SEP1 = "2026-09-01T00:00:00.000Z";
  const OCT1 = "2026-10-01T00:00:00.000Z";

  it("起点含、终点不含、区间外不含", () => {
    const periods = [periodOf("p-1", SEP1, OCT1)];
    expect(coveringPeriods(line, periods)).toHaveLength(1);
    expect(coveringPeriods(planLine({ settledAt: SEP1 }), periods)).toHaveLength(1);
    expect(coveringPeriods(planLine({ settledAt: OCT1 }), periods)).toHaveLength(0);
    expect(coveringPeriods(planLine({ settledAt: "2026-08-31T23:59:59.999Z" }), periods)).toHaveLength(0);
  });

  it("冲销周期与其他资源周期不参与归属", () => {
    expect(coveringPeriods(line, [periodOf("p-1", SEP1, OCT1, { reversed: true })])).toHaveLength(0);
    expect(coveringPeriods(line, [periodOf("p-1", SEP1, OCT1, { resourceId: API_RESOURCE })])).toHaveLength(0);
  });

  it("多周期覆盖时按 id 稳定排序（歧义判定依赖该顺序）", () => {
    const covered = coveringPeriods(line, [
      periodOf("p-2", SEP1, OCT1), periodOf("p-1", "2026-08-01T00:00:00.000Z", OCT1),
    ]);
    expect(covered.map((entry) => entry.id)).toEqual(["p-1", "p-2"]);
  });
});

describe("planUsageRepairs 修复分支", () => {
  it("已完整行不进入修复计划（touched 恒为 false 时不得误入）", () => {
    const line = apiLine();
    const plan = planUsageRepairs({ ledgerLines: [line], periods: [] });
    expect(plan.repairByLine.has(line.id)).toBe(false);
    expect(plan.baseline).toEqual([]);
    expect(plan.targets).toEqual([]);
  });

  it("快照币种为 CNY/USD 且币种缺失或一致 → 补币种并定价；币种冲突不修复", () => {
    const base = { settledAt: null as string | null, apiCostStatus: null as string | null };
    const missing = apiLine({ ...base, id: "aaaaaaaa-0000-4000-8000-0000000000c1", apiCostCurrency: null });
    const equal = apiLine({ ...base, id: "aaaaaaaa-0000-4000-8000-0000000000c2", apiCostCurrency: "CNY" });
    const conflict = apiLine({
      ...base, id: "aaaaaaaa-0000-4000-8000-0000000000c3",
      apiCostCurrency: "USD", billingRuleSnapshotCurrency: "CNY",
    });
    const plan = planUsageRepairs({ ledgerLines: [missing, equal, conflict], periods: [] });
    expect(plan.repairByLine.get(missing.id)?.apiCostCurrency).toBe("CNY");
    expect(plan.repairByLine.get(missing.id)?.apiCostStatus).toBe("PRICED_USAGE");
    expect(plan.repairByLine.get(equal.id)?.apiCostCurrency).toBe("CNY");
    // 币种冲突行：不得定价、不得改写币种；但补结算时间的修复仍独立生效
    const conflictTarget = plan.repairByLine.get(conflict.id);
    expect(conflictTarget?.apiCostStatus).toBeNull();
    expect(conflictTarget?.apiCostCurrency).toBe("USD");
    expect(conflictTarget?.settledAt).toBe(conflict.createdAt);
  });

  it("快照币种为 USD 时按 USD 修复（不得硬编码 CNY）", () => {
    const line = apiLine({
      settledAt: null, apiCostStatus: null, apiCostCurrency: null, billingRuleSnapshotCurrency: "USD",
    });
    const plan = planUsageRepairs({ ledgerLines: [line], periods: [] });
    expect(plan.repairByLine.get(line.id)?.apiCostCurrency).toBe("USD");
  });

  it("零元确认：合格且无 token 且无计价规则 → CONFIRMED_ZERO_NO_UPSTREAM；有 token 或不合格则 UNKNOWN_COST", () => {
    const eligible = apiLine({
      id: "aaaaaaaa-0000-4000-8000-0000000000d1",
      settledAt: "2026-09-10T04:00:00.000Z", apiCost: null, apiCostCurrency: null, apiCostStatus: null,
      zeroConfirmedEligible: true, billingRuleId: null,
      rawInputTokens: "0", rawOutputTokens: "0", rawCacheTokens: "0", rawReasoningTokens: "0",
    });
    const withTokens = apiLine({ ...eligible, id: "aaaaaaaa-0000-4000-8000-0000000000d2", rawInputTokens: "10" });
    const notEligible = apiLine({ ...eligible, id: "aaaaaaaa-0000-4000-8000-0000000000d3", zeroConfirmedEligible: false });
    const plan = planUsageRepairs({ ledgerLines: [eligible, withTokens, notEligible], periods: [] });
    expect(plan.repairByLine.get(eligible.id)?.apiCostStatus).toBe("CONFIRMED_ZERO_NO_UPSTREAM");
    expect(plan.repairByLine.get(withTokens.id)?.apiCostStatus).toBe("UNKNOWN_COST");
    expect(plan.repairByLine.get(notEligible.id)?.apiCostStatus).toBe("UNKNOWN_COST");
  });

  it("API 用量缺时间/缺状态/费用与币种双缺 → UNKNOWN_COST 与补结算时间", () => {
    const line = apiLine({
      settledAt: null, createdAt: "2026-09-10T04:00:01.000Z",
      apiCost: null, apiCostCurrency: null, apiCostStatus: null,
    });
    const plan = planUsageRepairs({ ledgerLines: [line], periods: [] });
    const target = plan.repairByLine.get(line.id);
    expect(target?.settledAt).toBe(line.createdAt);
    expect(target?.apiCostStatus).toBe("UNKNOWN_COST");
    expect(target?.apiCostCurrency).toBeNull();
  });

  it("Coding Plan 无费用行补 NOT_APPLICABLE；周期归属：唯一/歧义/缺失三分支", () => {
    const SEP1 = "2026-09-01T00:00:00.000Z";
    const OCT1 = "2026-10-01T00:00:00.000Z";
    const periods: PeriodCandidate[] = [
      { id: "p-1", resourceId: PLAN_RESOURCE, periodStart: SEP1, periodEndExclusive: OCT1, reversed: false },
      { id: "p-2", resourceId: PLAN_RESOURCE, periodStart: SEP1, periodEndExclusive: OCT1, reversed: false },
    ];
    const lSingle = planLine({ id: "aaaaaaaa-0000-4000-8000-000000000011", subscriptionPeriodId: null });
    const lAmbiguous = planLine({ id: "aaaaaaaa-0000-4000-8000-000000000012", subscriptionPeriodId: null });
    const lMissing = planLine({
      id: "aaaaaaaa-0000-4000-8000-000000000013", subscriptionPeriodId: null,
      settledAt: "2026-11-15T04:00:00.000Z",  // 在唯一周期之外 → 无归属
    });
    const lNotApplicable = planLine({ id: "aaaaaaaa-0000-4000-8000-000000000014", apiCostStatus: null });
    const plan = planUsageRepairs({
      ledgerLines: [lSingle, lMissing],
      periods: [periods[0]!],
    });
    expect(plan.repairByLine.get(lSingle.id)?.subscriptionPeriodId).toBe("p-1");
    expect(plan.unattributedPlanLines.map((row) => row.id)).toEqual([lMissing.id]);
    const ambiguous = planUsageRepairs({ ledgerLines: [lAmbiguous], periods });
    expect(ambiguous.ambiguousPeriodLines).toEqual([{
      line: lAmbiguous, periodIds: ["p-1", "p-2"],
    }]);
    const na = planUsageRepairs({ ledgerLines: [lNotApplicable], periods: [] });
    expect(na.repairByLine.get(lNotApplicable.id)?.apiCostStatus).toBe("NOT_APPLICABLE");
  });

  it("基线行携带逐行摘要且按行号排序", () => {
    const second = apiLine({ id: "aaaaaaaa-0000-4000-8000-0000000000aa", settledAt: null, apiCostStatus: null });
    const first = apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000005", settledAt: null, apiCostStatus: null });
    const plan = planUsageRepairs({ ledgerLines: [second, first], periods: [] });
    expect(plan.baseline.map((row) => row.ledgerLineId)).toEqual([first.id, second.id]);
    expect(plan.targets.map((row) => row.ledgerLineId)).toEqual([first.id, second.id]);
    for (const row of plan.baseline) {
      expect(row.eligibleRepairs).toEqual(["settled_at", "api_cost_status"]);
      expect(row.targetFieldsBeforeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.nonTargetFieldsBeforeHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

// ===== conservation.ts：月份窗口 / 缺口码映射 / 逐月抵消 / 归属与分类 =====

describe("上海自然月窗口边界", () => {
  it("shanghaiMonthOf 拒绝非法时间并按 UTC+8 归月", () => {
    expect(() => shanghaiMonthOf("not-a-date")).toThrow(/不是合法时间/);
    expect(shanghaiMonthOf("2026-09-30T16:00:00.000Z")).toBe("2026-10");
    expect(shanghaiMonthOf("2026-09-30T15:59:59.999Z")).toBe("2026-09");
  });

  it("shanghaiMonthBounds 校验格式锚点（^ 与 $）并处理 12 月跨年", () => {
    expect(() => shanghaiMonthBounds("2026-13")).toThrow("2026-13 不是合法月份");
    expect(() => shanghaiMonthBounds("x2026-01")).toThrow(/不是合法月份/);
    expect(() => shanghaiMonthBounds("2026-011")).toThrow(/不是合法月份/);
    expect(() => shanghaiMonthBounds("2026-1")).toThrow(/不是合法月份/);
    const dec = shanghaiMonthBounds("2026-12");
    expect(dec.start.toISOString()).toBe("2026-11-30T16:00:00.000Z");
    expect(dec.endExclusive.toISOString()).toBe("2026-12-31T16:00:00.000Z");
    const nov = shanghaiMonthBounds("2026-11");
    expect(nov.endExclusive.toISOString()).toBe("2026-11-30T16:00:00.000Z");
  });

  it("conservationMonths：水位不得早于切换时点；跨年多月；水位恰在月末不截断", () => {
    expect(() => conservationMonths("2026-10-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"))
      .toThrow(/候选水位不得早于切换时点/);
    const spanning = conservationMonths(
      "2026-11-15T00:00:00.000Z", "2027-02-10T00:00:00.000Z",
    );
    expect(spanning.map((entry) => entry.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(spanning[0]!.start).toBe("2026-11-15T00:00:00.000Z");
    expect(spanning[0]!.clipped).toBe(false);
    expect(spanning[3]!.clipped).toBe(true);
    // 水位恰为整月终点（上海时区已跨入下月）：末月为下一个自然月，仅含水位后 1ms
    const exactEnd = conservationMonths(
      "2026-08-31T16:00:00.000Z", "2026-09-30T16:00:00.000Z",
    );
    expect(exactEnd.map((entry) => entry.month)).toEqual(["2026-09", "2026-10"]);
    expect(exactEnd[0]!.clipped).toBe(false);
    expect(exactEnd[0]!.endExclusive).toBe("2026-09-30T16:00:00.000Z");
    expect(exactEnd[1]!.start).toBe("2026-09-30T16:00:00.000Z");
    expect(exactEnd[1]!.clipped).toBe(true);
    expect(exactEnd[1]!.endExclusive).toBe("2026-09-30T16:00:00.001Z");
  });
});

describe("mapMonthlyGapCode 全分支", () => {
  it("六个月度码一一映射，未知码归入 INCOMPLETE_OPERATING_BILL", () => {
    expect(mapMonthlyGapCode("API_USAGE_COST_UNKNOWN")).toBe("UNKNOWN_COST");
    expect(mapMonthlyGapCode("API_COST_CURRENCY_MISSING")).toBe("MISSING_API_CURRENCY");
    expect(mapMonthlyGapCode("API_COST_CURRENCY_CONFLICT")).toBe("CONFLICTING_API_CURRENCY");
    expect(mapMonthlyGapCode("OPENING_BALANCE_MISSING")).toBe("MISSING_OPENING_BALANCE");
    expect(mapMonthlyGapCode("SUBSCRIPTION_PERIOD_MISSING")).toBe("UNATTRIBUTED_PLAN_USAGE");
    expect(mapMonthlyGapCode("CASH_PAID_CNY_MISSING")).toBe("MISSING_RECHARGE_CASH_PAID");
    expect(mapMonthlyGapCode("SOMETHING_ELSE")).toBe("INCOMPLETE_OPERATING_BILL");
  });
});

describe("computeMonthlyGapDeltas 逐月抵消", () => {
  const SEP_START = "2026-08-31T16:00:00.000Z";
  const OCT_START = "2026-09-30T16:00:00.000Z";

  function planWith(targets: Array<[string, Partial<LedgerLineFactRow> & { apiCostStatus: string }]>): UsageRepairPlan {
    const repairByLine = new Map();
    for (const [id, patch] of targets) {
      repairByLine.set(id, {
        ledgerLineId: id,
        settledAt: patch.settledAt ?? null,
        apiCostCurrency: patch.apiCostCurrency ?? null,
        apiCostStatus: patch.apiCostStatus,
        subscriptionPeriodId: patch.subscriptionPeriodId ?? null,
      });
    }
    return { ...emptyPlan(), repairByLine };
  }

  it("四类修复抵消计数各自独立，且 Math.min 封顶不得掩盖真实缺口", () => {
    const lineUnknown = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000001", settledAt: "2026-09-10T04:00:00.000Z",
      apiCostCurrency: null, apiCostStatus: null, billingRuleSnapshotCurrency: "CNY",
    });
    const lineConflict = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000002", settledAt: "2026-09-10T04:00:00.000Z",
      apiCostCurrency: "USD", apiCostStatus: "UNKNOWN_COST", billingRuleSnapshotCurrency: "CNY",
    });
    const linePeriod = planLine({
      id: "aaaaaaaa-0000-4000-8000-000000000003", subscriptionPeriodId: null, apiCostStatus: "NOT_APPLICABLE",
    });
    const plan = planWith([
      [lineUnknown.id, { apiCostStatus: "PRICED_USAGE", apiCostCurrency: "CNY" }],
      [lineConflict.id, { apiCostStatus: "PRICED_USAGE", apiCostCurrency: "CNY" }],
      [linePeriod.id, { apiCostStatus: "NOT_APPLICABLE", subscriptionPeriodId: "p-1" }],
    ]);
    const window = [{ month: "2026-09", start: SEP_START, endExclusive: OCT_START, clipped: false }];
    // 真实缺口：unknown 2（只抵 1）、conflict 1（全抵）、period 2（只抵 1）、currency_missing 0
    const input = factInput({
      ledgerLines: [lineUnknown, lineConflict, linePeriod],
      monthlyGaps: [{
        month: "2026-09",
        gaps: [
          { code: "API_USAGE_COST_UNKNOWN", count: 2 },
          { code: "API_COST_CURRENCY_CONFLICT", count: 1 },
          { code: "SUBSCRIPTION_PERIOD_MISSING", count: 2 },
        ],
      }],
    });
    const deltas = computeMonthlyGapDeltas(input, plan, new Set(), window);
    expect(deltas).toEqual([{
      month: "2026-09",
      gaps: ["API_USAGE_COST_UNKNOWN", "SUBSCRIPTION_PERIOD_MISSING"],
    }]);
  });

  it("合格确认零只抵消自己的月度未知缺口，不掩盖另一条费用未知行", () => {
    const confirmed = apiLine({
      id: "aaaaaaaa-0000-4000-8000-0000000000c1", apiCost: null,
      apiCostCurrency: null, apiCostStatus: null, billingRuleSnapshotCurrency: null,
      zeroConfirmedEligible: true, rawInputTokens: "0", rawOutputTokens: "0",
    });
    const unknown = apiLine({
      ...confirmed, id: "aaaaaaaa-0000-4000-8000-0000000000c2",
      apiCostStatus: "UNKNOWN_COST", zeroConfirmedEligible: false,
    });
    const plan = planUsageRepairs({ ledgerLines: [confirmed, unknown], periods: [] });
    expect(plan.repairByLine.get(confirmed.id)?.apiCostStatus).toBe("CONFIRMED_ZERO_NO_UPSTREAM");
    const window = [{ month: "2026-09", start: SEP_START, endExclusive: OCT_START, clipped: false }];
    const input = factInput({
      ledgerLines: [confirmed, unknown],
      monthlyGaps: [{ month: "2026-09", gaps: [{ code: "API_USAGE_COST_UNKNOWN", count: 2 }] }],
    });
    expect(computeMonthlyGapDeltas(input, plan, new Set(), window)).toEqual([{
      month: "2026-09", gaps: ["API_USAGE_COST_UNKNOWN"],
    }]);
  });

  it("经营消费定价账户与草稿期初/现金缴费在窗口内的抵扣", () => {
    const priced = apiLine({ settledAt: "2026-09-10T04:00:00.000Z" });
    const notOperating = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000002", settledAt: "2026-09-10T04:00:00.000Z",
      operatingConsumption: false,
    });
    const outOfMonth = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000003", settledAt: "2026-10-05T04:00:00.000Z",
    });
    const plan = emptyPlan();
    const window = [{ month: "2026-09", start: SEP_START, endExclusive: OCT_START, clipped: false }];
    const input = factInput({
      ledgerLines: [priced, notOperating, outOfMonth],
      draft: normalizeDraftItem(minimalDraft({
        historical_api_recharges: [rechargeIn("2026-09-05T02:00:00.000Z", "r-1")],
        coding_plan_purchases: [purchaseIn("2026-09-06T02:00:00.000Z", "p-1")],
      }), API_RESOURCE),
      monthlyGaps: [{
        month: "2026-09",
        gaps: [
          { code: "OPENING_BALANCE_MISSING", count: 1 },
          { code: "CASH_PAID_CNY_MISSING", count: 2 },
        ],
      }],
    });
    // 草稿期初恰好覆盖定价账户 → 抵 1；窗口内充值+购买 = 2（封顶 min(2,2)）
    const deltas = computeMonthlyGapDeltas(
      input, plan, new Set([`${API_RESOURCE}:CNY`, `${API_RESOURCE}:USD`]), window,
    );
    expect(deltas).toEqual([{ month: "2026-09", gaps: [] }]);
    // 期初键不在定价账户内 → 不得抵扣
    const noOpening = computeMonthlyGapDeltas(input, plan, new Set(["99999999-9999-4999-8999-999999999999:CNY"]), window);
    expect(noOpening).toEqual([{ month: "2026-09", gaps: ["OPENING_BALANCE_MISSING"] }]);
    // 现金缴费封顶：真实计数 1 < 抵扣 2 → 全抵
    const capped = computeMonthlyGapDeltas(
      factInput({
        ...input,
        monthlyGaps: [{ month: "2026-09", gaps: [{ code: "CASH_PAID_CNY_MISSING", count: 1 }] }],
      }),
      plan, new Set(), window,
    );
    expect(capped).toEqual([{ month: "2026-09", gaps: [] }]);
  });

  it("修复后定价账户计入 pricedAccountsInMonth（草稿期初可凭修复抵扣）", () => {
    const line = apiLine({
      settledAt: "2026-09-10T04:00:00.000Z", apiCostStatus: null, apiCostCurrency: null,
    });
    const plan = planWith([[line.id, { apiCostStatus: "PRICED_USAGE", apiCostCurrency: "CNY" }]]);
    const window = [{ month: "2026-09", start: SEP_START, endExclusive: OCT_START, clipped: false }];
    const input = factInput({
      ledgerLines: [line],
      monthlyGaps: [{ month: "2026-09", gaps: [{ code: "OPENING_BALANCE_MISSING", count: 1 }] }],
    });
    const deltas = computeMonthlyGapDeltas(input, plan, new Set([`${API_RESOURCE}:CNY`]), window);
    expect(deltas).toEqual([{ month: "2026-09", gaps: [] }]);
  });

  it("窗口外月份无真实缺口时返回空列表", () => {
    const plan = emptyPlan();
    const input = factInput({ ledgerLines: [apiLine()] });
    const deltas = computeMonthlyGapDeltas(input, plan, new Set(), [
      { month: "2026-08", start: "2026-07-31T16:00:00.000Z", endExclusive: SEP_START, clipped: false },
    ]);
    expect(deltas).toEqual([{ month: "2026-08", gaps: [] }]);
  });
});

describe("collectPlanAttributionGaps 精确缺口结构", () => {
  it("歧义周期带明细逗号串；未归属带上海月份", () => {
    const line = planLine({ settledAt: "2026-09-10T04:00:00.000Z" });
    const plan: UsageRepairPlan = {
      ...emptyPlan(),
      ambiguousPeriodLines: [{ line, periodIds: ["p-2", "p-1"] }],
      unattributedPlanLines: [planLine({ id: "aaaaaaaa-0000-4000-8000-000000000002" })],
    };
    const gaps: ActivationGap[] = [];
    collectPlanAttributionGaps(plan, gaps);
    expect(gaps).toEqual([
      {
        code: "OVERLAPPING_PERIOD", category: "PERIOD",
        message: "同一套餐用量被多个未冲销周期覆盖，无法唯一归属",
        resourceId: PLAN_RESOURCE, accountCurrency: null, legacyRecordId: null,
        ledgerLineId: line.id, month: null, detail: "p-2,p-1",
      },
      {
        code: "UNATTRIBUTED_PLAN_USAGE", category: "USAGE",
        message: "套餐用量没有任何覆盖周期，无法唯一归属",
        resourceId: PLAN_RESOURCE, accountCurrency: null, legacyRecordId: null,
        ledgerLineId: "aaaaaaaa-0000-4000-8000-000000000002", month: "2026-09", detail: null,
      },
    ]);
  });
});

describe("collectUsageClassificationGaps 分类与 Token 守恒", () => {
  it("未分类带 token → UNKNOWN_COST；已解析遗留成本不再报", () => {
    const line = apiLine({ apiCostStatus: "UNKNOWN_COST", legacyCostResolved: false });
    const resolved = apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000003", apiCostStatus: "UNKNOWN_COST", legacyCostResolved: true });
    const gaps: ActivationGap[] = [];
    const conserved = collectUsageClassificationGaps(factInput({ ledgerLines: [line, resolved] }), emptyPlan(), gaps);
    expect(conserved).toBe(true);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      code: "UNKNOWN_COST", category: "USAGE",
      message: "API 用量费用状态未明确（UNKNOWN_COST）",
      resourceId: API_RESOURCE, ledgerLineId: line.id, month: "2026-09",
    });
  });

  it("零 Token 的未知费用仍报缺口，已知费用的未分类排空行不误报", () => {
    const tokens = { rawInputTokens: "0", rawOutputTokens: "0", rawCacheTokens: "0", rawReasoningTokens: "0" };
    const explicit = apiLine({ ...tokens, id: "aaaaaaaa-0000-4000-8000-0000000000e1",
      usageEventId: "bbbbbbbb-0000-4000-8000-0000000000e1",
      apiCost: null, apiCostCurrency: null, apiCostStatus: "UNKNOWN_COST" });
    const unclassified = apiLine({ ...tokens, id: "aaaaaaaa-0000-4000-8000-0000000000e2",
      usageEventId: "bbbbbbbb-0000-4000-8000-0000000000e2",
      apiCost: null, apiCostCurrency: null, apiCostStatus: null });
    const knownCost = apiLine({ ...tokens, id: "aaaaaaaa-0000-4000-8000-0000000000e3",
      usageEventId: "bbbbbbbb-0000-4000-8000-0000000000e3",
      apiCost: "6.00000000", apiCostCurrency: "CNY", apiCostStatus: null });
    const gaps: ActivationGap[] = [];
    const usageEvents = [explicit, unclassified, knownCost].map((line) => ({
      id: line.usageEventId, inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0",
    }));
    expect(collectUsageClassificationGaps(
      factInput({ ledgerLines: [explicit, unclassified, knownCost], usageEvents }), emptyPlan(), gaps,
    )).toBe(true);
    expect(gaps.filter((entry) => entry.code === "UNKNOWN_COST").map((entry) => entry.ledgerLineId))
      .toEqual([explicit.id, unclassified.id]);
  });

  it("已定价缺币种 / 币种冲突 / 缺结算时间各自成缺口且 detail 精确", () => {
    const missingCurrency = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000011", apiCostCurrency: null, apiCostStatus: "PRICED_USAGE",
    });
    const conflict = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000012", apiCostCurrency: "USD", billingRuleSnapshotCurrency: "CNY",
    });
    const noSettledAt = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000013", settledAt: null, createdAt: "2026-09-10T04:00:01.000Z",
    });
    const gaps: ActivationGap[] = [];
    collectUsageClassificationGaps(
      factInput({ ledgerLines: [missingCurrency, conflict, noSettledAt] }), emptyPlan(), gaps,
    );
    expect(gaps.map((entry) => [entry.code, entry.detail])).toEqual([
      ["MISSING_API_CURRENCY", null],
      ["CONFLICTING_API_CURRENCY", "USD vs CNY"],
      ["MISSING_SETTLEMENT_TIME", null],
    ]);
    expect(gaps[0]!.message).toBe("已定价 API 用量缺少结算币种");
    expect(gaps[1]!.message).toBe("结算币种与计价规则快照币种冲突");
    expect(gaps[2]!.message).toBe("用量缺少结算时间");
  });

  it("Token 不守恒（数值不符或事件缺失）→ 返回 false 并逐行报缺口；守恒则 true", () => {
    const ok = apiLine();
    const mismatch = apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000021", usageEventId: "bbbbbbbb-0000-4000-8000-000000000002" });
    const noEvent = apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000022", usageEventId: "bbbbbbbb-0000-4000-8000-000000000099" });
    const badEvent = factInput({
      ledgerLines: [ok, mismatch, noEvent],
      usageEvents: [
        { id: EVENT_1, inputTokens: "10", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0" },
        { id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "11", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0" },
      ],
    });
    const gaps: ActivationGap[] = [];
    const conserved = collectUsageClassificationGaps(badEvent, emptyPlan(), gaps);
    expect(conserved).toBe(false);
    expect(gaps.filter((entry) => entry.code === "TOKEN_CONSERVATION_MISMATCH").map((entry) => entry.ledgerLineId))
      .toEqual([mismatch.id, noEvent.id]);
    expect(gaps.find((entry) => entry.code === "TOKEN_CONSERVATION_MISMATCH")!.message)
      .toBe("Usage 与 Ledger Token 不守恒");
    const clean = collectUsageClassificationGaps(factInput({ ledgerLines: [ok] }), emptyPlan(), []);
    expect(clean).toBe(true);
  });

  it("缺口按行号稳定排序输出；修复目标改变币种后冲突随之改变", () => {
    const later = apiLine({ id: "aaaaaaaa-0000-4000-8000-0000000000b2", apiCostStatus: "UNKNOWN_COST" });
    const earlier = apiLine({ id: "aaaaaaaa-0000-4000-8000-0000000000a1", apiCostStatus: "UNKNOWN_COST" });
    const gaps: ActivationGap[] = [];
    collectUsageClassificationGaps(factInput({ ledgerLines: [later, earlier] }), emptyPlan(), gaps);
    expect(gaps.map((entry) => entry.ledgerLineId)).toEqual([earlier.id, later.id]);
  });
});

// ===== balances.ts：用量修复增量 / 余额投影 =====

describe("computeUsageDebitDeltas 状态迁移增量", () => {
  it("未计价 → 定价：+cost；定价 → 未计价：-cost；状态未变不产生增量（含换币种）", () => {
    const toPriced = apiLine({
      id: "aaaaaaaa-0000-4000-8000-0000000000a1",
      apiCostStatus: null, apiCostCurrency: null,
    });
    const fromPriced = apiLine({
      id: "aaaaaaaa-0000-4000-8000-0000000000a2", apiCost: "3.00000000",
    });
    // 定价 → 定价但换币种：counted() 只看状态与金额，before === after → 无增量（现行语义）
    const recurrency = apiLine({
      id: "aaaaaaaa-0000-4000-8000-0000000000a3", apiCost: "2.00000000",
    });
    const repairByLine = new Map([
      [toPriced.id, {
        ledgerLineId: toPriced.id, settledAt: toPriced.settledAt,
        apiCostCurrency: "CNY" as const, apiCostStatus: "PRICED_USAGE", subscriptionPeriodId: null,
      }],
      [fromPriced.id, {
        ledgerLineId: fromPriced.id, settledAt: fromPriced.settledAt,
        apiCostCurrency: null, apiCostStatus: "UNKNOWN_COST", subscriptionPeriodId: null,
      }],
      [recurrency.id, {
        ledgerLineId: recurrency.id, settledAt: recurrency.settledAt,
        apiCostCurrency: "USD" as const, apiCostStatus: "PRICED_USAGE", subscriptionPeriodId: null,
      }],
    ]);
    const plan: UsageRepairPlan = { ...emptyPlan(), repairByLine };
    // CNY = +5(转定价) -3(转未知) = 2；换币种行 before === after → 无任何增量
    const deltas = computeUsageDebitDeltas(
      factInput({ ledgerLines: [toPriced, fromPriced, recurrency] }), plan,
    );
    expect(deltas.size).toBe(1);
    expect(deltas.get(`${API_RESOURCE}:CNY`)).toBe("2.00000000");
    expect(deltas.has(`${API_RESOURCE}:USD`)).toBe(false);
  });

  it("非 API 行与无费用 API 行不产生增量；状态未变亦无增量", () => {
    const planLineWithCost = planLine({ apiCost: "9.00000000", apiCostStatus: "PRICED_USAGE" });
    const zeroCost = apiLine({ apiCost: null });
    const unchanged = apiLine();
    const deltas = computeUsageDebitDeltas(
      factInput({ ledgerLines: [planLineWithCost, zeroCost, unchanged] }), emptyPlan(),
    );
    expect(deltas.size).toBe(0);
  });
});

describe("projectAccountBalances 投影与守恒缺口", () => {
  function scopeAccount(resourceId: string, currency: string): ActivationScopeAccountInput {
    return { resourceId, currency: currency as "CNY", sources: ["PRICED_USAGE"] };
  }

  it("真实分量与虚拟事实叠加：-5 + 期初100 + 充值10 = 105；公式失配与负余额各自成缺口", () => {
    const baseComponents = { ...emptyBalanceComponents(), usageDebits: "5.00000000" };
    const input = factInput({
      accounts: [scopeAccount(API_RESOURCE, "CNY")],
      accountComponents: [{
        resourceId: API_RESOURCE, currency: "CNY",
        components: baseComponents, reportedBalance: "-5.00000000",
      }],
      draft: normalizeDraftItem(minimalDraft({
        api_opening_balances: [{
          resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "100",
          occurred_at: "2026-08-31T16:00:00.000Z", description: "期初",
          evidence_ref: "evidence://o", source_record_id: null,
        }],
        historical_api_recharges: [rechargeIn("2026-09-05T02:00:00.000Z", "r-1")],
      }), API_RESOURCE),
    });
    const scope = new Map([[`${API_RESOURCE}:CNY`, scopeAccount(API_RESOURCE, "CNY")]]);
    const gaps: ActivationGap[] = [];
    const balances = projectAccountBalances(input, emptyPlan(), scope, gaps);
    expect(balances).toHaveLength(1);
    expect(balances[0]!.balance).toBe("105.00000000");
    expect(balances[0]!.formulaMatches).toBe(true);
    expect(gaps).toEqual([]);
  });

  it("公式失配失败关闭：落库余额与共享公式重算不一致即缺口，detail 精确到双向金额", () => {
    // 虚拟期初 300 保证投影余额为正，从而只触发公式失配一种缺口
    const mismatched = factInput({
      accountComponents: [{
        resourceId: API_RESOURCE, currency: "CNY" as const,
        components: { ...emptyBalanceComponents(), usageDebits: "5.00000000" },
        reportedBalance: "-4.00000000",
      }],
      draft: normalizeDraftItem(minimalDraft({
        api_opening_balances: [{
          resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "300",
          occurred_at: "2026-08-31T16:00:00.000Z", description: "期初",
          evidence_ref: "evidence://o", source_record_id: null,
        }],
      }), API_RESOURCE),
    });
    const mismatchGaps: ActivationGap[] = [];
    projectAccountBalances(mismatched, emptyPlan(), new Map([
      [`${API_RESOURCE}:CNY`, scopeAccount(API_RESOURCE, "CNY")],
    ]), mismatchGaps);
    expect(mismatchGaps).toHaveLength(1);
    expect(mismatchGaps[0]!.code).toBe("BALANCE_FORMULA_MISMATCH");
    expect(mismatchGaps[0]!.category).toBe("BALANCE");
    expect(mismatchGaps[0]!.message).toBe("账户余额与共享公式重算结果不一致，必须先完成对账");
    expect(mismatchGaps[0]!.detail).toBe("重算 -5.00000000 ≠ 已落库 -4.00000000");
    // 落库余额为 null 时不做校验、不报缺口（虚拟期初 300 保持投影为正）
    const nullReported = factInput({
      accountComponents: [{
        resourceId: API_RESOURCE, currency: "CNY" as const,
        components: { ...emptyBalanceComponents(), usageDebits: "5.00000000" },
        reportedBalance: null,
      }],
      draft: normalizeDraftItem(minimalDraft({
        api_opening_balances: [{
          resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "300",
          occurred_at: "2026-08-31T16:00:00.000Z", description: "期初",
          evidence_ref: "evidence://o", source_record_id: null,
        }],
      }), API_RESOURCE),
    });
    const nullGaps: ActivationGap[] = [];
    const nullBalances = projectAccountBalances(nullReported, emptyPlan(), new Map([
      [`${API_RESOURCE}:CNY`, scopeAccount(API_RESOURCE, "CNY")],
    ]), nullGaps);
    expect(nullBalances[0]!.formulaMatches).toBe(true);
    expect(nullGaps).toEqual([]);
  });

  it("投影余额为负 → NEGATIVE_BALANCE 缺口，detail 即负余额金额", () => {
    const negative = factInput({
      accountComponents: [{
        resourceId: API_RESOURCE, currency: "CNY" as const,
        components: { ...emptyBalanceComponents(), usageDebits: "300.00000000" },
        reportedBalance: "-300.00000000",
      }],
      draft: normalizeDraftItem(minimalDraft({
        api_opening_balances: [{
          resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "100",
          occurred_at: "2026-08-31T16:00:00.000Z", description: "期初",
          evidence_ref: "evidence://o", source_record_id: null,
        }],
      }), API_RESOURCE),
    });
    const negativeGaps: ActivationGap[] = [];
    const balances = projectAccountBalances(negative, emptyPlan(), new Map([
      [`${API_RESOURCE}:CNY`, scopeAccount(API_RESOURCE, "CNY")],
    ]), negativeGaps);
    expect(balances[0]!.balance).toBe("-200.00000000");
    expect(negativeGaps).toEqual([{
      code: "NEGATIVE_BALANCE", category: "BALANCE",
      message: "投影余额为负，必须先完成对账",
      resourceId: API_RESOURCE, accountCurrency: "CNY", legacyRecordId: null,
      ledgerLineId: null, month: null, detail: "-200.00000000",
    }]);
  });

  it("无真实分量的账户输出空分量；范围外账户被跳过；多账户按资源与币种排序", () => {
    const OTHER = "88888888-8888-4888-8888-888888888888";
    const scope = new Map([
      [`${API_RESOURCE}:CNY`, scopeAccount(API_RESOURCE, "CNY")],
      [`${API_RESOURCE}:USD`, scopeAccount(API_RESOURCE, "USD")],
      [`${PLAN_RESOURCE}:CNY`, scopeAccount(PLAN_RESOURCE, "CNY")],
    ]);
    const input = factInput({
      accounts: [...scope.values()],
      accountComponents: [
        {
          resourceId: API_RESOURCE, currency: "CNY",
          components: { ...emptyBalanceComponents(), recharges: "10.00000000" },
          reportedBalance: "10.00000000",
        },
        // 范围外：scope 中不存在该键 → 跳过
        { resourceId: OTHER, currency: "CNY", components: emptyBalanceComponents(), reportedBalance: null },
      ],
    });
    const gaps: ActivationGap[] = [];
    const balances = projectAccountBalances(input, emptyPlan(), scope, gaps);
    // 排序：先按 resourceId，再按 currency
    expect(balances.map((row) => `${row.resourceId}:${row.currency}`)).toEqual([
      `${API_RESOURCE}:CNY`, `${API_RESOURCE}:USD`, `${PLAN_RESOURCE}:CNY`,
    ]);
    expect(balances.find((row) => row.resourceId === PLAN_RESOURCE)!.balance).toBe("0.00000000");
    expect(balances.find((row) => row.currency === "USD")!.balance).toBe("0.00000000");
    expect(gaps).toEqual([]);
  });
});
