import { expect, it } from "vitest";
import { billingPriceMultiplier, computeApiCostFromRule, matchApplicableBillingRule, type BillingRule } from "../billing-rule.js";
import { matchPolicy, type DispatchInput, type DispatchPolicy } from "../dispatch-policy.js";

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

it("distinguishes unknown rules, quota multipliers and absolute all-day prices", () => {
  expect(billingPriceMultiplier(null)).toBeNull();
  expect(billingPriceMultiplier({ ...base, ruleType: "MODEL_TIER", pricingMode: "ABSOLUTE", multiplier: "2" })).toBe("2");
  expect(billingPriceMultiplier({ ...peak, ruleType: "TIME_WINDOW", pricingMode: "ABSOLUTE" })).toBe("3");
  expect(billingPriceMultiplier({ ...base, pricingMode: "ABSOLUTE", multiplier: "9" })).toBe("1");
  expect(billingPriceMultiplier({ ...base, pricingMode: undefined })).toBe("1");
});

it("preserves legacy missing-component costs without converting absent prices to invalid decimals", () => {
  const legacy = { ...base, pricingMode: "ABSOLUTE" as const };
  expect(computeApiCostFromRule({ ...legacy, cacheMissPrice: null }, 10, 20, 2)).toBe("0.00008200");
  expect(computeApiCostFromRule({ ...legacy, outputPrice: null }, 10, 20, 2)).toBe("0.00001800");
  expect(() => computeApiCostFromRule({ ...base, multiplier: "0" }, 10, 20, 2)).toThrow("incomplete_multiplier_price");
});

it("an unknown multiplier cannot satisfy a peak policy, while known boundary values can", () => {
  const policy: DispatchPolicy = { id: "p", status: "PUBLISHED", matchUnifiedModel: null,
    matchResourceMode: null, matchProviderResourceId: null, matchTimezone: null, matchDaysOfWeek: null,
    matchStartTime: null, matchEndTime: null, matchPriceMultiplierMin: "3", matchRemainingQuotaRatioMax: null,
    matchForecastExhaustRisk: null, matchPrincipalScope: null, action: "REJECT", switchEquivalentGroup: [],
    rateLimitPerMinute: null, policyVersion: "v1", priority: 100 };
  const input: DispatchInput = { now: 0, unifiedModel: "m", selectedResourceId: "r", resourceMode: "API",
    priceMultiplier: null, remainingQuotaRatio: null, forecastExhaustRisk: false, principalId: "employee" };
  expect(matchPolicy(policy, input)).toBe(false);
  expect(matchPolicy({ ...policy, matchPriceMultiplierMin: "0" }, input)).toBe(false);
  expect(matchPolicy({ ...policy, matchPriceMultiplierMin: "0" }, { ...input, priceMultiplier: "0" })).toBe(true);
  expect(matchPolicy(policy, { ...input, priceMultiplier: "2.999" })).toBe(false);
  expect(matchPolicy(policy, { ...input, priceMultiplier: "3" })).toBe(true);
  expect(matchPolicy({ ...policy, matchPriceMultiplierMin: null }, input)).toBe(true);
});
