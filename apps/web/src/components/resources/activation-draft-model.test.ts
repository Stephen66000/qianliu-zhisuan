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
  validateLegacyRow, validateOpeningRow, type ActivationDraftState, type LegacyRowState,
  type OpeningRowState,
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
