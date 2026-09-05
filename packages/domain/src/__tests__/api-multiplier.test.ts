import { expect, it } from "vitest";
import { billingPriceMultiplier, computeApiCostFromRule, matchApplicableBillingRule, type BillingRule } from "../billing-rule.js";

const base: BillingRule = { id: "base", ruleType: "API_PRICE", ruleVersion: "v1", providerResourceId: "r", upstreamModel: "m",
  effectiveFrom: 0, effectiveTo: null, timezone: null, daysOfWeek: null, startTime: null, endTime: null,
  timeWindows: null, multiplier: "1", pricingMode: "MULTIPLIER", cacheHitPrice: "0.000001",
  cacheMissPrice: "0.000002", outputPrice: "0.000004", currency: "CNY", priority: 100 };
const peak: BillingRule = { ...base, id: "peak", multiplier: "3", timeWindows: [
  { timezone: "Asia/Shanghai", daysOfWeek: [1], startTime: "09:00", endTime: "12:00" },
  { timezone: "Asia/Shanghai", daysOfWeek: [1], startTime: "23:00", endTime: "02:00" },
] };

it.each([
  ["2026-09-07T00:59:59Z", "2.20000000", "1"],
  ["2026-09-07T01:00:00Z", "6.60000000", "3"],
  ["2026-09-07T04:00:00Z", "2.20000000", "1"],
  ["2026-09-07T17:59:59Z", "6.60000000", "3"],
  ["2026-09-07T18:00:00Z", "2.20000000", "1"],
])("%s price and dispatch resolve the same multiplier", (at, cost, multiplier) => {
  const rule = matchApplicableBillingRule([base, peak], "r", "m", "API", Date.parse(at))!;
  expect(computeApiCostFromRule(rule, 1_000_000, 100_000, 200_000)).toBe(cost);
  expect(billingPriceMultiplier(rule)).toBe(multiplier);
});
it("legacy absolute prices ignore multiplier and cannot invent a peak ratio", () => {
  const rule = { ...peak, pricingMode: "ABSOLUTE" as const };
  expect(computeApiCostFromRule(rule, 1_000_000, 100_000, 200_000)).toBe("2.20000000");
  expect(billingPriceMultiplier(rule)).toBeNull();
});
it("rounds once after the multiplier, not the intermediate cost", () => {
  expect(computeApiCostFromRule({ ...base, cacheMissPrice: "0.000000004", multiplier: "3" }, 1, 0, 0)).toBe("0.00000001");
});
it("missing multiplier or base component cannot produce a zero price", () => {
  expect(() => computeApiCostFromRule({ ...base, multiplier: null }, 1, 0, 0)).toThrow("incomplete_multiplier_price");
  expect(() => computeApiCostFromRule({ ...base, cacheHitPrice: null }, 1, 0, 0)).toThrow("incomplete_multiplier_price");
});
