import { describe, expect, it } from "vitest";

import {
  currentShanghaiMonthRange,
  dayAfterShanghaiDate,
  defaultServiceEndDate,
  SubscriptionBody,
} from "./contracts.js";

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

  it("requires an explicit description and evidence for every subscription write", () => {
    const base = {
      kind: "PURCHASE", product_name: "Kimi Coding Plan", account_amount: "199",
      account_currency: "CNY", cash_paid_cny: "199",
      occurred_at: "2026-08-19T02:00:00.000Z", service_period_start: "2026-08-19",
      description: "厂商订单 2026-08 首购",
      evidence_ref: "evidence://kimi/order-20260819",
      idempotency_key: "calendar-month-test",
    };
    expect(SubscriptionBody.safeParse(base).success).toBe(true);
    // PFH-06：说明与证据必填，兼容接口不得绕过
    expect(SubscriptionBody.safeParse({ ...base, description: undefined }).success).toBe(false);
    expect(SubscriptionBody.safeParse({ ...base, evidence_ref: undefined }).success).toBe(false);
    expect(SubscriptionBody.safeParse({ ...base, evidence_ref: "  " }).success).toBe(false);
    // 自定义周期必须晚于开始日；说明已由必填字段强制
    expect(SubscriptionBody.safeParse({ ...base, service_period_end: "2026-09-17" }).success)
      .toBe(true);
    expect(SubscriptionBody.safeParse({ ...base, service_period_end: "2026-08-01" }).success)
      .toBe(false);
  });

  it("defaults history to the current Shanghai calendar month", () => {
    expect(currentShanghaiMonthRange(new Date("2026-09-30T16:30:00.000Z"))).toEqual({
      from: new Date("2026-09-30T16:00:00.000Z"),
      to: new Date("2026-10-31T16:00:00.000Z"),
    });
  });
});
