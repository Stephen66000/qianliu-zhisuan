import { describe, expect, it } from "vitest";
import {
  computeCandidateHash,
  conservationMonths,
  money,
  normalizeDraftItem,
  normalizeShanghaiDay,
  projectActivationCandidate,
  shanghaiMonthOf,
  usageRepairFieldDigests,
  virtualPeriodsOf,
  balanceAmount,
  addBalanceComponents,
  emptyBalanceComponents,
  sumBalanceComponents,
  isBalanceNegative,
  balanceFormulaMatches,
  type ActivationDraft,
  type ActivationProjectionInput,
  type ActivationScopeAccountInput,
  type ActivationScopeResourceInput,
  type FinanceFactRow,
  type LegacyPurchaseFactRow,
  type LedgerLineFactRow,
  type NormalizedActivationCandidate,
  type NormalizedCodingPlanCarryover,
  type NormalizedCodingPlanPurchase,
  type NormalizedLegacyPurchaseResolution,
  type NormalizedOpeningBalance,
  type NormalizedRecharge,
  type PeriodFactRow,
} from "../index.js";

const CUTOVER = "2026-08-31T16:00:00.000Z";
const SNAPSHOT = "2026-10-15T00:00:00.000Z";

const API_RESOURCE = "11111111-1111-4111-8111-111111111111";
const PLAN_RESOURCE = "22222222-2222-4222-8222-222222222222";
const PROVIDER = "33333333-3333-4333-8333-333333333333";
const PERIOD_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_PERIOD_ID = "55555555-5555-4555-8555-555555555555";
const LEGACY_ID = "66666666-6666-4666-8666-666666666666";

/** 与 apiLine()/planLine() 默认 usageEventId 对齐的 Usage 事实（Token 守恒）。 */
const EVENT_1 = { id: "bbbbbbbb-0000-4000-8000-000000000001", inputTokens: "10", outputTokens: "20",
  cacheTokens: "0", reasoningTokens: "0" };
const EVENT_2 = { id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "100", outputTokens: "200",
  cacheTokens: "0", reasoningTokens: "0" };

function apiResource(overrides: Partial<ActivationScopeResourceInput> = {}): ActivationScopeResourceInput {
  return {
    resourceId: API_RESOURCE, mode: "API", providerId: PROVIDER, providerCode: "deepseek",
    providerName: "DeepSeek", resourceName: "DeepSeek API", status: "ACTIVE",
    hasPostCutoverLedgerLine: true, hasCrossingSnapshot: true, hasPostCutoverPurchase: true,
    ...overrides,
  };
}

function planResource(overrides: Partial<ActivationScopeResourceInput> = {}): ActivationScopeResourceInput {
  return {
    resourceId: PLAN_RESOURCE, mode: "CODING_PLAN", providerId: PROVIDER, providerCode: "zhipu",
    providerName: "智谱", resourceName: "智谱 Coding Plan", status: "ACTIVE",
    hasPostCutoverLedgerLine: true, hasCrossingSnapshot: false, hasPostCutoverPurchase: false,
    ...overrides,
  };
}

function apiAccount(): ActivationScopeAccountInput {
  return { resourceId: API_RESOURCE, currency: "CNY", sources: ["PRICED_USAGE"] };
}

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
    usageEventId: "bbbbbbbb-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function planLine(overrides: Partial<LedgerLineFactRow> = {}): LedgerLineFactRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    resourceId: PLAN_RESOURCE,
    resourceMode: "CODING_PLAN",
    rawInputTokens: "100", rawOutputTokens: "200", rawCacheTokens: "0", rawReasoningTokens: "0",
    apiCost: null, apiCostCurrency: null, apiCostStatus: "NOT_APPLICABLE",
    legacyCostResolved: false, subscriptionPeriodId: PERIOD_ID,
    settledAt: "2026-09-15T04:00:00.000Z", createdAt: "2026-09-15T04:00:01.000Z",
    billingRuleSnapshotCurrency: null, billingRuleId: null,
    operatingConsumption: true, zeroConfirmedEligible: false,
    usageEventId: "bbbbbbbb-0000-4000-8000-000000000002",
    ...overrides,
  };
}

function period(overrides: Partial<PeriodFactRow> = {}): PeriodFactRow {
  return {
    id: PERIOD_ID, resourceId: PLAN_RESOURCE, productName: "智谱 Coding Plan",
    periodStart: "2026-08-31T16:00:00.000Z", periodEndExclusive: "2026-09-30T16:00:00.000Z",
    reversedByEventId: null,
    ...overrides,
  };
}

function happyDraft(): ActivationDraft {
  return {
    schema_version: "1",
    api_opening_balances: [{
      resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "100",
      occurred_at: CUTOVER, description: "切换时点厂商余额截图", evidence_ref: "evidence://deepseek/balance",
      source_record_id: null,
    }],
    historical_api_recharges: [{
      resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "100",
      cash_paid_cny: "720.00", occurred_at: "2026-09-05T02:00:00.000Z",
      external_reference: "ORD-1", description: "9月5日历史充值", evidence_ref: "evidence://deepseek/ord-1",
      source_record_id: LEGACY_ID, record_idempotency_key: "recharge-ord-1",
    }],
    coding_plan_purchases: [],
    coding_plan_carryovers: [],
    legacy_purchase_resolutions: [{
      legacy_record_id: LEGACY_ID, resource_id: API_RESOURCE, resolution: "MIGRATED",
      finance_event_id: null, migrated_external_reference: "ORD-1", reason: null, evidence_ref: null,
    }],
  };
}

