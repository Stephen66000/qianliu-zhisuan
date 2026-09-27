import { describe, expect, it } from "vitest";
import {
  historicalCostEvidenceRef,
  historicalCostFactDescription,
  historicalCostIdempotencyKey,
  rechargeRecordIdempotencyKey,
} from "@qianliu/domain";
import {
  ActivationDraftSchema,
  ActivationRequestBody,
  LegacyPurchaseResolutionDraftSchema,
  QuiescenceStartBody,
  toActivationDraft,
} from "./activation-contracts.js";

const RESOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

function minimalDraft(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    api_opening_balances: [{
      resource_id: RESOURCE,
      account_currency: "CNY",
      account_amount: "0",
      occurred_at: "2026-08-31T16:00:00.000Z",
      description: "切换时点余额为零",
      evidence_ref: "evidence://deepseek/opening-zero",
    }],
    ...overrides,
  };
}

describe("激活草稿合同", () => {
  it("接受显式零值期初并保留说明与证据", () => {
    const parsed = ActivationDraftSchema.parse(minimalDraft());
    const draft = toActivationDraft(parsed);
    expect(draft.api_opening_balances[0]!.account_amount).toBe("0");
    expect(draft.api_opening_balances[0]!.source_record_id).toBeNull();
    expect(draft.historical_api_recharges).toEqual([]);
  });

  it("拒绝缺少说明或证据的期初", () => {
    const missingDescription = ActivationDraftSchema.safeParse(minimalDraft({
      api_opening_balances: [{
        resource_id: RESOURCE,
        account_currency: "CNY",
        account_amount: "0",
        occurred_at: "2026-08-31T16:00:00.000Z",
        evidence_ref: "evidence://x",
      }],
    }));
    expect(missingDescription.success).toBe(false);
    const blankEvidence = ActivationDraftSchema.safeParse(minimalDraft({
      api_opening_balances: [{
        resource_id: RESOURCE,
        account_currency: "CNY",
        account_amount: "0",
        occurred_at: "2026-08-31T16:00:00.000Z",
        description: "说明",
        evidence_ref: "   ",
      }],
    }));
    expect(blankEvidence.success).toBe(false);
  });

  it("拒绝权威身份字段进入请求体", () => {
    const parsed = ActivationDraftSchema.safeParse(minimalDraft({ enterprise_id: RESOURCE }));
    expect(parsed.success).toBe(false);
  });

  it("拒绝超过八位小数或负数的期初金额", () => {
    expect(ActivationDraftSchema.safeParse(minimalDraft({
      api_opening_balances: [{
        resource_id: RESOURCE, account_currency: "CNY", account_amount: "1.000000001",
        occurred_at: "2026-08-31T16:00:00.000Z", description: "d", evidence_ref: "e",
      }],
    })).success).toBe(false);
    expect(ActivationDraftSchema.safeParse(minimalDraft({
      api_opening_balances: [{
        resource_id: RESOURCE, account_currency: "CNY", account_amount: "-1",
        occurred_at: "2026-08-31T16:00:00.000Z", description: "d", evidence_ref: "e",
      }],
    })).success).toBe(false);
  });

  it("拒绝超过数组上限的草稿", () => {
    const rows = Array.from({ length: 501 }, () => ({
      resource_id: RESOURCE, account_currency: "CNY", account_amount: "0",
      occurred_at: "2026-08-31T16:00:00.000Z", description: "d", evidence_ref: "e",
    }));
    expect(ActivationDraftSchema.safeParse(minimalDraft({ api_opening_balances: rows })).success).toBe(false);
  });

  it("旧记录关闭决定按类型强制引用或证据", () => {
    const migrated = LegacyPurchaseResolutionDraftSchema.safeParse({
      legacy_record_id: EVENT, resource_id: RESOURCE, resolution: "MIGRATED",
    });
    expect(migrated.success).toBe(false);
    expect(LegacyPurchaseResolutionDraftSchema.safeParse({
      legacy_record_id: EVENT, resource_id: RESOURCE, resolution: "MIGRATED",
      migrated_external_reference: "DS-ORDER-1",
    }).success).toBe(true);
    expect(LegacyPurchaseResolutionDraftSchema.safeParse({
      legacy_record_id: EVENT, resource_id: RESOURCE, resolution: "ALREADY_REPRESENTED",
    }).success).toBe(false);
    expect(LegacyPurchaseResolutionDraftSchema.safeParse({
      legacy_record_id: EVENT, resource_id: RESOURCE, resolution: "REJECTED_WITH_EVIDENCE",
      reason: "测试订单", evidence_ref: "evidence://zhipu/test",
    }).success).toBe(true);
    expect(LegacyPurchaseResolutionDraftSchema.safeParse({
      legacy_record_id: EVENT, resource_id: RESOURCE, resolution: "REJECTED_WITH_EVIDENCE",
      reason: "测试订单",
    }).success).toBe(false);
  });

  it("周期草稿要求扣费与周期字段完整并校验结束日", () => {
    const base = {
      schema_version: "1",
      coding_plan_purchases: [{
        resource_id: OTHER, kind: "PURCHASE", product_name: "GLM Pro",
        account_amount: "20", account_currency: "CNY", cash_paid_cny: "20",
        service_period_start: "2026-09-01", occurred_at: "2026-09-01T01:00:00.000Z",
        external_reference: "ZP-1", auto_renew: false, description: "购买",
        evidence_ref: "evidence://zhipu/1", record_idempotency_key: "zhipu-purchase-1",
      }],
    };
    const parsed = ActivationDraftSchema.parse(base);
    expect(parsed.coding_plan_purchases[0]!.service_period_end).toBeUndefined();
    const draft = toActivationDraft(parsed);
    expect(draft.coding_plan_purchases[0]!.service_period_end).toBeNull();
    expect(ActivationDraftSchema.safeParse({
      ...base,
      coding_plan_purchases: [{ ...base.coding_plan_purchases[0]!, service_period_end: "2026-08-01" }],
    }).success).toBe(false);
  });
});

