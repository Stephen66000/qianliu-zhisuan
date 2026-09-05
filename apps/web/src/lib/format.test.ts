import { describe, expect, it } from "vitest";

import { formatDecimal, formatMoney, formatRatePerHour, formatShanghaiDate } from "./format";

describe("POOL-019 金额展示", () => {
  it("固定两位、千分位并以十进制半入舍入", () => {
    expect(formatMoney("109.41000000")).toBe("109.41");
    expect(formatMoney("68.00000000")).toBe("68.00");
    expect(formatMoney("1234567890123456.995")).toBe("1,234,567,890,123,457.00");
  });

  it("无效值原样保留，不伪造为零", () => {
    expect(formatMoney("未知")).toBe("未知");
  });

  it("上海自然日不显示成前一个 UTC 日期", () => {
    expect(formatShanghaiDate("2026-08-18T16:00:00.000Z")).toBe("2026-08-19");
  });

  it("通用小数最多两位、精确舍入并去掉尾零", () => {
    expect(formatDecimal("0.08795916")).toBe("0.09");
    expect(formatDecimal("6397.93248312")).toBe("6,397.93");
    expect(formatDecimal("2413.38532146")).toBe("2,413.39");
    expect(formatDecimal("100.00000000")).toBe("100");
    expect(formatDecimal("-1.235")).toBe("-1.24");
    expect(formatDecimal("9007199254740993.995")).toBe("9,007,199,254,740,994");
    expect(formatDecimal("未知")).toBe("未知");
    expect(formatRatePerHour("0.08795916")).toBe("0.09/h");
  });
});
