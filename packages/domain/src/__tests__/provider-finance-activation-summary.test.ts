import { describe, expect, it } from "vitest";
import {
  compareActivationGaps,
  computeCollectionDigest,
  normalizeAccountAmount,
  normalizeCashPaidCny,
  normalizeDraftItem,
  sortActivationGaps,
  sortUsageRepairBaseline,
  stableStringify,
  summarizeActivationGaps,
  type ActivationDraft,
  type ActivationGap,
  type UsageRepairBaselineRow,
} from "../index.js";

const CUTOVER = "2026-08-31T16:00:00.000Z";
const API_RESOURCE = "11111111-1111-4111-8111-111111111111";
const PLAN_RESOURCE = "22222222-2222-4222-8222-222222222222";
const LEGACY_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_LEGACY_ID = "66666666-6666-4666-8666-666666666667";

function gapOf(overrides: Partial<ActivationGap> = {}): ActivationGap {
  return {
    code: "UNKNOWN_COST", category: "USAGE", message: "用量费用状态未明确",
    resourceId: null, accountCurrency: null, legacyRecordId: null, ledgerLineId: null,
    month: null, detail: null, ...overrides,
  };
}

describe("缺口摘要与确定性排序", () => {
  it("比较键完全相同时视为等价（detail 不参与排序）", () => {
    expect(compareActivationGaps(gapOf({ detail: "左" }), gapOf({ detail: "右" }))).toBe(0);
    expect(sortActivationGaps([gapOf({ detail: "左" }), gapOf({ detail: "右" })])).toHaveLength(2);
  });

  it("比较键不同时给出 -1 / 1，且空值按空串参与比较", () => {
    expect(compareActivationGaps(gapOf({ code: "MISSING_API_CURRENCY" }), gapOf({ code: "UNKNOWN_COST" })))
      .toBe(-1);
    expect(compareActivationGaps(gapOf({ code: "UNKNOWN_COST" }), gapOf({ code: "MISSING_API_CURRENCY" })))
      .toBe(1);
    expect(compareActivationGaps(gapOf({ resourceId: null }), gapOf({ resourceId: API_RESOURCE }))).toBe(-1);
  });

  it("按 code 归并计数并稳定排序", () => {
    const summary = summarizeActivationGaps([
      gapOf({ code: "UNKNOWN_COST" }),
      gapOf({ code: "UNKNOWN_COST" }),
      gapOf({ code: "NEGATIVE_BALANCE" }),
    ]);
    expect(summary).toEqual([
      { code: "NEGATIVE_BALANCE", count: 1 },
      { code: "UNKNOWN_COST", count: 2 },
    ]);
    expect(summarizeActivationGaps([])).toEqual([]);
  });

  it("修复基准行按主键排序且不修改入参顺序", () => {
    const row = (ledgerLineId: string): UsageRepairBaselineRow => ({
      ledgerLineId, eligibleRepairs: ["settled_at"],
      targetFieldsBeforeHash: "a".repeat(64), nonTargetFieldsBeforeHash: "b".repeat(64),
    });
    const input = [row("cccccccc-0000-4000-8000-000000000003"), row("aaaaaaaa-0000-4000-8000-000000000001")];
    expect(sortUsageRepairBaseline(input).map((entry) => entry.ledgerLineId)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000003",
    ]);
    expect(input[0]!.ledgerLineId).toBe("cccccccc-0000-4000-8000-000000000003");
  });
});

describe("稳定序列化与集合摘要", () => {
  it("非有限数值不得进入稳定序列化", () => {
    expect(() => stableStringify({ amount: Number.POSITIVE_INFINITY })).toThrow(/非有限数值/);
  });

  it("集合摘要与对象键顺序无关，且对内容敏感", () => {
    const left = computeCollectionDigest([{ b: 1, a: 2 }, null]);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(computeCollectionDigest([{ a: 2, b: 1 }, null])).toBe(left);
    expect(computeCollectionDigest([{ a: 2, b: 1 }])).not.toBe(left);
  });
});

describe("金额规范化拒绝非法十进制", () => {
  it("非数字字符串在规范化入口失败关闭", () => {
    expect(() => normalizeAccountAmount("abc")).toThrow(/不是合法十进制数/);
    expect(() => normalizeCashPaidCny("abc")).toThrow(/不是合法十进制数/);
  });
});

