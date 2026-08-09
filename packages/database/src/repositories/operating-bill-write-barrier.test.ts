import { describe, expect, it } from "vitest";

import { operatingBillMonthAt } from "./operating-bill-write-barrier.js";

describe("POOL-043 经营账单结算屏障", () => {
  it("以北京时间月界线确定 ledger_line 账期", () => {
    expect(operatingBillMonthAt(new Date("2026-07-31T15:59:59.999Z"))).toBe("2026-07");
    expect(operatingBillMonthAt(new Date("2026-07-31T16:00:00.000Z"))).toBe("2026-08");
    expect(operatingBillMonthAt(new Date("2026-12-31T16:00:00.000Z"))).toBe("2027-01");
  });
});
