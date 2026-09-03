import { describe, expect, it } from "vitest";

import { dayAfterShanghaiDate, defaultServiceEndDate, SubscriptionBody } from "./contracts.js";

describe("Coding Plan calendar-month service period", () => {
  it.each([
    ["2026-08-19", "2026-09-18", "2026-09-18T16:00:00.000Z"],
    ["2026-09-19", "2026-10-18", "2026-10-18T16:00:00.000Z"],
    ["2027-01-31", "2027-02-27", "2027-02-27T16:00:00.000Z"],
    ["2028-01-31", "2028-02-28", "2028-02-28T16:00:00.000Z"],
  ])("starts on %s and renews on the matching next-month date", (start, end, exclusive) => {
    expect(defaultServiceEndDate(start)).toBe(end);
    expect(dayAfterShanghaiDate(end).toISOString()).toBe(exclusive);
  });

  it("requires a note only when overriding the calendar-month result", () => {
    const base = {
      kind: "PURCHASE", product_name: "Kimi Coding Plan", account_amount: "199",
      account_currency: "CNY", cash_paid_cny: "199",
      occurred_at: "2026-08-19T02:00:00.000Z", service_period_start: "2026-08-19",
      idempotency_key: "calendar-month-test",
    };
    expect(SubscriptionBody.safeParse(base).success).toBe(true);
    expect(SubscriptionBody.safeParse({ ...base, service_period_end: "2026-09-17" }).success)
      .toBe(false);
    expect(SubscriptionBody.safeParse({ ...base, service_period_end: "2026-09-17",
      description: "厂商订单明确提前一天到期" }).success).toBe(true);
  });
});