function baseInput(overrides: Partial<ActivationProjectionInput> = {}): ActivationProjectionInput {
  const draft = overrides.draft ?? normalizeDraftItem(happyDraft(), API_RESOURCE);
  return {
    enterpriseId: "77777777-7777-4777-8777-777777777777",
    snapshotAt: SNAPSHOT,
    resources: [apiResource(), planResource()],
    accounts: [apiAccount()],
    financeEvents: [],
    periods: [period()],
    legacyPurchases: [{
      id: LEGACY_ID, resourceId: API_RESOURCE, purchaseType: "API_RECHARGE",
      amount: "100.00000000", currency: "CNY", purchasedAt: "2026-09-05T02:00:00.000Z",
      alreadyMigratedEventId: null,
    }],
    ledgerLines: [apiLine(), planLine()],
    usageEvents: [
      { id: "bbbbbbbb-0000-4000-8000-000000000001", inputTokens: "10", outputTokens: "20",
        cacheTokens: "0", reasoningTokens: "0" },
      { id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "100", outputTokens: "200",
        cacheTokens: "0", reasoningTokens: "0" },
    ],
    accountComponents: [{
      resourceId: API_RESOURCE, currency: "CNY",
      components: { ...emptyBalanceComponents(), usageDebits: "5.00000000" },
      reportedBalance: "-5.00000000",
    }],
    monthlyGaps: [
      { month: "2026-09", gaps: [] },
      { month: "2026-10", gaps: [] },
    ],
    strictWritesEnabled: false,
    draft,
    usageRepairBaseline: [],
    usageRepairTargets: [],
    ...overrides,
  };
}

describe("守恒窗口月份", () => {
  it("从固定切换时点起算，末月按候选水位截断", () => {
    const months = conservationMonths(CUTOVER, SNAPSHOT);
    expect(months.map((entry) => entry.month)).toEqual(["2026-09", "2026-10"]);
    expect(months[0]!.start).toBe(CUTOVER);
    expect(months[0]!.clipped).toBe(false);
    expect(months[1]!.clipped).toBe(true);
    expect(months[1]!.endExclusive).toBe("2026-10-15T00:00:00.001Z");
  });

  it("切换时点的上海自然月为上月边界（UTC 8月31日16时 = 上海9月1日0时）", () => {
    expect(shanghaiMonthOf(CUTOVER)).toBe("2026-09");
  });
});

describe("共享余额聚合语义（唯一公式）", () => {
  it("冲销与历史成本按事件金额原符号相加，用量扣费相减", () => {
    const components = { ...emptyBalanceComponents(),
      openingBalance: "100.00000000", openingCorrections: "5.00000000",
      recharges: "20.00000000", balanceReconciliations: "-3.00000000",
      legacyCostAdjustments: "-4.00000000", reversals: "-10.00000000",
      usageDebits: "8.00000000" };
    // 100 + 5 + 20 - 3 - 4 - 10 - 8 = 100
    expect(balanceAmount(components)).toBe("100.00000000");
    expect(balanceFormulaMatches(components, "100.00000000")).toBe(true);
    expect(isBalanceNegative(components)).toBe(false);
  });

  it("虚拟事实叠加仍走同一公式（不得在调用点重写符号）", () => {
    const base = { ...emptyBalanceComponents(), usageDebits: "5.00000000" };
    const merged = addBalanceComponents(base, { openingBalance: "100.00000000", recharges: "100.00000000" });
    expect(balanceAmount(merged)).toBe("195.00000000");
    expect(money(sumBalanceComponents(merged))).toBe("195.00000000");
  });
});