describe("历史 API 充值草稿：无旧记录最小录入", () => {
  function rechargeDraft(overrides: Record<string, unknown> = {}) {
    return minimalDraft({
      historical_api_recharges: [{
        resource_id: RESOURCE,
        account_currency: "CNY",
        account_amount: "50",
        cash_paid_cny: "50.00",
        occurred_at: "2026-09-05T02:00:00.000Z",
        external_reference: "DS-ORDER-9",
        ...overrides,
      }],
    });
  }

  it("source_record_id 缺失时通过校验，内部字段由服务端确定性生成", () => {
    const parsed = ActivationDraftSchema.parse(rechargeDraft());
    expect(parsed.historical_api_recharges[0]!.source_record_id).toBeUndefined();
    const draft = toActivationDraft(parsed);
    const recharge = draft.historical_api_recharges[0]!;
    expect(recharge.source_record_id).toBeNull();
    expect(recharge.description).toBe("历史 API 充值:DS-ORDER-9");
    expect(recharge.evidence_ref).toBe("provider-order:DS-ORDER-9");
    expect(recharge.record_idempotency_key)
      .toBe(rechargeRecordIdempotencyKey(RESOURCE, "DS-ORDER-9"));
    // 确定性：相同资源+订单的重复提交得到同一幂等键。
    const replayed = toActivationDraft(ActivationDraftSchema.parse(rechargeDraft()));
    expect(replayed.historical_api_recharges[0]!.record_idempotency_key)
      .toBe(recharge.record_idempotency_key);
  });

  it("显式提供内部字段时旧路径语义不变（带旧 source_record_id 兼容）", () => {
    const parsed = ActivationDraftSchema.parse(rechargeDraft({
      description: "历史充值（迁移）",
      evidence_ref: "evidence://deepseek/recharge-1",
      source_record_id: EVENT,
      record_idempotency_key: "history-recharge-1",
    }));
    const draft = toActivationDraft(parsed);
    const recharge = draft.historical_api_recharges[0]!;
    expect(recharge.source_record_id).toBe(EVENT);
    expect(recharge.description).toBe("历史充值（迁移）");
    expect(recharge.evidence_ref).toBe("evidence://deepseek/recharge-1");
    expect(recharge.record_idempotency_key).toBe("history-recharge-1");
  });

  it("source_record_id 显式 null 合法，非法 UUID 被拒绝", () => {
    expect(ActivationDraftSchema.safeParse(rechargeDraft({ source_record_id: null })).success).toBe(true);
    expect(ActivationDraftSchema.safeParse(rechargeDraft({ source_record_id: "not-a-uuid" })).success).toBe(false);
  });

  it("充值订单号必填且不得超过 255 字", () => {
    expect(ActivationDraftSchema.safeParse(rechargeDraft({ external_reference: "" })).success).toBe(false);
    expect(ActivationDraftSchema.safeParse(rechargeDraft({ external_reference: "x".repeat(256) })).success).toBe(false);
    expect(ActivationDraftSchema.safeParse(rechargeDraft({ external_reference: "x".repeat(255) })).success).toBe(true);
  });
});

