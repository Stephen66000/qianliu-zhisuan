import { expect, it } from "vitest";
import type { BillingRule, ProviderResourceItem } from "../../api/types";
import { pricingCopyCandidates, currentPricingSet, copyPrice } from "./pricing-copy";
import { decimalProduct } from "./PricingPreview";

const resources = [
  { id: "a", provider_id: "deepseek", mode: "API" },
  { id: "b", provider_id: "deepseek", mode: "API" },
  { id: "c", provider_id: "kimi", mode: "API" },
  { id: "d", provider_id: "deepseek", mode: "CODING_PLAN" },
] as ProviderResourceItem[];
const rule = (id: string, resource = "a", patch: Partial<BillingRule> = {}): BillingRule => ({
  id, provider_resource_id: resource, upstream_model: "flash", rule_type: "API_PRICE", rule_version: id,
  effective_from: "2026-01-01T00:00:00Z", effective_to: null, time_windows: null, timezone: null,
  start_time: null, end_time: null, days_of_week: null, multiplier: null, currency: "CNY",
  cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004",
  priority: 100, enabled: true, archived_at: null, archived_by_admin_id: null,
  source: "TEST", version: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...patch,
});
it("cannot copy between providers or API/package; excludes future and expired versions", () => {
  const list = [rule("same"), rule("kimi", "c"), rule("package", "d"),
    rule("future", "a", { effective_from: "2099-01-01T00:00:00Z" }), rule("expired", "a", { effective_to: "2026-01-02T00:00:00Z" })];
  expect(pricingCopyCandidates(list, resources, "b", "flash").map((r) => r.id)).toEqual(["same"]);
});
it("copies a full effective base/peak set even with different start dates, preferring current base version", () => {
  const base = rule("base", "a", { effective_from: "2026-02-01T00:00:00Z" });
  const peak = rule("peak", "a", { effective_from: "2026-03-01T00:00:00Z", time_windows: [
    { timezone: "Asia/Shanghai", days_of_week: [1], start_time: "14:00", end_time: "18:00" },
  ] });
  const set = currentPricingSet([rule("old-base"), base, peak], base);
  expect(set.map((r) => r.id)).toEqual(["peak", "base"]);
  expect(copyPrice(peak, "b", "pro", "new")).toMatchObject({ upstream_model: "pro", provider_resource_id: "b", rule_version: "peak-new", windows: [{ timezone: "Asia/Shanghai" }] });
  expect(peak.upstream_model).toBe("flash");
});
it("shows small per-token and final per-million prices without binary rounding or truncation", () => {
  expect(decimalProduct("0.000000004", "3")).toBe("0.000000012");
  expect(decimalProduct("0.000000012", "1000000")).toBe("0.012");
  expect(decimalProduct("0", "3")).toBe("0");
});