describe("候选假设投影", () => {
  it("完整草稿投影为 GO_CANDIDATE，且虚拟期初与充值参与余额", () => {
    const result = projectActivationCandidate(baseInput());
    expect(result.gaps).toEqual([]);
    expect(result.decision).toBe("GO_CANDIDATE");
    expect(result.projected.monthsChecked).toEqual(["2026-09", "2026-10"]);
    expect(result.projected.tokenConserved).toBe(true);
    expect(result.projected.codingPlanUsageAttributed).toBe(true);
    expect(result.projected.operatingBillsComplete).toBe(true);
    expect(result.projected.accounts).toHaveLength(1);
    expect(result.projected.accounts[0]!.openingBalance).toBe("100.00000000");
    expect(result.projected.accounts[0]!.recharges).toBe("100.00000000");
    expect(result.projected.accounts[0]!.usageDebits).toBe("5.00000000");
    expect(result.projected.accounts[0]!.balance).toBe("195.00000000");
    expect(result.projected.accounts[0]!.formulaMatches).toBe(true);
  });

  it("输入顺序（用量行、周期、事实）不影响结论与缺口集合", () => {
    const forward = projectActivationCandidate(baseInput());
    const shuffled = projectActivationCandidate(baseInput({
      ledgerLines: [planLine(), apiLine()],
      resources: [planResource(), apiResource()],
    }));
    expect(shuffled.decision).toBe(forward.decision);
    expect(shuffled.gaps).toEqual(forward.gaps);
    expect(shuffled.projected.accounts).toEqual(forward.projected.accounts);
  });

  it("必要币种账户顺序不影响候选哈希", () => {
    const candidate: NormalizedActivationCandidate = normalizeDraftItem(happyDraft(), API_RESOURCE);
    const accounts = [
      { resourceId: API_RESOURCE, currency: "CNY" as const },
      { resourceId: PLAN_RESOURCE, currency: "USD" as const },
    ];
    const left = computeCandidateHash({ enterpriseId: "e", candidate, factWatermarkHash: "a".repeat(64),
      scopeAccounts: accounts });
    const right = computeCandidateHash({ enterpriseId: "e", candidate, factWatermarkHash: "a".repeat(64),
      scopeAccounts: [...accounts].reverse() });
    expect(left).toBe(right);
  });

  it("缺少必要账户期初返回可定位的结构化缺口（不是一条错误字符串）", () => {
    const draft = happyDraft();
    draft.api_opening_balances = [];
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "MISSING_OPENING_BALANCE", resourceId: API_RESOURCE, accountCurrency: "CNY",
    }));
  });

  it("显式零期初被接受，但余额为负时失败关闭", () => {
    const draft = happyDraft();
    draft.api_opening_balances[0]!.account_amount = "0";
    draft.historical_api_recharges = [];
    draft.legacy_purchase_resolutions = [{
      legacy_record_id: LEGACY_ID, resource_id: API_RESOURCE, resolution: "REJECTED_WITH_EVIDENCE",
      finance_event_id: null, migrated_external_reference: null,
      reason: "非实际资金事实", evidence_ref: "evidence://deepseek/legacy-1",
    }];
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "NEGATIVE_BALANCE", resourceId: API_RESOURCE, accountCurrency: "CNY",
    }));
    expect(result.projected.accounts[0]!.balance).toBe("-5.00000000");
  });

  it("已落库余额与共享公式漂移时失败关闭并发射 BALANCE_FORMULA_MISMATCH（§4.5-5 / §8-7）", () => {
    // components 重算为 -5，但 reportedBalance 被写成 -9（数据库侧独立值漂移）。
    const result = projectActivationCandidate(baseInput({
      accountComponents: [{
        resourceId: API_RESOURCE, currency: "CNY",
        components: { ...emptyBalanceComponents(), usageDebits: "5.00000000" },
        reportedBalance: "-9.00000000",
      }],
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.projected.accounts[0]!.formulaMatches).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "BALANCE_FORMULA_MISMATCH", category: "BALANCE",
      resourceId: API_RESOURCE, accountCurrency: "CNY",
    }));
  });

  it("公式守恒时不发射 BALANCE_FORMULA_MISMATCH（避免误伤唯一公式路径）", () => {
    const result = projectActivationCandidate(baseInput());
    expect(result.projected.accounts[0]!.formulaMatches).toBe(true);
    expect(result.gaps.some((entry) => entry.code === "BALANCE_FORMULA_MISMATCH")).toBe(false);
  });

  it("未落库账户（无 reportedBalance）不参与公式守恒判定", () => {
    const result = projectActivationCandidate(baseInput({
      accountComponents: [{
        resourceId: API_RESOURCE, currency: "CNY",
        components: { ...emptyBalanceComponents(), usageDebits: "5.00000000" },
        reportedBalance: null,
      }],
    }));
    expect(result.projected.accounts[0]!.formulaMatches).toBe(true);
    expect(result.gaps.some((entry) => entry.code === "BALANCE_FORMULA_MISMATCH")).toBe(false);
  });

  it("UNKNOWN_COST 是独立缺口，不会被旧记录拒绝决定关闭", () => {
    const draft = happyDraft();
    draft.legacy_purchase_resolutions = [{
      legacy_record_id: LEGACY_ID, resource_id: API_RESOURCE, resolution: "REJECTED_WITH_EVIDENCE",
      finance_event_id: null, migrated_external_reference: null,
      reason: "非实际资金事实", evidence_ref: "evidence://deepseek/legacy-1",
    }];
    const unknown = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000009",
      apiCost: null, apiCostCurrency: null, apiCostStatus: null,
      billingRuleSnapshotCurrency: null, billingRuleId: null,
      usageEventId: "bbbbbbbb-0000-4000-8000-000000000009",
    });
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
      ledgerLines: [apiLine(), planLine(), unknown],
      usageEvents: [
        { id: "bbbbbbbb-0000-4000-8000-000000000001", inputTokens: "10", outputTokens: "20",
          cacheTokens: "0", reasoningTokens: "0" },
        { id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "100", outputTokens: "200",
          cacheTokens: "0", reasoningTokens: "0" },
        { id: "bbbbbbbb-0000-4000-8000-000000000009", inputTokens: "10", outputTokens: "20",
          cacheTokens: "0", reasoningTokens: "0" },
      ],
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "UNKNOWN_COST", ledgerLineId: unknown.id,
    }));
  });

  it("跨月：九月守恒通过但十月存在未知成本时整体 NO_GO 并指向十月", () => {
    const result = projectActivationCandidate(baseInput({
      monthlyGaps: [
        { month: "2026-09", gaps: [] },
        { month: "2026-10", gaps: [{ code: "API_USAGE_COST_UNKNOWN", count: 1 }] },
      ],
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.projected.operatingBillsComplete).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({
      category: "OPERATING_BILL", month: "2026-10", code: "UNKNOWN_COST",
    }));
  });

  it("周期歧义：同一套餐用量被两个未冲销周期覆盖时 NO_GO 并列出冲突周期", () => {
    const unattributed = planLine({
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      subscriptionPeriodId: null,
    });
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), unattributed],
      periods: [
        period(),
        period({ id: SECOND_PERIOD_ID, periodStart: "2026-09-10T16:00:00.000Z",
          periodEndExclusive: "2026-10-10T16:00:00.000Z" }),
      ],
      usageEvents: [
        { id: "bbbbbbbb-0000-4000-8000-000000000001", inputTokens: "10", outputTokens: "20",
          cacheTokens: "0", reasoningTokens: "0" },
        { id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "100", outputTokens: "200",
          cacheTokens: "0", reasoningTokens: "0" },
      ],
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.projected.codingPlanUsageAttributed).toBe(false);
    const overlap = result.gaps.find((entry) => entry.code === "OVERLAPPING_PERIOD");
    expect(overlap).toBeDefined();
    expect(overlap!.ledgerLineId).toBe(unattributed.id);
    expect(overlap!.detail).toContain(PERIOD_ID);
    expect(overlap!.detail).toContain(SECOND_PERIOD_ID);
  });

  it("唯一覆盖周期时用量可归属，并登记为修复资格行", () => {
    const unattributed = planLine({
      id: "aaaaaaaa-0000-4000-8000-000000000004",
      subscriptionPeriodId: null,
    });
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), unattributed],
      usageEvents: [
        { id: "bbbbbbbb-0000-4000-8000-000000000001", inputTokens: "10", outputTokens: "20",
          cacheTokens: "0", reasoningTokens: "0" },
        { id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "100", outputTokens: "200",
          cacheTokens: "0", reasoningTokens: "0" },
      ],
    }));
    expect(result.gaps).toEqual([]);
    const target = result.usageRepairTargets.find((entry) => entry.ledgerLineId === unattributed.id);
    expect(target?.subscriptionPeriodId).toBe(PERIOD_ID);
    expect(result.usageRepairs.eligibleByField.subscription_period_id).toBe(1);
  });

  it("MIGRATED 旧记录必须绑定到草稿明细行，否则不得静默关闭", () => {
    const draft = happyDraft();
    draft.legacy_purchase_resolutions = [{
      legacy_record_id: LEGACY_ID, resource_id: API_RESOURCE, resolution: "MIGRATED",
      finance_event_id: null, migrated_external_reference: "ORD-NOT-REGISTERED",
      reason: null, evidence_ref: null,
    }];
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_MIGRATION_REFERENCE_MISSING", legacyRecordId: LEGACY_ID,
    }));
  });

  it("未关闭的旧购买记录使整体 NO_GO", () => {
    const draft = happyDraft();
    draft.legacy_purchase_resolutions = [];
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_RECORD_UNCLOSED", legacyRecordId: LEGACY_ID,
    }));
  });

  it("Token 不守恒（usage_event 缺失）使整体 NO_GO", () => {
    const result = projectActivationCandidate(baseInput({
      usageEvents: [{ id: "bbbbbbbb-0000-4000-8000-000000000002", inputTokens: "100",
        outputTokens: "200", cacheTokens: "0", reasoningTokens: "0" }],
    }));
    expect(result.projected.tokenConserved).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "TOKEN_CONSERVATION_MISMATCH" }));
  });

  it("扣费日期不等于服务开始日的购买被拒绝", () => {
    const draft = happyDraft();
    draft.coding_plan_purchases = [{
      resource_id: PLAN_RESOURCE, kind: "PURCHASE", product_name: "智谱 Coding Plan",
      account_amount: "199", account_currency: "CNY", cash_paid_cny: "199.00",
      service_period_start: "2026-09-20", service_period_end: null,
      occurred_at: "2026-09-21T02:00:00.000Z", external_reference: "PLAN-1",
      auto_renew: true, description: "首次购买", evidence_ref: "evidence://zhipu/plan-1",
      source_record_id: null, carryover_snapshot_id: null,
      record_idempotency_key: "plan-purchase-1",
    }];
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "INVALID_SERVICE_PERIOD" }));
  });

  it("草稿引用范围外资源时失败关闭", () => {
    const draft = happyDraft();
    draft.api_opening_balances[0]!.resource_id = "99999999-9999-4999-8999-999999999999";
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
      accounts: [],
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "UNKNOWN_RESOURCE" }));
  });

  it("期初时点不等于切换时点被拒绝", () => {
    const draft = happyDraft();
    draft.api_opening_balances[0]!.occurred_at = "2026-09-02T00:00:00.000Z";
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "OPENING_TIME_MISMATCH" }));
  });

  it("同一账户出现两条草稿期初时发射 DUPLICATE_OPENING_BALANCE，不静默保留最后一条", () => {
    // 回归：曾因 `Map.set()` 覆盖语义，同账户重复期初被静默去重，第二条悄悄
    // 取代第一条，管理员无从察觉。修复后必须失败关闭（PFH-01：期初必须且仅有一条）。
    const draft = happyDraft();
    draft.api_opening_balances = [
      { resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "100",
        occurred_at: CUTOVER, description: "第一次登记", evidence_ref: "evidence://first",
        source_record_id: null },
      { resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "200",
        occurred_at: CUTOVER, description: "重复登记", evidence_ref: "evidence://second",
        source_record_id: null },
    ];
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_OPENING_BALANCE", resourceId: API_RESOURCE, accountCurrency: "CNY",
    }));
    // 缺口必须携带两条金额，便于管理员定位冲突（而不是只给一条或空 detail）。
    const duplicateGap = result.gaps.find((gap) => gap.code === "DUPLICATE_OPENING_BALANCE");
    expect(duplicateGap?.detail).toContain("first=100");
    expect(duplicateGap?.detail).toContain("duplicate=200");
  });
});

