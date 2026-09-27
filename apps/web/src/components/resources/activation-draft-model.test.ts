/**
 * 初始化草稿纯模型测试（WP05 任务 5.2、5.5；PFU-02、PFU-05、PFH-01～PFH-03）。
 *
 * 重点覆盖三类最容易出错的语义：
 *  1. **零值与空值严格区分**（显式 0 是有效零值；留空是「未填写」，不得自动补 0）；
 *  2. **空行省略**：整行皆空的草稿行不参与请求体，也不产生本地错误；
 *  3. **请求体卫生**：载荷只含业务草稿，绝不含 `enterprise_id` / `admin_id`（PFA-07）。
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_MAX_DRAFT_ROWS, buildActivationDraft, countActiveRows, emptyDraftState,
  isValidAccountAmount, isValidCashPaidCny, newLocalRowId, toInstant, validateDraft,
  validateHistoricalCostRow, validateLegacyRow, validateOpeningRow, validateRechargeRow,
  type ActivationDraftState, type HistoricalCostRowState, type LegacyRowState,
  type OpeningRowState, type RechargeRowState,
} from "./activation-draft-model";

const CUTOVER = "2026-08-31T16:00:00.000Z";
const RESOURCE = "11111111-1111-4111-8111-111111111111";

function openingRow(patch: Partial<OpeningRowState> = {}): OpeningRowState {
  return {
    id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY", accountAmount: "",
    description: "期初来源：厂商后台截图", evidenceRef: "shot-2026-09-01", sourceRecordId: "", ...patch,
  };
}

function stateWith(rows: Partial<ActivationDraftState>): ActivationDraftState {
  return { ...emptyDraftState(), ...rows };
}

describe("账户金额格式", () => {
  it("接受最多 8 位小数的非负金额，拒绝负号、千分位与超长小数", () => {
    expect(isValidAccountAmount("0")).toBe(true);
    expect(isValidAccountAmount("1234.12345678")).toBe(true);
    expect(isValidAccountAmount("0.1")).toBe(true);
    expect(isValidAccountAmount("-1")).toBe(false);
    expect(isValidAccountAmount("1,000")).toBe(false);
    expect(isValidAccountAmount("1.123456789")).toBe(false);
  });

  it("人民币实付最多两位小数且必须大于 0", () => {
    expect(isValidCashPaidCny("0.01")).toBe(true);
    expect(isValidCashPaidCny("0")).toBe(false);
    expect(isValidCashPaidCny("0.001")).toBe(false);
  });

  it("上海自然日时间输入按 +08:00 解释为瞬时", () => {
    expect(toInstant("2026-09-01T00:00")).toBe("2026-08-31T16:00:00.000Z");
    expect(toInstant("")).toBeNull();
  });
});

describe("零值与空值", () => {
  it("显式 0 是有效期初，原样进入请求体", () => {
    const row = openingRow({ accountAmount: "0" });
    expect(validateOpeningRow(row, CUTOVER)).toEqual([]);
    const payload = buildActivationDraft(stateWith({ apiOpeningBalances: [row] }), CUTOVER);
    expect(payload.api_opening_balances).toHaveLength(1);
    expect(payload.api_opening_balances[0]).toMatchObject({ account_amount: "0", occurred_at: CUTOVER });
  });

  it("留空是「未填写」，报错且绝不自动转换为 0", () => {
    const row = openingRow({ accountAmount: "" });
    const issues = validateOpeningRow(row, CUTOVER);
    expect(issues.map((issue) => issue.field)).toContain("accountAmount");
    expect(issues.find((issue) => issue.field === "accountAmount")?.message).toContain("空值与 0 不同");
    // 行本身非空（有其他字段），因此会进入请求体前置校验分支；确认没有把空值变成 "0"。
    const payload = buildActivationDraft(stateWith({ apiOpeningBalances: [row] }), CUTOVER);
    expect(payload.api_opening_balances[0]!.account_amount).toBe("");
  });

  it("整行皆空时省略该行，既不报错也不进入请求体", () => {
    const blank: OpeningRowState = {
      id: newLocalRowId(), resourceId: "", accountCurrency: "CNY", accountAmount: "",
      description: "", evidenceRef: "", sourceRecordId: "",
    };
    expect(validateDraft(stateWith({ apiOpeningBalances: [blank] }), CUTOVER)).toEqual([]);
    const payload = buildActivationDraft(stateWith({ apiOpeningBalances: [blank] }), CUTOVER);
    expect(payload.api_opening_balances).toEqual([]);
    expect(countActiveRows(stateWith({ apiOpeningBalances: [blank] })).apiOpeningBalances).toBe(0);
  });
});

describe("请求体卫生", () => {
  it("载荷不含 enterprise_id / admin_id，期初时点固定为切换时点", () => {
    const payload = buildActivationDraft(stateWith({ apiOpeningBalances: [openingRow({ accountAmount: "10" })] }), CUTOVER);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("enterprise_id");
    expect(serialized).not.toContain("admin_id");
    expect(payload.schema_version).toBe("1");
    expect(payload.api_opening_balances[0]!.occurred_at).toBe(CUTOVER);
  });

  it("未填写切换时点时，期初行被本地拦下（不产生无意义请求）", () => {
    const row = openingRow({ accountAmount: "10" });
    expect(validateOpeningRow(row, null).map((issue) => issue.message).join("")).toContain("尚未取得资金切换时点");
  });
});

describe("历史 API 充值：六项最小表单", () => {
  function rechargeRow(patch: Partial<RechargeRowState> = {}): RechargeRowState {
    return {
      id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY", accountAmount: "50",
      cashPaidCny: "50.00", occurredAtLocal: "2026-09-05T10:00", externalReference: "DS-ORDER-9",
      ...patch,
    };
  }

  it("合法六项行通过校验，载荷只含六项业务字段", () => {
    const row = rechargeRow();
    expect(validateRechargeRow(row)).toEqual([]);
    const payload = buildActivationDraft(stateWith({ historicalApiRecharges: [row] }), CUTOVER);
    expect(payload.historical_api_recharges).toEqual([{
      resource_id: RESOURCE,
      account_currency: "CNY",
      account_amount: "50",
      cash_paid_cny: "50.00",
      occurred_at: "2026-09-05T02:00:00.000Z",
      external_reference: "DS-ORDER-9",
    }]);
    // 事实说明、证据引用、来源旧记录与幂等键不再由表单发送（服务端自动生成）。
    const serialized = JSON.stringify(payload.historical_api_recharges[0]);
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("evidence_ref");
    expect(serialized).not.toContain("source_record_id");
    expect(serialized).not.toContain("record_idempotency_key");
  });

  it("缺失订单号或无效时间被本地拦下", () => {
    const issues = validateRechargeRow(rechargeRow({ externalReference: " " }));
    expect(issues.map((issue) => issue.field)).toContain("externalReference");
    expect(validateRechargeRow(rechargeRow({ occurredAtLocal: "not-a-time" }))
      .map((issue) => issue.field)).toContain("occurredAt");
  });

  it("同一厂商资源下重复订单号被草稿级检查拦下；不同资源可用同一订单号", () => {
    const state = stateWith({
      historicalApiRecharges: [rechargeRow(), rechargeRow({ id: newLocalRowId() })],
    });
    const duplicateIssues = validateDraft(state, CUTOVER)
      .filter((issue) => issue.section === "historicalApiRecharges");
    expect(duplicateIssues).toHaveLength(2);
    expect(duplicateIssues.every((issue) => issue.field === "externalReference")).toBe(true);
    const distinctResources = stateWith({
      historicalApiRecharges: [
        rechargeRow(),
        rechargeRow({ id: newLocalRowId(), resourceId: "22222222-2222-4222-8222-222222222222" }),
      ],
    });
    expect(validateDraft(distinctResources, CUTOVER)).toEqual([]);
  });

  it("整行皆空时省略该行，不报错也不进入请求体", () => {
    const blank: RechargeRowState = {
      id: newLocalRowId(), resourceId: "", accountCurrency: "CNY", accountAmount: "",
      cashPaidCny: "", occurredAtLocal: "", externalReference: "",
    };
    expect(validateDraft(stateWith({ historicalApiRecharges: [blank] }), CUTOVER)).toEqual([]);
    expect(buildActivationDraft(stateWith({ historicalApiRecharges: [blank] }), CUTOVER)
      .historical_api_recharges).toEqual([]);
  });
});

describe("旧购买记录关闭", () => {
  function legacyRow(patch: Partial<LegacyRowState> = {}): LegacyRowState {
    return {
      id: newLocalRowId(), legacyRecordId: RESOURCE, resourceId: RESOURCE, resolution: "MIGRATED",
      financeEventId: "", migratedExternalReference: "order-2026-09", reason: "", evidenceRef: "", ...patch,
    };
  }

  it("MIGRATED 必须给外部订单引用", () => {
    expect(validateLegacyRow(legacyRow())).toEqual([]);
    expect(validateLegacyRow(legacyRow({ migratedExternalReference: "" }))
      .map((issue) => issue.field)).toContain("migratedExternalReference");
  });

  it("ALREADY_REPRESENTED 必须引用既有资金事件", () => {
    const row = legacyRow({ resolution: "ALREADY_REPRESENTED", migratedExternalReference: "" });
    expect(validateLegacyRow(row).map((issue) => issue.field)).toContain("financeEventId");
    expect(validateLegacyRow({ ...row, financeEventId: RESOURCE })).toEqual([]);
  });

  it("REJECTED_WITH_EVIDENCE 必须同时给原因与证据，且不构成对 UNKNOWN_COST 的豁免", () => {
    const row = legacyRow({ resolution: "REJECTED_WITH_EVIDENCE", migratedExternalReference: "" });
    const fields = validateLegacyRow(row).map((issue) => issue.field);
    expect(fields).toContain("reason");
    expect(fields).toContain("evidenceRef");
    const closed = { ...row, reason: "该记录为试用赠额，非实际资金事实", evidenceRef: "mail-2026-09" };
    expect(validateLegacyRow(closed)).toEqual([]);
    // 关闭旧记录不会改变任何用量行状态：载荷里没有 UNKNOWN_COST 相关字段。
    const payload = buildActivationDraft(stateWith({ legacyResolutions: [closed] }), CUTOVER);
    expect(Object.keys(payload)).toEqual([
      "schema_version", "api_opening_balances", "historical_api_recharges",
      "historical_api_costs",
      "coding_plan_purchases", "coding_plan_carryovers", "legacy_purchase_resolutions",
    ]);
  });
});

describe("行数上限", () => {
  it("单类草稿行数超过上限时报错", () => {
    const rows = Array.from({ length: ACTIVATION_MAX_DRAFT_ROWS + 1 }, (_, index) =>
      openingRow({ id: `row-${index}`, accountAmount: "1" }));
    const issues = validateDraft(stateWith({ apiOpeningBalances: rows }), CUTOVER);
    expect(issues.map((issue) => issue.message).some((message) => message.includes("不得超过"))).toBe(true);
  });
});

describe("历史 API 消耗行（0084）：四字段与正数输入", () => {
  const CUTOVER = "2026-08-31T16:00:00.000Z";
  const costRow = (): HistoricalCostRowState => ({
    id: "cost-1", resourceId: RESOURCE, accountCurrency: "CNY",
    costAmount: "40.4572", costUntilLocal: "2026-09-10T12:00",
  });

  it("合法行零问题，payload 只含四项且金额保持正数", () => {
    expect(validateHistoricalCostRow(costRow(), CUTOVER)).toEqual([]);
    const state = { ...emptyDraftState(), historicalApiCosts: [costRow()] };
    const payload = buildActivationDraft(state, CUTOVER);
    expect(payload.historical_api_costs).toEqual([{
      resource_id: RESOURCE, account_currency: "CNY",
      cost_amount: "40.4572", cost_until_at: "2026-09-10T04:00:00.000Z",
    }]);
  });

  it("金额必须为正数：空、0、负数、超精度都报错", () => {
    const state = { ...emptyDraftState(), historicalApiCosts: [costRow()] };
    for (const [amount, field] of [["", "costAmount"], ["0", "costAmount"]] as const) {
      const broken = { ...state, historicalApiCosts: [{ ...costRow(), costAmount: amount }] };
      expect(validateDraft(broken, CUTOVER).some((issue) => issue.field === field)).toBe(true);
    }
    for (const amount of ["-5", "1.123456789"]) {
      const broken = { ...state, historicalApiCosts: [{ ...costRow(), costAmount: amount }] };
      expect(validateDraft(broken, CUTOVER).some((issue) => issue.field === "costAmount")).toBe(true);
    }
  });

  it("截止时间不得早于切换时点、不得晚于当前时间；空行整行省略", () => {
    const state = { ...emptyDraftState(), historicalApiCosts: [costRow()] };
    const early = { ...state, historicalApiCosts: [{ ...costRow(), costUntilLocal: "2026-08-31T23:00" }] };
    expect(validateDraft(early, CUTOVER).some((issue) =>
      issue.field === "costUntil" && issue.message.includes("不得早于资金切换时点"))).toBe(true);
    const future = { ...state, historicalApiCosts: [{ ...costRow(), costUntilLocal: "2099-01-01T08:00" }] };
    expect(validateDraft(future, CUTOVER).some((issue) =>
      issue.field === "costUntil" && issue.message.includes("不得晚于当前时间"))).toBe(true);
    expect(buildActivationDraft({ ...emptyDraftState(),
      historicalApiCosts: [{ id: "blank", resourceId: "", accountCurrency: "CNY",
        costAmount: "", costUntilLocal: "" }] }, CUTOVER).historical_api_costs).toEqual([]);
  });

  it("同一资源、币种、截止时间的消耗行在草稿内防重", () => {
    const state = { ...emptyDraftState(), historicalApiCosts: [costRow(), { ...costRow(), id: "cost-2" }] };
    const issues = validateDraft(state, CUTOVER);
    expect(issues.filter((issue) => issue.field === "costUntil"
      && issue.message.includes("不得重复登记")).length).toBe(2);
  });
});
