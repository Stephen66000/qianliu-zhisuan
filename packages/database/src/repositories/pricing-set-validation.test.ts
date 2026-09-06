import { expect, it } from "vitest";
import { pricingSetIssue } from "./pricing-set-validation.js";

type Row = Parameters<typeof pricingSetIssue>[0][number];
const row = (version: string, extra: Partial<Row> = {}): Row => ({ rule_type: "API_PRICE", rule_version: version,
  effective_from: new Date("2026-09-01T00:00:00Z"), ...extra });
const window = (start: string, end: string, days: number[] | null = [1], timezone = "Asia/Shanghai") => ({
  start_time: start, end_time: end, days_of_week: days, timezone,
});
const pair = (a: Partial<Row>, b: Partial<Row>) => pricingSetIssue([row("a", a), row("b", b)]);

it("requires unique versions and one effective boundary for the submitted set", () => {
  expect(pricingSetIssue([row("a"), row("a")])).toContain("版本名称不能重复");
  expect(pair({}, { effective_from: new Date("2026-09-02T00:00:00Z") })).toContain("同一生效时间");
  expect(pricingSetIssue([row("a")])).toBeNull();
});

it("expired existing rules and rules starting exactly at the new end do not conflict", () => {
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-10-01T00:00:00Z");
  expect(pricingSetIssue([row("new")], [row("old", { effective_from: new Date(0), effective_to: start })])).toBeNull();
  expect(pricingSetIssue([row("new", { effective_to: end })], [row("future", { effective_from: end })])).toBeNull();
  expect(pricingSetIssue([row("new")], [row("old", { effective_from: new Date(0), effective_to: new Date(start.getTime() + 1) })])).toContain("重叠");
});

it("rejects mixed API modes and currencies, including implicit defaults", () => {
  expect(pair({}, { pricing_mode: "MULTIPLIER" })).toContain("不能混用");
  expect(pair({ pricing_mode: "MULTIPLIER" }, { pricing_mode: "ABSOLUTE" })).toContain("不能混用");
  expect(pair({}, { currency: "USD" })).toContain("币种必须一致");
  expect(pair({ currency: "USD" }, {})).toContain("币种必须一致");
  expect(pair({ currency: "USD", priority: 10 }, { currency: "USD", priority: 20 })).toBeNull();
  expect(pair({ rule_type: "MODEL_TIER", priority: 10 }, { rule_type: "TIME_WINDOW", priority: 20 })).toBeNull();
  expect(pair({}, { rule_type: "MODEL_TIER", priority: 10 })).toBeNull();
});

it("different priorities resolve overlap; same-priority all-day rules are ambiguous", () => {
  expect(pair({}, { priority: 10 })).toBeNull();
  expect(pair({ priority: 10 }, {})).toBeNull();
  expect(pair({}, { priority: 100 })).toContain("重叠");
  expect(pair({ time_windows: [window("09:00", "12:00")] }, {})).toBeNull();
  expect(pair({}, { time_windows: [window("09:00", "12:00")] })).toBeNull();
});

it.each([
  ["09:00", "12:00", "11:59:59", "14:00", true],
  ["09:00", "12:00", "12:00", "14:00", false],
  ["09:00", "12:00", "08:00", "09:00", false],
  ["09:00", "12:00", "08:00", "09:00:01", true],
])("compares exact half-open boundaries %s–%s / %s–%s", (start, end, otherStart, otherEnd, conflict) => {
  const issue = pair({ time_windows: [window(start, end)] }, { time_windows: [window(otherStart, otherEnd)] });
  expect(issue !== null).toBe(conflict);
});

it("handles start-day ownership and the Sunday-to-Monday wrap for overnight windows", () => {
  const overnight = { time_windows: [window("23:00", "02:00", [7])] };
  expect(pair(overnight, { time_windows: [window("01:00", "03:00", [1])] })).toContain("重叠");
  expect(pair(overnight, { time_windows: [window("02:00", "03:00", [1])] })).toBeNull();
  expect(pair(overnight, { time_windows: [window("23:30", "23:59", [7])] })).toContain("重叠");
  expect(pair(overnight, { time_windows: [window("01:00", "02:00", [7])] })).toBeNull();
});

