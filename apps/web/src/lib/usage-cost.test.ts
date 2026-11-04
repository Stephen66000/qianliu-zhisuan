import { describe, expect, it } from "vitest";
import { costMoneyExactText, costMoneyText, unavailableUsageCostLabel } from "./usage-cost";

describe("missing usage cost labels", () => {
  it.each([
    [null, "NOT_MIGRATED", "未迁移/不可计算"],
    ["0.00000000", "EXCLUDED_NO_RECORDED_COST", "未记录费用，不计入"],
    [null, "UNKNOWN_COST", "未知"],
    [null, "NOT_APPLICABLE", "套餐内"],
    [null, undefined, "未知"],
    ["0", "CONFIRMED_ZERO_NO_UPSTREAM", null],
    ["1.25000000", "PRICED_USAGE", null],
    // ACE-04 缺口分类（WP4-S2 合同 6）：价格缺失/币种缺失为缺口；价格依据待核实为信息项，
    // 文案不带"待计价"措辞。
    [null, "PRICE_MISSING", "价格缺失"],
    [null, "PRICE_BASIS_UNVERIFIED", "价格依据待核实"],
    [null, "CURRENCY_MISSING", "币种缺失"],
  ])("keeps %s with status %s distinct", (amount, status, expected) => {
    expect(unavailableUsageCostLabel(amount, status)).toBe(expected);
  });
});

describe("costMoneyText 行内币种金额展示（ACE-07，WP4-S2 合同 5）", () => {
  it.each([
    ["12.50000000", "CNY", "¥12.50"],
    ["12.50000000", undefined, "¥12.50"],
    ["12.50000000", null, "¥12.50"],
    ["2.00000000", "USD", "USD 2.00"],
    ["2.00000000", "EUR", "EUR 2.00"],
  ])("formats %s with currency %s as %s without mixing currencies", (value, currency, expected) => {
    expect(costMoneyText(value, currency)).toBe(expected);
  });
});

// D-1（2026-11-04 走查裁定，验收计划 §3"小额非零估算应能从详情查明"）：
// 请求详情精确金额展示——8 位小数尺度原值直出，不做两位舍入（如 0.00104 ≠ 0.00）；
// 币种规则与 costMoneyText 一致（非 CNY 前缀币种、CNY/缺省回退 ¥）。
describe("costMoneyExactText 请求详情精确金额展示（D-1）", () => {
  it.each([
    ["0.00104", undefined, "¥0.00104"],
    ["0.00104", null, "¥0.00104"],
    ["0.00104", "CNY", "¥0.00104"],
    ["0.00100000", undefined, "¥0.001"],
    ["12.50000000", "CNY", "¥12.5"],
    ["0.00104", "USD", "USD 0.00104"],
    ["2.00000000", "EUR", "EUR 2"],
  ])("formats %s with currency %s as %s without rounding away small amounts", (value, currency, expected) => {
    expect(costMoneyExactText(value, currency)).toBe(expected);
  });
});
