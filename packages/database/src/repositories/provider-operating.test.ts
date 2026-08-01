import { describe, expect, it } from "vitest";

import { calculateQuotaPeriod } from "./provider-operating.js";

describe("厂商套餐重置周期", () => {
  it("每月按上海时区锚点生成当前周期和下一重置", () => {
    const period = calculateQuotaPeriod({
      resetCycle: "MONTHLY",
      resetAnchorAt: new Date("2026-01-31T00:00:00+08:00"),
      effectiveFrom: null,
      collectedAt: new Date("2026-01-01T00:00:00+08:00"),
      now: new Date("2026-03-01T12:00:00+08:00"),
    });
    expect(period.start.toISOString()).toBe("2026-02-27T16:00:00.000Z");
    expect(period.end?.toISOString()).toBe("2026-03-30T16:00:00.000Z");
  });

  it("不重置时从套餐生效时间累计且无下一重置", () => {
    const effectiveFrom = new Date("2026-07-01T00:00:00+08:00");
    const period = calculateQuotaPeriod({
      resetCycle: "NONE",
      resetAnchorAt: null,
      effectiveFrom,
      collectedAt: new Date("2026-07-10T00:00:00+08:00"),
      now: new Date("2026-07-31T00:00:00+08:00"),
    });
    expect(period).toEqual({ start: effectiveFrom, end: null });
  });
});