describe("历史修复固定行集（PFH-04）", () => {
  it("基准只包含切换时点后需要修复的行，按主键稳定排序", () => {
    const lines = [
      apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000010", settledAt: null }),
      apiLine({ id: "aaaaaaaa-0000-4000-8000-000000000002", settledAt: null }),
    ];
    const result = projectActivationCandidate(baseInput({
      ledgerLines: lines,
      usageEvents: [
        { id: "bbbbbbbb-0000-4000-8000-000000000001", inputTokens: "10", outputTokens: "20",
          cacheTokens: "0", reasoningTokens: "0" },
      ],
    }));
    expect(result.usageRepairBaseline.map((row) => row.ledgerLineId))
      .toEqual(["aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000010"]);
    expect(result.usageRepairBaseline.every((row) => row.eligibleRepairs.includes("settled_at"))).toBe(true);
    expect(result.usageRepairs.eligibleByField.settled_at).toBe(2);
  });

  it("非目标字段基准覆盖除四个允许字段以外的全部字段", () => {
    const line = apiLine();
    const digests = usageRepairFieldDigests(line);
    expect(digests.targetFieldsBeforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(digests.nonTargetFieldsBeforeHash).toMatch(/^[a-f0-9]{64}$/);
    // 目标字段变化不改变非目标哈希，非目标字段变化必须改变它。
    expect(usageRepairFieldDigests({ ...line, settledAt: "2026-09-11T00:00:00.000Z" })
      .nonTargetFieldsBeforeHash).toBe(digests.nonTargetFieldsBeforeHash);
    expect(usageRepairFieldDigests({ ...line, rawInputTokens: "11" })
      .nonTargetFieldsBeforeHash).not.toBe(digests.nonTargetFieldsBeforeHash);
  });

  it("目标字段基准随四个允许字段变化", () => {
    const line = apiLine();
    expect(usageRepairFieldDigests({ ...line, apiCostStatus: "CONFIRMED_ZERO_NO_UPSTREAM" })
      .targetFieldsBeforeHash).not.toBe(usageRepairFieldDigests(line).targetFieldsBeforeHash);
  });
});

describe("上海自然日辅助", () => {
  it("normalizeShanghaiDay 只接受真实存在的自然日", () => {
    expect(normalizeShanghaiDay("2026-09-30")).toBe("2026-09-30");
    expect(() => normalizeShanghaiDay("2026-09-31")).toThrow();
    expect(() => normalizeShanghaiDay("2026-02-30")).toThrow();
  });
});

// ===== 负路径与边界分支（防下降基线：projection 未覆盖分支） =====

function draftOf(overrides: Partial<ActivationDraft> = {}): ActivationDraft {
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

function opening(overrides: Partial<NormalizedOpeningBalance> = {}): NormalizedOpeningBalance {
  return {
    resourceId: API_RESOURCE, accountCurrency: "CNY", accountAmount: "100.00000000",
    occurredAt: CUTOVER, description: "切换时点余额截图", evidenceRef: "evidence://deepseek/balance",
    sourceRecordId: null, ...overrides,
  };
}

function recharge(overrides: Partial<NormalizedRecharge> = {}): NormalizedRecharge {
  return {
    resourceId: API_RESOURCE, accountCurrency: "CNY", accountAmount: "100.00000000",
    cashPaidCny: "720.00", occurredAt: "2026-09-05T02:00:00.000Z", externalReference: "ORD-1",
    description: "9月5日历史充值", evidenceRef: "evidence://deepseek/ord-1",
    sourceRecordId: LEGACY_ID, recordIdempotencyKey: "recharge-ord-1", ...overrides,
  };
}

function purchase(overrides: Partial<NormalizedCodingPlanPurchase> = {}): NormalizedCodingPlanPurchase {
  return {
    resourceId: PLAN_RESOURCE, kind: "PURCHASE", productName: "智谱 Coding Plan",
    accountAmount: "199.00000000", accountCurrency: "CNY", cashPaidCny: "199.00",
    servicePeriodStart: "2026-09-20", servicePeriodEndInclusive: "2026-10-19",
    periodStart: "2026-09-19T16:00:00.000Z", periodEndExclusive: "2026-10-19T16:00:00.000Z",
    occurredAt: "2026-09-20T02:00:00.000Z", externalReference: "PLAN-1", autoRenew: true,
    description: "首次购买", evidenceRef: "evidence://zhipu/plan-1",
    sourceRecordId: null, carryoverSnapshotId: null, recordIdempotencyKey: "plan-purchase-1",
    ...overrides,
  };
}

function carryover(overrides: Partial<NormalizedCodingPlanCarryover> = {}): NormalizedCodingPlanCarryover {
  return {
    resourceId: PLAN_RESOURCE, productName: "智谱 Coding Plan",
    periodStart: "2026-08-14T16:00:00.000Z", periodEndExclusive: "2026-09-14T16:00:00.000Z",
    snapshotId: "carryover-1", description: "跨切换周期", evidenceRef: "evidence://zhipu/carryover-1",
    ...overrides,
  };
}

/** 跨切换周期必须与套餐用量归属一起验证：虚拟周期 id 前缀为 `draft:`。 */
const CARRYOVER_PERIOD_ID = "draft:carryover-1";

const UNKNOWN_LEGACY_ID = "66666666-6666-4666-8666-666666666667";

function legacyRecord(overrides: Partial<LegacyPurchaseFactRow> = {}): LegacyPurchaseFactRow {
  return {
    id: LEGACY_ID, resourceId: API_RESOURCE, purchaseType: "API_RECHARGE",
    amount: "100.00000000", currency: "CNY", purchasedAt: "2026-09-05T02:00:00.000Z",
    alreadyMigratedEventId: null, ...overrides,
  };
}

function resolution(
  overrides: Partial<NormalizedLegacyPurchaseResolution> = {},
): NormalizedLegacyPurchaseResolution {
  return {
    legacyRecordId: LEGACY_ID, resourceId: API_RESOURCE, resolution: "MIGRATED",
    financeEventId: null, migratedExternalReference: "ORD-1", reason: null, evidenceRef: null,
    ...overrides,
  };
}

/** 只保留一条满足期初的账户，避免干扰负路径定位。 */
function candidateOf(overrides: Partial<NormalizedActivationCandidate> = {}): NormalizedActivationCandidate {
  return {
    schemaVersion: "1",
    cutoverAt: CUTOVER,
    apiOpeningBalances: [opening()],
    historicalApiRecharges: [],
    codingPlanPurchases: [],
    codingPlanCarryovers: [],
    legacyPurchaseResolutions: [],
    ...overrides,
  };
}

function quietInput(overrides: Partial<ActivationProjectionInput> = {}): ActivationProjectionInput {
  return baseInput({
    periods: [],
    ledgerLines: [],
    usageEvents: [],
    accountComponents: [],
    legacyPurchases: [],
    draft: candidateOf(),
    ...overrides,
  });
}

describe("输入边界失败关闭", () => {
  it("守恒窗口边界不是合法时间时拒绝（不静默产出空窗口）", () => {
    expect(() => conservationMonths("not-a-date", SNAPSHOT)).toThrow(/守恒窗口边界/);
    expect(() => conservationMonths(CUTOVER, "not-a-date")).toThrow(/守恒窗口边界/);
    expect(() => conservationMonths(SNAPSHOT, CUTOVER)).toThrow(/不得早于切换时点/);
  });
});

describe("跨切换周期虚拟周期", () => {
  it("虚拟周期 id 由记录幂等键与快照 id 稳定派生", () => {
    const periods = virtualPeriodsOf(candidateOf({
      codingPlanPurchases: [purchase()],
      codingPlanCarryovers: [carryover()],
    }));
    expect(periods.map((entry) => entry.id)).toEqual(["draft:plan-purchase-1", CARRYOVER_PERIOD_ID]);
    expect(periods.every((entry) => entry.reversed === false)).toBe(true);
  });

  it("草稿跨切换周期展开为虚拟周期并承接套餐用量归属", () => {
    const draft = draftOf({
      api_opening_balances: happyDraft().api_opening_balances,
      coding_plan_carryovers: [{
        resource_id: PLAN_RESOURCE, product_name: "智谱 Coding Plan",
        period_start: "2026-08-15", period_end: "2026-09-14", snapshot_id: "carryover-1",
        description: "跨切换周期", evidence_ref: "evidence://zhipu/carryover-1",
      }],
    });
    const line = planLine({
      id: "aaaaaaaa-0000-4000-8000-000000000005",
      settledAt: "2026-09-05T04:00:00.000Z", subscriptionPeriodId: null,
    });
    const result = projectActivationCandidate(baseInput({
      draft: normalizeDraftItem(draft, API_RESOURCE),
      periods: [],
      legacyPurchases: [],
      ledgerLines: [line],
    }));
    expect(result.gaps).toEqual([]);
    expect(result.decision).toBe("GO_CANDIDATE");
    expect(result.projected.codingPlanUsageAttributed).toBe(true);
    expect(result.usageRepairTargets.find((entry) => entry.ledgerLineId === line.id)?.subscriptionPeriodId)
      .toBe("draft:carryover-1");
  });
});

describe("用量修复的补全分支", () => {
  it("API 行缺费用状态时按计价规则快照补全定价，并计入用量扣费增量", () => {
    const priced = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000006",
      apiCost: "5.00000000", apiCostCurrency: null, apiCostStatus: null,
      billingRuleSnapshotCurrency: "CNY", billingRuleId: null,
      usageEventId: "bbbbbbbb-0000-4000-8000-000000000006",
    });
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), planLine(), priced],
      usageEvents: [EVENT_1, EVENT_2, { id: "bbbbbbbb-0000-4000-8000-000000000006",
        inputTokens: "10", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0" }],
    }));
    expect(result.gaps).toEqual([]);
    const target = result.usageRepairTargets.find((entry) => entry.ledgerLineId === priced.id);
    expect(target?.apiCostStatus).toBe("PRICED_USAGE");
    expect(target?.apiCostCurrency).toBe("CNY");
    // 已落库 usageDebits 只含原先已定价的行，修复增量必须叠加在共享公式之上。
    expect(result.projected.accounts[0]!.usageDebits).toBe("10.00000000");
    expect(result.projected.accounts[0]!.formulaMatches).toBe(true);
  });

  it("零成本且无上游的 API 行补全为 CONFIRMED_ZERO_NO_UPSTREAM（不计扣费增量）", () => {
    const zero = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000007",
      rawInputTokens: "0", rawOutputTokens: "0", rawCacheTokens: "0", rawReasoningTokens: "0",
      apiCost: "0.00000000", apiCostCurrency: null, apiCostStatus: null,
      billingRuleSnapshotCurrency: null, billingRuleId: null, zeroConfirmedEligible: true,
      usageEventId: "bbbbbbbb-0000-4000-8000-000000000007",
    });
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), planLine(), zero],
      usageEvents: [EVENT_1, EVENT_2, { id: "bbbbbbbb-0000-4000-8000-000000000007",
        inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0" }],
    }));
    expect(result.gaps).toEqual([]);
    expect(result.usageRepairTargets.find((entry) => entry.ledgerLineId === zero.id)?.apiCostStatus)
      .toBe("CONFIRMED_ZERO_NO_UPSTREAM");
    expect(result.projected.accounts[0]!.usageDebits).toBe("5.00000000");
  });

  it("套餐行缺费用状态时补全为 NOT_APPLICABLE", () => {
    const plan = planLine({ id: "aaaaaaaa-0000-4000-8000-000000000008", apiCostStatus: null });
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), plan],
    }));
    expect(result.gaps).toEqual([]);
    expect(result.usageRepairTargets.find((entry) => entry.ledgerLineId === plan.id)?.apiCostStatus)
      .toBe("NOT_APPLICABLE");
  });

  it("套餐用量没有任何覆盖周期时发射 UNATTRIBUTED_PLAN_USAGE", () => {
    const line = planLine({ id: "aaaaaaaa-0000-4000-8000-000000000009", subscriptionPeriodId: null });
    const result = projectActivationCandidate(baseInput({ periods: [], ledgerLines: [apiLine(), line] }));
    expect(result.decision).toBe("NO_GO");
    expect(result.projected.codingPlanUsageAttributed).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "UNATTRIBUTED_PLAN_USAGE", category: "USAGE", ledgerLineId: line.id, month: "2026-09",
    }));
  });
});

