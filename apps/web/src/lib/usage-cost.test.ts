import { describe, expect, it } from "vitest";
import { unavailableUsageCostLabel } from "./usage-cost";

describe("missing usage cost labels", () => {
  it.each([
    [null, "NOT_MIGRATED", "未迁移/不可计算"],
    [null, "UNKNOWN_COST", "未知"],
    [null, "NOT_APPLICABLE", "套餐内"],
    [null, undefined, "未知"],
    ["0", "CONFIRMED_ZERO_NO_UPSTREAM", null],
    ["1.25000000", "PRICED_USAGE", null],
  ])("keeps %s with status %s distinct", (amount, status, expected) => {
    expect(unavailableUsageCostLabel(amount, status)).toBe(expected);
  });
});
