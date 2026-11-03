import { describe, expect, it } from "vitest";
import { costMoneyText, unavailableUsageCostLabel } from "./usage-cost";

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