describe("草稿规范化排序", () => {
  it("多行草稿按业务键稳定排序（覆盖全部次序比较键）", () => {
    const recharge = (
      occurredAt: string, sourceRecordId: string, key: string,
    ): ActivationDraft["historical_api_recharges"][number] => ({
      resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "1",
      cash_paid_cny: "1.00", occurred_at: occurredAt, external_reference: "R",
      description: "充值", evidence_ref: "evidence://r", source_record_id: sourceRecordId,
      record_idempotency_key: key,
    });
    const planPurchase = (
      productName: string, sourceRecordId: string | null, key: string,
    ): ActivationDraft["coding_plan_purchases"][number] => ({
      resource_id: PLAN_RESOURCE, kind: "PURCHASE", product_name: productName,
      account_amount: "1", account_currency: "CNY", cash_paid_cny: "1.00",
      service_period_start: "2026-09-20", service_period_end: "2026-10-19",
      occurred_at: "2026-09-20T02:00:00.000Z", external_reference: "P", auto_renew: true,
      description: "购买", evidence_ref: "evidence://p", source_record_id: sourceRecordId,
      carryover_snapshot_id: null, record_idempotency_key: key,
    });
    const carryoverItem = (
      periodStart: string, periodEnd: string, snapshotId: string,
    ): ActivationDraft["coding_plan_carryovers"][number] => ({
      resource_id: PLAN_RESOURCE, product_name: "套餐", period_start: periodStart,
      period_end: periodEnd, snapshot_id: snapshotId, description: "跨切换周期",
      evidence_ref: "evidence://c",
    });
    const draft: ActivationDraft = {
      schema_version: "1",
      api_opening_balances: [
        { resource_id: API_RESOURCE, account_currency: "USD", account_amount: "10",
          occurred_at: CUTOVER, description: "期初", evidence_ref: "evidence://o1",
          source_record_id: null },
        { resource_id: API_RESOURCE, account_currency: "CNY", account_amount: "20",
          occurred_at: CUTOVER, description: "期初", evidence_ref: "evidence://o2",
          source_record_id: null },
      ],
      historical_api_recharges: [
        recharge("2026-09-06T02:00:00.000Z", LEGACY_ID, "k-3"),
        recharge("2026-09-05T02:00:00.000Z", OTHER_LEGACY_ID, "k-2"),
        recharge("2026-09-05T02:00:00.000Z", LEGACY_ID, "k-1"),
      ],
      coding_plan_purchases: [
        planPurchase("A", LEGACY_ID, "k-6"),
        planPurchase("B", null, "k-5"),
        planPurchase("A", null, "k-4"),
      ],
      coding_plan_carryovers: [
        carryoverItem("2026-09-10", "2026-10-09", "s-2"),
        carryoverItem("2026-08-10", "2026-09-09", "s-1"),
      ],
      legacy_purchase_resolutions: [
        { legacy_record_id: LEGACY_ID, resource_id: PLAN_RESOURCE, resolution: "MIGRATED",
          finance_event_id: null, migrated_external_reference: "x", reason: null, evidence_ref: null },
        { legacy_record_id: LEGACY_ID, resource_id: API_RESOURCE, resolution: "MIGRATED",
          finance_event_id: null, migrated_external_reference: "x", reason: null, evidence_ref: null },
      ],
    };
    const candidate = normalizeDraftItem(draft, "77777777-7777-4777-8777-777777777777");
    expect(candidate.apiOpeningBalances.map((row) => row.accountCurrency)).toEqual(["CNY", "USD"]);
    expect(candidate.historicalApiRecharges.map((row) => row.recordIdempotencyKey))
      .toEqual(["k-1", "k-2", "k-3"]);
    expect(candidate.codingPlanPurchases.map((row) => row.recordIdempotencyKey))
      .toEqual(["k-4", "k-5", "k-6"]);
    expect(candidate.codingPlanCarryovers.map((row) => row.snapshotId)).toEqual(["s-1", "s-2"]);
    expect(candidate.legacyPurchaseResolutions.map((row) => row.resourceId))
      .toEqual([API_RESOURCE, PLAN_RESOURCE]);
  });
});
