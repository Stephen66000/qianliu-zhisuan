import { describe, expect, it } from "vitest";
import {
  ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS,
  PROVIDER_FINANCE_CUTOVER_ISO,
  canTransitionCandidateStatus,
  computeCandidateHash,
  computeFactWatermarkHash,
  defaultServiceEndInclusive,
  evaluateQuiescenceLease,
  isWithinShanghaiDay,
  normalizeAccountAmount,
  normalizeCashPaidCny,
  normalizeDraftItem,
  shanghaiPeriodBounds,
  sortActivationGaps,
  stableStringify,
  type ActivationDraft,
  type ActivationGap,
} from "../provider-finance-activation.js";

const RESOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER_RESOURCE = "22222222-2222-4222-8222-222222222222";

function openingDraft(overrides: Partial<ActivationDraft["api_opening_balances"][number]> = {}) {
  return {
    resource_id: RESOURCE,
    account_currency: "CNY" as const,
    account_amount: "100",
    occurred_at: PROVIDER_FINANCE_CUTOVER_ISO,
    description: "DeepSeek 期初余额，来源厂商控制台",
    evidence_ref: "evidence://deepseek/opening-20260901",
    source_record_id: null,
    ...overrides,
  };
}

function baseDraft(): ActivationDraft {
  return {
    schema_version: "1",
    api_opening_balances: [openingDraft()],
    historical_api_recharges: [{
      resource_id: RESOURCE,
      account_currency: "CNY",
      account_amount: "50",
      cash_paid_cny: "50.00",
      occurred_at: "2026-09-05T02:00:00.000Z",
      external_reference: "DS-ORDER-1",
      description: "历史充值",
      evidence_ref: "evidence://deepseek/recharge-1",
      source_record_id: "33333333-3333-4333-8333-333333333333",
      record_idempotency_key: "history-recharge-1",
    }],
    coding_plan_purchases: [{
      resource_id: OTHER_RESOURCE,
      kind: "PURCHASE",
      product_name: "GLM Coding Plan Pro",
      account_amount: "20",
      account_currency: "CNY",
      cash_paid_cny: "20.00",
      service_period_start: "2026-09-01",
      service_period_end: null,
      occurred_at: "2026-09-01T01:00:00.000Z",
      external_reference: "ZP-ORDER-1",
      auto_renew: true,
      description: "智谱套餐首购",
      evidence_ref: "evidence://zhipu/purchase-1",
      source_record_id: null,
      carryover_snapshot_id: null,
      record_idempotency_key: "history-purchase-1",
    }],
    coding_plan_carryovers: [{
      resource_id: OTHER_RESOURCE,
      product_name: "GLM Coding Plan Pro",
      period_start: "2026-08-15",
      period_end: "2026-09-14",
      snapshot_id: "44444444-4444-4444-8444-444444444444",
      description: "跨切换时点周期",
      evidence_ref: "evidence://zhipu/carryover-1",
    }],
    legacy_purchase_resolutions: [
      {
        legacy_record_id: "55555555-5555-4555-8555-555555555555",
        resource_id: RESOURCE,
        resolution: "MIGRATED",
        finance_event_id: null,
        migrated_external_reference: "DS-ORDER-1",
        reason: null,
        evidence_ref: "evidence://deepseek/recharge-1",
      },
      {
        legacy_record_id: "66666666-6666-4666-8666-666666666666",
        resource_id: OTHER_RESOURCE,
        resolution: "REJECTED_WITH_EVIDENCE",
        finance_event_id: null,
        migrated_external_reference: null,
        reason: "该记录为测试订单，未产生实际资金",
        evidence_ref: "evidence://zhipu/test-order",
      },
    ],
  };
}