describe("资源模式错配", () => {
  it("四类草稿行登记在错误模式的资源上时逐类失败关闭", () => {
    const draft = draftOf({
      api_opening_balances: [{
        resource_id: PLAN_RESOURCE, account_currency: "CNY", account_amount: "100",
        occurred_at: CUTOVER, description: "误登记到套餐资源", evidence_ref: "evidence://x",
        source_record_id: null,
      }],
      historical_api_recharges: [{
        resource_id: PLAN_RESOURCE, account_currency: "CNY", account_amount: "100",
        cash_paid_cny: "720.00", occurred_at: "2026-09-05T02:00:00.000Z", external_reference: "ORD-X",
        description: "误登记充值", evidence_ref: "evidence://x", source_record_id: LEGACY_ID,
        record_idempotency_key: "recharge-ord-x",
      }],
      coding_plan_purchases: [{
        resource_id: API_RESOURCE, kind: "PURCHASE", product_name: "误登记产品",
        account_amount: "199", account_currency: "CNY", cash_paid_cny: "199.00",
        service_period_start: "2026-09-20", service_period_end: null,
        occurred_at: "2026-09-20T02:00:00.000Z", external_reference: "PLAN-X", auto_renew: true,
        description: "误登记购买", evidence_ref: "evidence://x", source_record_id: null,
        carryover_snapshot_id: null, record_idempotency_key: "plan-purchase-x",
      }],
      coding_plan_carryovers: [{
        resource_id: API_RESOURCE, product_name: "误登记产品",
        period_start: "2026-08-15", period_end: "2026-09-14", snapshot_id: "carry-x",
        description: "误登记跨切换周期", evidence_ref: "evidence://x",
      }],
    });
    const result = projectActivationCandidate(baseInput({ draft: normalizeDraftItem(draft, API_RESOURCE) }));
    expect(result.decision).toBe("NO_GO");
    const mismatches = result.gaps.filter((entry) => entry.code === "RESOURCE_MODE_MISMATCH");
    expect(mismatches.map((entry) => entry.category).sort())
      .toEqual(["OPENING_BALANCE", "PERIOD", "PURCHASE", "RECHARGE"]);
  });
});

