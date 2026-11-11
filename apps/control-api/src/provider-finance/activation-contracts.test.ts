import { describe, expect, it } from "vitest";
import {
  carryoverDraftKey,
  carryoverEvidenceRef,
  carryoverFactDescription,
  historicalCostEvidenceRef,
  historicalCostFactDescription,
  historicalCostIdempotencyKey,
  rechargeEvidenceRef,
  rechargeFactDescription,
  rechargeRecordIdempotencyKey,
} from "@qianliu/domain";
import {
  ActivationDraftSchema,
  ActivationRequestBody,
  HistoricalApiCostDraftSchema,
  HistoricalRechargeDraftSchema,
  LegacyPurchaseResolutionDraftSchema,
  OpeningBalanceDraftSchema,
  QuiescenceStartBody,
  toActivationDraft,
} from "./activation-contracts.js";

const RESOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

/**
 * 纯套餐基底草稿（断言迁移 WP2-S4 / AFR-01 场景3）：原基底携带一条 API 期初行，
 * 该类行已随 API 资金管理退役——提交即被 {@link ActivationDraftSchema} 拒绝，
 * 合法基底改为空 API 数组（省略或 [] 均可）。
 */
function minimalDraft(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    api_opening_balances: [],
    historical_api_recharges: [],
    historical_api_costs: [],
    ...overrides,
  };
}

/** 退役形态的 API 期初行（仅用于断言提交即拒）。 */
function retiredOpeningRow(overrides: Record<string, unknown> = {}) {
  return {
    resource_id: RESOURCE,
    account_currency: "CNY",
    account_amount: "0",
    occurred_at: "2026-08-31T16:00:00.000Z",
    description: "切换时点余额为零",
    evidence_ref: "evidence://deepseek/opening-zero",
    ...overrides,
  };
}

const RETIRED_MESSAGE = "API 内部资金管理已退役，初始化草稿不再接受 API 资金事实"
  + "（api_opening_balances/historical_api_recharges/historical_api_costs），请仅提交套餐所需事实";