it("respects weekdays, all-week defaults and explicit empty window lists", () => {
  expect(pair({ time_windows: [window("09:00", "12:00", [1])] }, { time_windows: [window("09:00", "12:00", [2])] })).toBeNull();
  expect(pair({ time_windows: [window("09:00", "12:00", null)] }, { time_windows: [window("09:00", "12:00", [2])] })).toContain("重叠");
  expect(pair({ time_windows: [] }, {})).toContain("重叠");
});

it("supports legacy single windows and gives explicit multi-window configuration precedence", () => {
  const legacy = { timezone: "Asia/Shanghai", start_time: "09:00", end_time: "12:00", days_of_week: [1] };
  expect(pair(legacy, { time_windows: [window("11:00", "13:00")] })).toContain("重叠");
  expect(pair({ ...legacy, days_of_week: null }, { time_windows: [window("11:00", "13:00", [2])] })).toContain("重叠");
  expect(pair({ ...legacy, time_windows: [] }, {})).toContain("重叠");
  expect(pair({ timezone: "Asia/Shanghai" }, {})).toContain("重叠");
  expect(pair({ timezone: "Asia/Shanghai", start_time: "09:00" }, {})).toContain("重叠");
});

it("requires explicit priority for cross-zone windows rather than guessing an offset", () => {
  expect(pair({ time_windows: [window("09:00", "12:00")] }, { time_windows: [window("14:00", "18:00", [1], "UTC")] })).toContain("重叠");
  expect(pair({ time_windows: [window("09:00", "12:00")] }, { priority: 1, time_windows: [window("14:00", "18:00", [1], "UTC")] })).toBeNull();
});

it("uses minutes and seconds accurately within the same hour", () => {
  expect(pair({ time_windows: [window("09:15", "09:45")] }, { time_windows: [window("09:46", "10:00")] })).toBeNull();
  expect(pair({ time_windows: [window("09:30", "09:31")] }, { time_windows: [window("09:30:30", "09:30:59")] })).toContain("重叠");
});

it("finds any intersecting window, including the ending segment of an overnight window", () => {
  const multi = { time_windows: [window("09:00", "10:00"), window("14:00", "15:00")] };
  const afternoon = { time_windows: [window("14:30", "16:00")] };
  expect(pair(multi, afternoon)).toContain("重叠");
  expect(pair(afternoon, multi)).toContain("重叠");
  expect(pair({ time_windows: [window("01:00", "02:00", [2])] }, { time_windows: [window("23:00", "03:00", [1])] })).toContain("重叠");
});

it("does not widen legacy weekdays or manufacture windows from incomplete legacy fields", () => {
  const legacy = { timezone: "Asia/Shanghai", start_time: "09:00", end_time: "12:00", days_of_week: [1] };
  expect(pair(legacy, { time_windows: [window("09:00", "12:00", [2])] })).toBeNull();
  expect(pair(legacy, { time_windows: [window("14:00", "15:00")] })).toBeNull();
  expect(pair({ end_time: "12:00" }, {})).toContain("重叠");
  expect(pair({ timezone: "Asia/Shanghai", end_time: "12:00" }, {})).toContain("重叠");
});

it("API-mode conflicts do not replace resource-mode validation for heterogeneous rule types", () => {
  expect(pair({ rule_type: "MODEL_TIER" }, { pricing_mode: "MULTIPLIER", priority: 10 })).toBeNull();
  expect(pair({ pricing_mode: "MULTIPLIER" }, { rule_type: "MODEL_TIER", priority: 10 })).toBeNull();
});

it("does not silently treat legacy equal-endpoint windows as empty when checking conflicts", () => {
  // Existing DB rows do not have the HTTP input validator's unequal-endpoint guarantee.
  const incoming = row("new", { time_windows: [window("09:00", "10:00")] });
  const legacy = row("legacy", { time_windows: [window("00:00", "00:00")] });
  expect(pricingSetIssue([incoming], [legacy])).toContain("重叠");
});