describe("期初余额来源与证据", () => {
  function openingEvent(amount: string, overrides: Partial<FinanceFactRow> = {}): FinanceFactRow {
    return {
      id: "88888888-8888-4888-8888-888888888888", resourceId: API_RESOURCE,
      eventType: "API_OPENING_BALANCE", currency: "CNY", accountAmount: amount,
      cashPaidCny: null, occurredAt: CUTOVER, ...overrides,
    };
  }

  it("已存在的真实期初事实可满足必要账户（不重复要求草稿期初）", () => {
    const result = projectActivationCandidate(baseInput({
      financeEvents: [
        openingEvent("100.00000000"),
        openingEvent("0.00000000", { id: "99999999-9999-4999-8999-999999999999", eventType: "API_RECHARGE" }),
      ],
    }));
    expect(result.gaps).toEqual([]);
    expect(result.decision).toBe("GO_CANDIDATE");
  });

  it("草稿期初与已落库原始期初金额不一致时发射 DUPLICATE_OPENING_BALANCE", () => {
    const result = projectActivationCandidate(baseInput({
      financeEvents: [openingEvent("120.00000000")],
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_OPENING_BALANCE", category: "OPENING_BALANCE",
      resourceId: API_RESOURCE, accountCurrency: "CNY",
    }));
  });

  it("期初说明与证据为空时失败关闭（投影不依赖合同校验层）", () => {
    const result = projectActivationCandidate(quietInput({
      draft: candidateOf({ apiOpeningBalances: [opening({ description: "   ", evidenceRef: "  " })] }),
    }));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "MISSING_OPENING_EVIDENCE", category: "OPENING_BALANCE",
      resourceId: API_RESOURCE, accountCurrency: "CNY",
    }));
  });
});