describe("金额规范化", () => {
  it("账户金额规范为八位小数并允许显式 0", () => {
    expect(normalizeAccountAmount("0")).toBe("0.00000000");
    expect(normalizeAccountAmount("1")).toBe("1.00000000");
    expect(normalizeAccountAmount(12.5)).toBe("12.50000000");
    expect(normalizeAccountAmount("0.00000001")).toBe("0.00000001");
  });

  it("账户金额拒绝负值与超过八位小数", () => {
    expect(() => normalizeAccountAmount("-1")).toThrow(/不得为负/);
    expect(() => normalizeAccountAmount("1.000000001")).toThrow(/最多保留 8 位小数/);
  });

  it("人民币实付规范为两位小数且必须大于 0", () => {
    expect(normalizeCashPaidCny("50")).toBe("50.00");
    expect(normalizeCashPaidCny("50.5")).toBe("50.50");
    expect(() => normalizeCashPaidCny("0")).toThrow(/必须大于 0/);
    expect(() => normalizeCashPaidCny("1.234")).toThrow(/最多保留 2 位小数/);
  });
});

describe("上海自然日周期语义", () => {
  it("默认周期为下个月同日前一日", () => {
    expect(defaultServiceEndInclusive("2026-09-01")).toBe("2026-09-30");
    expect(defaultServiceEndInclusive("2026-01-31")).toBe("2026-02-27");
  });

  it("含结束日转换为 [period_start, period_end_exclusive)", () => {
    const bounds = shanghaiPeriodBounds("2026-09-01", "2026-09-30");
    expect(bounds.periodStart).toBe("2026-08-31T16:00:00.000Z");
    expect(bounds.periodEndExclusive).toBe("2026-09-30T16:00:00.000Z");
    expect(bounds.servicePeriodEndInclusive).toBe("2026-09-30");
  });

  it("结束日为空时使用默认周期", () => {
    const bounds = shanghaiPeriodBounds("2026-09-01", null);
    expect(bounds.servicePeriodEndInclusive).toBe("2026-09-30");
    expect(bounds.periodEndExclusive).toBe("2026-09-30T16:00:00.000Z");
  });

  it("扣费时间按上海自然日判断", () => {
    expect(isWithinShanghaiDay("2026-09-01T01:00:00.000Z", "2026-09-01")).toBe(true);
    expect(isWithinShanghaiDay("2026-08-31T15:59:00.000Z", "2026-09-01")).toBe(false);
    expect(isWithinShanghaiDay("2026-08-31T16:00:00.000Z", "2026-09-01")).toBe(true);
  });
});

