import { describe, expect, it } from "vitest";
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