describe("激活与静默租约请求体", () => {
  it("激活请求体校验候选哈希与幂等键", () => {
    expect(ActivationRequestBody.safeParse({
      candidate_id: EVENT, candidate_hash: "a".repeat(64), idempotency_key: "activate-1",
      confirm_enterprise_id: RESOURCE,
    }).success).toBe(true);
    expect(ActivationRequestBody.safeParse({
      candidate_id: EVENT, candidate_hash: "A".repeat(64), idempotency_key: "activate-1",
      confirm_enterprise_id: RESOURCE,
    }).success).toBe(false);
    expect(ActivationRequestBody.safeParse({
      candidate_id: EVENT, candidate_hash: "a".repeat(64), idempotency_key: "short",
      confirm_enterprise_id: RESOURCE,
    }).success).toBe(false);
  });

  it("静默租约时长上限 60 分钟", () => {
    expect(QuiescenceStartBody.safeParse({ duration_seconds: 3600 }).success).toBe(true);
    expect(QuiescenceStartBody.safeParse({ duration_seconds: 3601 }).success).toBe(false);
    expect(QuiescenceStartBody.safeParse({}).success).toBe(true);
  });
});


describe("历史 API 消耗合同（0084）", () => {
  const costRow = {
    resource_id: RESOURCE,
    account_currency: "CNY",
    cost_amount: "40.4572",
    cost_until_at: "2026-09-10T04:00:00.000Z",
  };

  it("接受四字段草稿，载荷不含说明/证据/幂等键（strict 拒绝未知字段）", () => {
    const parsed = ActivationDraftSchema.parse(minimalDraft({ historical_api_costs: [costRow] }));
    expect(parsed.historical_api_costs).toHaveLength(1);
    const draft = toActivationDraft(parsed);
    expect(draft.historical_api_costs[0]).toEqual(costRow);
    // 未知内部字段拒绝：说明/证据/幂等键由服务端生成，不接受客户端提交。
    const withExtra = ActivationDraftSchema.safeParse(minimalDraft({
      historical_api_costs: [{ ...costRow, description: "管理员写的说明" }],
    }));
    expect(withExtra.success).toBe(false);
  });

  it("缺字段拒绝：金额缺失、非法币种、非法时间都不通过", () => {
    for (const broken of [
      { ...costRow, cost_amount: undefined },
      { ...costRow, cost_amount: "0" },
      { ...costRow, cost_amount: "-5" },
      { ...costRow, cost_amount: "1.123456789" },
      { ...costRow, account_currency: "EUR" },
      { ...costRow, cost_until_at: "2026-09-10 04:00:00" },
    ]) {
      expect(ActivationDraftSchema.safeParse(minimalDraft({ historical_api_costs: [broken] })).success)
        .toBe(false);
    }
  });

  it("成本截止时间不得早于切换时点、不得晚于当前时间", () => {
    const beforeCutover = ActivationDraftSchema.safeParse(minimalDraft({
      historical_api_costs: [{ ...costRow, cost_until_at: "2026-08-31T15:59:59.999Z" }],
    }));
    expect(beforeCutover.success).toBe(false);
    const inFuture = ActivationDraftSchema.safeParse(minimalDraft({
      historical_api_costs: [{ ...costRow, cost_until_at: "2099-01-01T00:00:00.000Z" }],
    }));
    expect(inFuture.success).toBe(false);
    const atCutover = ActivationDraftSchema.parse(minimalDraft({
      historical_api_costs: [{ ...costRow, cost_until_at: "2026-08-31T16:00:00.000Z" }],
    }));
    expect(atCutover.historical_api_costs[0]!.cost_until_at).toBe("2026-08-31T16:00:00.000Z");
  });

  it("服务端默认说明/证据/幂等键可由领域纯函数复现（normalizeDraftItem 输入合同一致）", () => {
    expect(historicalCostFactDescription("2026-09-10T04:00:00.000Z"))
      .toBe("历史 API 消耗:2026-09-10T04:00:00.000Z");
    expect(historicalCostEvidenceRef(RESOURCE, "CNY", "2026-09-10T04:00:00.000Z", "40.4572"))
      .toMatch(/^provider-usage:[0-9a-f]{32}$/);
    expect(historicalCostIdempotencyKey(RESOURCE, "CNY", "2026-09-10T04:00:00.000Z", "40.4572"))
      .toMatch(/^pf-u:/);
  });
});