describe("激活草稿合同", () => {
  it("含 API 期初的旧草稿提交即被拒绝并说明退役；空数组照常通过（WP2-S4 / AFR-01 场景3）", () => {
    // 断言迁移（WP2-S4 / plan §4.4、§4a-R4）：原“接受显式零值期初”随 API 资金管理
    // 退役——API 期初行不得被静默剥离后继续激活混合候选。
    const retired = ActivationDraftSchema.safeParse({
      ...minimalDraft(),
      api_opening_balances: [retiredOpeningRow()],
    });
    expect(retired.success).toBe(false);
    if (!retired.success) expect(retired.error.issues[0]!.message).toBe(RETIRED_MESSAGE);

    // 纯套餐（空 API 数组）是唯一合法形态：显式 [] 与省略等价。
    const parsed = ActivationDraftSchema.parse(minimalDraft());
    const draft = toActivationDraft(parsed);
    expect(draft.api_opening_balances).toEqual([]);
    expect(draft.historical_api_recharges).toEqual([]);

    // 行级 schema 保留存档：零值金额与 source_record_id 归一语义由行 schema 钉死。
    const row = OpeningBalanceDraftSchema.parse({ ...retiredOpeningRow(), source_record_id: undefined });
    expect(row.account_amount).toBe("0");
    expect(row.source_record_id).toBeUndefined();
  });

  it("拒绝缺少说明或证据的期初（行级校验语义保留；整类行在提交层已随退役被拒）", () => {
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

  it("拒绝超过八位小数或负数的期初金额（行级校验语义保留；整类行在提交层已随退役被拒）", () => {
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

  it("拒绝超过数组上限的草稿（上限语义保留；API 类数组在提交层已随退役被拒）", () => {
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

describe("历史 API 充值草稿（WP2-S4 / AFR-01 场景3：提交入口退役，行级 schema 存档）", () => {
  function rechargeRow(overrides: Record<string, unknown> = {}) {
    return {
      resource_id: RESOURCE,
      account_currency: "CNY",
      account_amount: "50",
      cash_paid_cny: "50.00",
      occurred_at: "2026-09-05T02:00:00.000Z",
      external_reference: "DS-ORDER-9",
      ...overrides,
    };
  }

  it("含历史充值的旧草稿提交即被拒绝并说明退役（不静默剥离）", () => {
    const retired = ActivationDraftSchema.safeParse({
      ...minimalDraft(), historical_api_recharges: [rechargeRow()],
    });
    expect(retired.success).toBe(false);
    if (!retired.success) expect(retired.error.issues[0]!.message).toBe(RETIRED_MESSAGE);
  });

  it("行级 schema 存档：source_record_id 缺省语义与确定性内部字段生成（领域纯函数合同）", () => {
    const row = HistoricalRechargeDraftSchema.parse(rechargeRow());
    expect(row.source_record_id).toBeUndefined();
    // 内部字段确定性生成合同保留在领域纯函数上（提交入口已退役，规范化不可再达）。
    expect(rechargeFactDescription("DS-ORDER-9")).toBe("历史 API 充值:DS-ORDER-9");
    expect(rechargeEvidenceRef("DS-ORDER-9")).toBe("provider-order:DS-ORDER-9");
    // 确定性：相同资源+订单得到同一幂等键。
    expect(rechargeRecordIdempotencyKey(RESOURCE, "DS-ORDER-9"))
      .toBe(rechargeRecordIdempotencyKey(RESOURCE, "DS-ORDER-9"));
  });

  it("行级 schema 存档：显式内部字段旧路径语义不变（带旧 source_record_id 兼容）", () => {
    const row = HistoricalRechargeDraftSchema.parse(rechargeRow({
      description: "历史充值（迁移）",
      evidence_ref: "evidence://deepseek/recharge-1",
      source_record_id: EVENT,
      record_idempotency_key: "history-recharge-1",
    }));
    expect(row.source_record_id).toBe(EVENT);
    expect(row.description).toBe("历史充值（迁移）");
    expect(row.evidence_ref).toBe("evidence://deepseek/recharge-1");
    expect(row.record_idempotency_key).toBe("history-recharge-1");
  });

  it("行级 schema 存档：source_record_id 显式 null 合法，非法 UUID 被拒绝", () => {
    expect(HistoricalRechargeDraftSchema.safeParse(rechargeRow({ source_record_id: null })).success).toBe(true);
    expect(HistoricalRechargeDraftSchema.safeParse(rechargeRow({ source_record_id: "not-a-uuid" })).success).toBe(false);
  });

  it("行级 schema 存档：充值订单号必填且不得超过 255 字", () => {
    expect(HistoricalRechargeDraftSchema.safeParse(rechargeRow({ external_reference: "" })).success).toBe(false);
    expect(HistoricalRechargeDraftSchema.safeParse(rechargeRow({ external_reference: "x".repeat(256) })).success).toBe(false);
    expect(HistoricalRechargeDraftSchema.safeParse(rechargeRow({ external_reference: "x".repeat(255) })).success).toBe(true);
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


describe("历史 API 消耗合同（0084；WP2-S4 / AFR-01 场景3：提交入口退役，行级 schema 存档）", () => {
  const costRow = {
    resource_id: RESOURCE,
    account_currency: "CNY",
    cost_amount: "40.4572",
    cost_until_at: "2026-09-10T04:00:00.000Z",
  };

  it("含历史消耗的旧草稿提交即被拒绝并说明退役；行级 strict 未知字段拒绝保留", () => {
    const retired = ActivationDraftSchema.safeParse(minimalDraft({ historical_api_costs: [costRow] }));
    expect(retired.success).toBe(false);
    if (!retired.success) expect(retired.error.issues[0]!.message).toBe(RETIRED_MESSAGE);
    // 行级存档：载荷不含说明/证据/幂等键（strict 拒绝未知字段）。
    const withExtra = HistoricalApiCostDraftSchema.safeParse({
      ...costRow, description: "管理员写的说明",
    });
    expect(withExtra.success).toBe(false);
  });

  it("行级存档：缺字段拒绝——金额缺失、非法币种、非法时间都不通过", () => {
    for (const broken of [
      { ...costRow, cost_amount: undefined },
      { ...costRow, cost_amount: "0" },
      { ...costRow, cost_amount: "-5" },
      { ...costRow, cost_amount: "1.123456789" },
      { ...costRow, account_currency: "EUR" },
      { ...costRow, cost_until_at: "2026-09-10 04:00:00" },
    ]) {
      expect(HistoricalApiCostDraftSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("行级存档：成本截止时间不得早于切换时点、不得晚于当前时间", () => {
    expect(HistoricalApiCostDraftSchema.safeParse(
      { ...costRow, cost_until_at: "2026-08-31T15:59:59.999Z" }).success).toBe(false);
    expect(HistoricalApiCostDraftSchema.safeParse(
      { ...costRow, cost_until_at: "2099-01-01T00:00:00.000Z" }).success).toBe(false);
    const atCutover = HistoricalApiCostDraftSchema.parse(
      { ...costRow, cost_until_at: "2026-08-31T16:00:00.000Z" });
    expect(atCutover.cost_until_at).toBe("2026-08-31T16:00:00.000Z");
  });

  it("服务端默认说明/证据/幂等键可由领域纯函数复现（normalizeDraftItem 输入合同一致）", () => {
    expect(historicalCostFactDescription("2026-09-10T04:00:00.000Z", "CNY", "40.45720000"))
      .toContain("管理员确认的旧库计价汇总");
    expect(historicalCostFactDescription("2026-09-10T04:00:00.000Z", "CNY", "40.45720000"))
      .toContain("40.45720000");
    expect(historicalCostEvidenceRef(RESOURCE, "CNY", "2026-09-10T04:00:00.000Z", "40.4572"))
      .toMatch(/^admin-declared:legacy-db-api-cost:[0-9a-f]{32}$/);
    expect(historicalCostIdempotencyKey(RESOURCE, "CNY", "2026-09-10T04:00:00.000Z", "40.4572"))
      .toMatch(/^pf-u:/);
  });

  it("同一资源与币种的多条历史消耗被合同拒绝（不同截止时间也不放行，R2；提交入口随退役关闭）", () => {
    const duplicate = ActivationDraftSchema.safeParse(minimalDraft({
      historical_api_costs: [
        { ...costRow, cost_until_at: "2026-09-05T02:00:00.000Z" },
        { ...costRow, cost_until_at: "2026-09-15T02:00:00.000Z", cost_amount: "10" },
      ],
    }));
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      // 退役拒绝与 R2 去重拒绝都会进入 issues（superRefine 链各自独立执行）。
      expect(JSON.stringify(duplicate.error.issues)).toContain("最多只能登记一条历史 API 消耗");
      expect(duplicate.error.issues[0]!.message).toBe(RETIRED_MESSAGE);
    }
    // 不同资源各一条在行级仍合法（整类行的提交入口已随退役关闭）。
    expect(HistoricalApiCostDraftSchema.safeParse(costRow).success).toBe(true);
    expect(HistoricalApiCostDraftSchema.safeParse({ ...costRow, resource_id: OTHER }).success).toBe(true);
  });
});

describe("管理员声明跨切换周期合同（无旧库快照）", () => {
  const carryRow = {
    resource_id: OTHER,
    product_name: "GLM Coding Plan Pro",
    period_start: "2026-08-26",
    period_end: "2026-09-25",
    snapshot_id: null,
  };

  it("四字段（snapshot_id=null、无说明/证据）接受，载荷归一为 null 内部字段", () => {
    const parsed = ActivationDraftSchema.parse(minimalDraft({ coding_plan_carryovers: [carryRow] }));
    const draft = toActivationDraft(parsed);
    expect(draft.coding_plan_carryovers[0]).toEqual({
      ...carryRow, description: null, evidence_ref: null,
    });
    // 显式 null 与缺省等价。
    const explicitNull = ActivationDraftSchema.parse(minimalDraft({
      coding_plan_carryovers: [{
        ...carryRow,
        snapshot_id: undefined, description: undefined, evidence_ref: undefined,
      }],
    }));
    expect(toActivationDraft(explicitNull).coding_plan_carryovers[0]).toEqual({
      ...carryRow, description: null, evidence_ref: null,
    });
  });

  it("显式提供 snapshot_id + 说明/证据的旧路径继续兼容；非法快照 UUID 拒绝", () => {
    const legacy = ActivationDraftSchema.safeParse(minimalDraft({
      coding_plan_carryovers: [{
        ...carryRow, snapshot_id: "44444444-4444-4444-8444-444444444444",
        description: "跨切换时点周期", evidence_ref: "evidence://zhipu/carryover-1",
      }],
    }));
    expect(legacy.success).toBe(true);
    const badSnapshot = ActivationDraftSchema.safeParse(minimalDraft({
      coding_plan_carryovers: [{ ...carryRow, snapshot_id: "not-a-uuid" }],
    }));
    expect(badSnapshot.success).toBe(false);
  });

  it("服务端默认说明/证据/草稿键可由领域纯函数复现（normalizeDraftItem 输入合同一致）", () => {
    expect(carryoverFactDescription(carryRow.product_name, carryRow.period_start, carryRow.period_end))
      .toContain("管理员确认的新服务器迁移跨切换周期");
    expect(carryoverEvidenceRef(carryRow.resource_id, carryRow.product_name,
      carryRow.period_start, carryRow.period_end))
      .toMatch(/^admin-declared:cross-cutover-period:[0-9a-f]{32}$/);
    expect(carryoverDraftKey({
      snapshotId: null, resourceId: carryRow.resource_id, productName: carryRow.product_name,
      periodStart: "2026-08-25T16:00:00.000Z", periodEndExclusive: "2026-09-25T16:00:00.000Z",
    })).toMatch(/^admin:[0-9a-f]{32}$/);
    expect(carryoverDraftKey({
      snapshotId: "44444444-4444-4444-8444-444444444444", resourceId: carryRow.resource_id,
      productName: carryRow.product_name, periodStart: "x", periodEndExclusive: "y",
    })).toBe("44444444-4444-4444-8444-444444444444");
  });
});
