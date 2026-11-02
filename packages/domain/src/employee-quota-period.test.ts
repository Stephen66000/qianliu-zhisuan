import { describe, expect, it } from "vitest";
import {
  employeeQuotaMonth,
  employeeQuotaBalance,
} from "./employee-quota-period.js";
describe("employee quota natural months", () => {
  it.each([
    [
      "2026-11-30T15:59:59Z",
      "Asia/Shanghai",
      "2026-11",
      "2026-10-31T16:00:00.000Z",
      "2026-11-30T16:00:00.000Z",
    ],
    [
      "2026-11-30T16:00:00Z",
      "Asia/Shanghai",
      "2026-12",
      "2026-11-30T16:00:00.000Z",
      "2026-12-31T16:00:00.000Z",
    ],
    [
      "2027-01-01T00:00:00Z",
      "UTC",
      "2027-01",
      "2027-01-01T00:00:00.000Z",
      "2027-02-01T00:00:00.000Z",
    ],
    [
      "2028-02-29T12:00:00Z",
      "Asia/Shanghai",
      "2028-02",
      "2028-01-31T16:00:00.000Z",
      "2028-02-29T16:00:00.000Z",
    ],
    [
      "2026-03-31T12:00:00Z",
      "America/New_York",
      "2026-03",
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T04:00:00.000Z",
    ],
  ])("resolves %s in %s", (instant, zone, key, start, end) => {
    const period = employeeQuotaMonth(new Date(instant), zone);
    expect(period.timezone).toBe(zone);
    expect(period.periodKey).toBe(key);
    expect(period.periodStart.toISOString()).toBe(start);
    expect(period.periodEnd.toISOString()).toBe(end);
  });
  it("separates confirmed overage from conservative reservation", () => {
    expect(employeeQuotaBalance(100n, 60n, 50n)).toEqual({
      available: 0n,
      overage: 0n,
    });
    expect(employeeQuotaBalance(100n, 120n, 10n)).toEqual({
      available: 0n,
      overage: 20n,
    });
  });
});

describe("employee quota balances", () => {
  it("keeps available headroom separate from confirmed consumption and reservations", () => {
    expect(employeeQuotaBalance(100n, 30n, 20n)).toEqual({ available: 50n, overage: 0n });
    expect(employeeQuotaBalance(100n, 100n, 0n)).toEqual({ available: 0n, overage: 0n });
    expect(employeeQuotaBalance(0n, 0n, 0n)).toEqual({ available: 0n, overage: 0n });
    expect(employeeQuotaBalance(0n, 5n, 0n)).toEqual({ available: 0n, overage: 5n });
  });
  it.each([[-1n, 0n, 0n], [0n, -1n, 0n], [0n, 0n, -1n]])("rejects negative financial facts %s/%s/%s", (limit, used, reserved) => {
    expect(() => employeeQuotaBalance(limit, used, reserved)).toThrow("negative_quota_fact");
  });
});

it("fails closed when a timezone skips the month's midnight instead of choosing a different instant", () => {
  // Paraguay advanced directly from Sep 30 23:59:59 to Oct 1 01:00:00 in 2023.
  // This policy requires a resolvable 00:00 boundary rather than silently moving it.
  expect(() => employeeQuotaMonth(new Date("2023-10-15T12:00:00Z"), "America/Asuncion"))
    .toThrow("quota_month_boundary_unresolvable");
});