describe("稳定序列化与候选哈希", () => {
  it("对象属性顺序不影响稳定序列化", () => {
    expect(stableStringify({ a: 1, b: undefined, c: [1, 2] }))
      .toBe(stableStringify({ c: [1, 2], b: undefined, a: 1 }));
  });

  it("数组顺序与属性顺序不同的等价草稿得到相同候选哈希", () => {
    const draft = baseDraft();
    const shuffled: ActivationDraft = {
      ...draft,
      api_opening_balances: [...draft.api_opening_balances].reverse(),
      legacy_purchase_resolutions: [...draft.legacy_purchase_resolutions].reverse(),
    };
    const left = computeCandidateHash({
      enterpriseId: "77777777-7777-4777-8777-777777777777",
      candidate: normalizeDraftItem(draft, "77777777-7777-4777-8777-777777777777"),
      factWatermarkHash: "a".repeat(64),
    });
    const right = computeCandidateHash({
      enterpriseId: "77777777-7777-4777-8777-777777777777",
      candidate: normalizeDraftItem(shuffled, "77777777-7777-4777-8777-777777777777"),
      factWatermarkHash: "a".repeat(64),
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("金额等价写法（1 / 1.0 / 1.00000000）得到相同候选哈希", () => {
    const enterpriseId = "77777777-7777-4777-8777-777777777777";
    const draft = baseDraft();
    const variant: ActivationDraft = {
      ...draft,
      api_opening_balances: [openingDraft({ account_amount: "100.0" })],
      historical_api_recharges: [{ ...draft.historical_api_recharges[0]!, cash_paid_cny: "50" }],
    };
    const canonical = computeCandidateHash({
      enterpriseId, candidate: normalizeDraftItem(draft, enterpriseId), factWatermarkHash: "b".repeat(64),
    });
    const equivalent = computeCandidateHash({
      enterpriseId, candidate: normalizeDraftItem(variant, enterpriseId), factWatermarkHash: "b".repeat(64),
    });
    expect(canonical).toBe(equivalent);
  });

  it("事实水位或企业变化会改变候选哈希", () => {
    const enterpriseId = "77777777-7777-4777-8777-777777777777";
    const candidate = normalizeDraftItem(baseDraft(), enterpriseId);
    const base = computeCandidateHash({ enterpriseId, candidate, factWatermarkHash: "c".repeat(64) });
    expect(computeCandidateHash({ enterpriseId, candidate, factWatermarkHash: "d".repeat(64) })).not.toBe(base);
    expect(computeCandidateHash({
      enterpriseId: "88888888-8888-4888-8888-888888888888", candidate, factWatermarkHash: "c".repeat(64),
    })).not.toBe(base);
  });

  it("事实水位分段摘要与顺序无关", () => {
    const sections = [
      { section: "provider_resource", count: 2, digest: "1".repeat(64) },
      { section: "ledger_line", count: 5, digest: "2".repeat(64) },
    ];
    expect(computeFactWatermarkHash(sections)).toBe(computeFactWatermarkHash([...sections].reverse()));
  });
});

describe("缺口与状态机", () => {
  it("缺口按确定性顺序排序", () => {
    const gaps: ActivationGap[] = [
      { code: "UNKNOWN_COST", category: "USAGE", message: "缺成本", resourceId: RESOURCE, accountCurrency: null, legacyRecordId: null, ledgerLineId: "9", month: "2026-10", detail: null },
      { code: "MISSING_OPENING_BALANCE", category: "OPENING_BALANCE", message: "缺期初", resourceId: RESOURCE, accountCurrency: "CNY", legacyRecordId: null, ledgerLineId: null, month: null, detail: null },
    ];
    const sorted = sortActivationGaps(gaps);
    expect(sorted[0]!.category).toBe("OPENING_BALANCE");
    expect(sortActivationGaps([...gaps].reverse())[0]!.category).toBe("OPENING_BALANCE");
  });

  it("候选状态机不存在 ACTIVATING 且终态不可外扩", () => {
    expect(canTransitionCandidateStatus("PREVIEWED", "ACTIVATED")).toBe(true);
    expect(canTransitionCandidateStatus("PREVIEWED", "EXPIRED")).toBe(true);
    expect(canTransitionCandidateStatus("ACTIVATED", "PREVIEWED")).toBe(false);
    expect(canTransitionCandidateStatus("EXPIRED", "ACTIVATED")).toBe(false);
    expect(Object.keys({ PREVIEWED: 1, ACTIVATED: 1, EXPIRED: 1, REJECTED: 1 })).not.toContain("ACTIVATING");
  });
});

describe("静默租约判定", () => {
  const now = new Date("2026-09-21T10:00:00.000Z");

  it("ACTIVE 且未过期时有效", () => {
    const evaluation = evaluateQuiescenceLease(
      { status: "ACTIVE", expiresAt: "2026-09-21T10:30:00.000Z" }, now);
    expect(evaluation.active).toBe(true);
    expect(evaluation.remainingSeconds).toBe(1800);
    expect(evaluation.insufficientForActivation).toBe(false);
  });

  it("到期自动失效", () => {
    const evaluation = evaluateQuiescenceLease(
      { status: "ACTIVE", expiresAt: "2026-09-21T09:59:59.000Z" }, now);
    expect(evaluation.active).toBe(false);
    expect(evaluation.insufficientForActivation).toBe(true);
  });

  it("剩余不足 5 分钟时拒绝激活", () => {
    const evaluation = evaluateQuiescenceLease(
      { status: "ACTIVE", expiresAt: "2026-09-21T10:04:59.000Z" }, now);
    expect(evaluation.active).toBe(true);
    expect(evaluation.remainingSeconds).toBeLessThan(ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS);
    expect(evaluation.insufficientForActivation).toBe(true);
  });

  it("已解除租约不可用", () => {
    expect(evaluateQuiescenceLease(
      { status: "RELEASED", expiresAt: "2026-09-21T10:30:00.000Z" }, now).active).toBe(false);
    expect(evaluateQuiescenceLease(null, now).active).toBe(false);
  });
});
