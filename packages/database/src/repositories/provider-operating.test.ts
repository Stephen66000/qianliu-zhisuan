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

  it("每季按三个自然月推进，月末锚点收敛到目标月末", () => {
    const period = calculateQuotaPeriod({
      resetCycle: "QUARTERLY",
      resetAnchorAt: new Date("2026-01-31T00:00:00+08:00"),
      effectiveFrom: null,
      collectedAt: new Date("2026-01-01T00:00:00+08:00"),
      now: new Date("2026-05-01T12:00:00+08:00"),
    });
    expect(period.start.toISOString()).toBe("2026-04-29T16:00:00.000Z");
    expect(period.end?.toISOString()).toBe("2026-07-30T16:00:00.000Z");
  });

  it("每年按十二个自然月推进并正确处理闰日锚点", () => {
    const period = calculateQuotaPeriod({
      resetCycle: "YEARLY",
      resetAnchorAt: new Date("2024-02-29T00:00:00+08:00"),
      effectiveFrom: null,
      collectedAt: new Date("2024-02-29T00:00:00+08:00"),
      now: new Date("2025-03-01T00:00:00+08:00"),
    });
    expect(period.start.toISOString()).toBe("2025-02-27T16:00:00.000Z");
    expect(period.end?.toISOString()).toBe("2026-02-27T16:00:00.000Z");
  });
});