describe("旧购买记录关闭决定的负路径", () => {
  it("同一条旧记录出现多个关闭决定时失败关闭", () => {
    const result = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()],
      draft: candidateOf({
        legacyPurchaseResolutions: [
          resolution({ resolution: "REJECTED_WITH_EVIDENCE", migratedExternalReference: null,
            reason: "非实际资金事实", evidenceRef: "evidence://a" }),
          resolution({ resolution: "REJECTED_WITH_EVIDENCE", migratedExternalReference: null,
            reason: "重复决定", evidenceRef: "evidence://b" }),
        ],
      }),
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_RECORD_UNCLOSED", legacyRecordId: LEGACY_ID,
    }));
  });

  it("关闭决定引用范围外旧记录时失败关闭（不按残留记录匹配）", () => {
    const result = projectActivationCandidate(quietInput({
      legacyPurchases: [],
      draft: candidateOf({ legacyPurchaseResolutions: [resolution({ legacyRecordId: UNKNOWN_LEGACY_ID })] }),
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_RECORD_UNKNOWN", legacyRecordId: UNKNOWN_LEGACY_ID,
    }));
  });

  it("MIGRATED 未提供外部订单引用时失败关闭", () => {
    const result = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()],
      draft: candidateOf({
        legacyPurchaseResolutions: [resolution({ migratedExternalReference: null })],
      }),
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_MIGRATION_REFERENCE_MISSING", legacyRecordId: LEGACY_ID,
    }));
  });

  it("REJECTED_WITH_EVIDENCE 缺原因或缺证据都失败关闭", () => {
    const noReason = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()],
      draft: candidateOf({ legacyPurchaseResolutions: [resolution({ resolution: "REJECTED_WITH_EVIDENCE",
        migratedExternalReference: null, reason: null, evidenceRef: "evidence://a" })] }),
    }));
    expect(noReason.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_REJECTION_EVIDENCE_MISSING", legacyRecordId: LEGACY_ID,
    }));
    const noEvidence = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()],
      draft: candidateOf({ legacyPurchaseResolutions: [resolution({ resolution: "REJECTED_WITH_EVIDENCE",
        migratedExternalReference: null, reason: "非实际资金事实", evidenceRef: null })] }),
    }));
    expect(noEvidence.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_REJECTION_EVIDENCE_MISSING", legacyRecordId: LEGACY_ID,
    }));
  });

  it("ALREADY_REPRESENTED 必须引用同资源且金额/币种/时间一致的资金事件", () => {
    const event: FinanceFactRow = {
      id: "88888888-8888-4888-8888-888888888888", resourceId: API_RESOURCE,
      eventType: "API_RECHARGE", currency: "CNY", accountAmount: "100.00000000",
      cashPaidCny: "720.00", occurredAt: "2026-09-05T02:00:00.000Z",
    };
    const matching = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()], financeEvents: [event],
      draft: candidateOf({ legacyPurchaseResolutions: [resolution({
        resolution: "ALREADY_REPRESENTED", migratedExternalReference: null, financeEventId: event.id })] }),
    }));
    expect(matching.gaps).toEqual([]);
    expect(matching.decision).toBe("GO_CANDIDATE");

    const mismatched = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()], financeEvents: [{ ...event, accountAmount: "120.00000000" }],
      draft: candidateOf({ legacyPurchaseResolutions: [resolution({
        resolution: "ALREADY_REPRESENTED", migratedExternalReference: null, financeEventId: event.id })] }),
    }));
    expect(mismatched.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_REPRESENTATION_MISMATCH", legacyRecordId: LEGACY_ID,
    }));

    const noReference = projectActivationCandidate(quietInput({
      legacyPurchases: [legacyRecord()],
      draft: candidateOf({ legacyPurchaseResolutions: [resolution({
        resolution: "ALREADY_REPRESENTED", migratedExternalReference: null, financeEventId: null })] }),
    }));
    expect(noReference.gaps).toContainEqual(expect.objectContaining({
      code: "LEGACY_REPRESENTATION_MISMATCH", legacyRecordId: LEGACY_ID,
    }));
  });
});

