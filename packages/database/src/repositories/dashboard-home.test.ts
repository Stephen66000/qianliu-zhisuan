import { describe, expect, it } from "vitest";

import { previousShanghaiMonthWindow } from "./dashboard-home-metrics.js";

/** UTC 时刻 → 北京时刻字符串校验（窗口边界一律按北京时间自然月界）。 */
function beijing(value: Date): string {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString()
    .replace(".000Z", "+08:00")
    .replace("Z", "+08:00");
}

describe("previousShanghaiMonthWindow（标准版首页同期窗口）", () => {
  it("月中：上月同一日同一时刻，半开区间", () => {
    const window = previousShanghaiMonthWindow(new Date("2026-09-10T06:30:15.500Z"));
    expect(beijing(window.start)).toBe("2026-08-01T00:00:00+08:00");
    expect(beijing(window.end)).toBe("2026-08-10T14:30:15.500+08:00");
    expect(window.truncated).toBe(false);
  });

  it("月初当日：上月同期为极短窗口，仍为半开区间", () => {
    const window = previousShanghaiMonthWindow(new Date("2026-09-01T00:10:00.000Z"));
    expect(beijing(window.start)).toBe("2026-08-01T00:00:00+08:00");
    expect(beijing(window.end)).toBe("2026-08-01T08:10:00+08:00");
    expect(window.truncated).toBe(false);
  });

  it("大月无对应日（3 月 30 日 → 2 月只有 28 天）：截止上月月末（排他边界）并标记截断", () => {
    const window = previousShanghaiMonthWindow(new Date("2026-03-30T06:00:00.000Z"));
    expect(beijing(window.start)).toBe("2026-02-01T00:00:00+08:00");
    expect(beijing(window.end)).toBe("2026-03-01T00:00:00+08:00");
    expect(window.truncated).toBe(true);
  });

  it("闰年 2 月 29 日存在：3 月 30 日仍截断，3 月 29 日不截断", () => {
    expect(previousShanghaiMonthWindow(new Date("2024-03-30T06:00:00.000Z")).truncated).toBe(true);
    const notTruncated = previousShanghaiMonthWindow(new Date("2024-03-29T06:00:00.000Z"));
    expect(beijing(notTruncated.end)).toBe("2024-02-29T14:00:00+08:00");
    expect(notTruncated.truncated).toBe(false);
  });

  it("31 日对 31 日（1 月 31 日 → 12 月 31 日）：不截断", () => {
    const window = previousShanghaiMonthWindow(new Date("2026-01-31T04:00:00.000Z"));
    expect(beijing(window.start)).toBe("2025-12-01T00:00:00+08:00");
    expect(beijing(window.end)).toBe("2025-12-31T12:00:00+08:00");
    expect(window.truncated).toBe(false);
  });

  it("跨年（1 月 → 上年 12 月）：窗口落在上年", () => {
    const window = previousShanghaiMonthWindow(new Date("2026-01-15T04:00:00.000Z"));
    expect(beijing(window.start)).toBe("2025-12-01T00:00:00+08:00");
    expect(beijing(window.end)).toBe("2025-12-15T12:00:00+08:00");
    expect(window.truncated).toBe(false);
  });
});