describe("草稿行必填项（防御层）", () => {
  it("零金额、零实付与空证据逐项失败关闭", () => {
    const result = projectActivationCandidate(quietInput({
      draft: candidateOf({
        historicalApiRecharges: [recharge({
          accountAmount: "0.00000000", cashPaidCny: "0.00", evidenceRef: "  ",
        })],
        codingPlanPurchases: [purchase({
          accountAmount: "0.00000000", cashPaidCny: "0.00", evidenceRef: "",
        })],
      }),
    }));
    expect(result.decision).toBe("NO_GO");
    const codes = result.gaps.map((entry) => entry.code);
    expect(codes.filter((code) => code === "MISSING_RECHARGE_AMOUNT")).toHaveLength(1);
    expect(codes.filter((code) => code === "MISSING_RECHARGE_CASH_PAID")).toHaveLength(1);
    expect(codes.filter((code) => code === "MISSING_PURCHASE_AMOUNT")).toHaveLength(1);
    expect(codes.filter((code) => code === "MISSING_PURCHASE_CASH_PAID")).toHaveLength(1);
    expect(codes.filter((code) => code === "MISSING_EVIDENCE")).toHaveLength(2);
  });
});

describe("用量费用分类的负路径", () => {
  const orphan = (id: string, overrides: Partial<LedgerLineFactRow> = {}): LedgerLineFactRow => apiLine({
    id, apiCost: "5.00000000", apiCostCurrency: null, apiCostStatus: null,
    billingRuleSnapshotCurrency: null, billingRuleId: null,
    usageEventId: `bbbbbbbb-0000-4000-8000-0000000000${id.slice(-2)}`,
    ...overrides,
  });

  it("已定价但缺结算币种的 API 用量失败关闭", () => {
    const line = orphan("aaaaaaaa-0000-4000-8000-000000000011");
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), planLine(), line],
      usageEvents: [EVENT_1, EVENT_2, { id: line.usageEventId, inputTokens: "10", outputTokens: "20",
        cacheTokens: "0", reasoningTokens: "0" }],
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "MISSING_API_CURRENCY", category: "USAGE", ledgerLineId: line.id,
    }));
  });

  it("结算币种与计价规则快照币种冲突时失败关闭", () => {
    const line = apiLine({
      id: "aaaaaaaa-0000-4000-8000-000000000012",
      apiCost: "5.00000000", apiCostCurrency: "USD", apiCostStatus: "PRICED_USAGE",
      billingRuleSnapshotCurrency: "CNY", billingRuleId: null,
      usageEventId: "bbbbbbbb-0000-4000-8000-000000000012",
    });
    const result = projectActivationCandidate(baseInput({
      ledgerLines: [apiLine(), planLine(), line],
      usageEvents: [EVENT_1, EVENT_2, { id: line.usageEventId, inputTokens: "10", outputTokens: "20",
        cacheTokens: "0", reasoningTokens: "0" }],
    }));
    expect(result.gaps).toContainEqual(expect.objectContaining({
      code: "CONFLICTING_API_CURRENCY", category: "USAGE", ledgerLineId: line.id,
    }));
  });
});
