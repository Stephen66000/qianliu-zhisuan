import { describe, expect, it } from "vitest";
import { parseQueryIntent } from "../intent-parser.js";

describe("parseQueryIntent", () => {
  const mockNow = new Date("2026-09-11T12:00:00+08:00"); // 星期五

  it("正确识别'我想查今天我用了多少token'", () => {
    const res = parseQueryIntent("我想查今天我用了多少token", mockNow);
    expect(res.isTokenQuery).toBe(true);
    expect(res.period).toBe("TODAY");
    expect(res.scope).toBe("SELF");
    expect(res.periodLabel).toBe("今天");
    expect(res.overviewPeriod).toBe("TODAY");
  });

  it("正确识别'上一周我用了多少token'", () => {
    const res = parseQueryIntent("上一周我用了多少token", mockNow);
    expect(res.isTokenQuery).toBe(true);
    expect(res.period).toBe("LAST_WEEK");
    expect(res.scope).toBe("SELF");
    expect(res.periodLabel).toBe("上一周");
    expect(res.overviewPeriod).toBe("WEEK");
  });

  it("正确识别'昨天消耗'", () => {
    const res = parseQueryIntent("昨天消耗", mockNow);
    expect(res.isTokenQuery).toBe(true);
    expect(res.period).toBe("YESTERDAY");
    expect(res.periodLabel).toBe("昨天");
  });

  it("正确识别'本周用量'", () => {
    const res = parseQueryIntent("本周用量", mockNow);
    expect(res.isTokenQuery).toBe(true);
    expect(res.period).toBe("WEEK");
    expect(res.periodLabel).toBe("本周");
  });

  it("正确识别'本月消耗了多少'", () => {
    const res = parseQueryIntent("本月消耗了多少", mockNow);
    expect(res.isTokenQuery).toBe(true);
    expect(res.period).toBe("MONTH");
    expect(res.periodLabel).toBe("本月");
  });

  it("正确识别'上个月用量'", () => {
    const res = parseQueryIntent("上个月用量", mockNow);
    expect(res.isTokenQuery).toBe(true);
    expect(res.period).toBe("LAST_MONTH");
    expect(res.periodLabel).toBe("上个月");
  });

  it("正确识别全员/团队范围修饰", () => {
    const res1 = parseQueryIntent("团队今天用了多少token", mockNow);
    expect(res1.isTokenQuery).toBe(true);
    expect(res1.scope).toBe("TEAM");

    const res2 = parseQueryIntent("查一下全公司本周用量", mockNow);
    expect(res2.isTokenQuery).toBe(true);
    expect(res2.scope).toBe("TEAM");
    expect(res2.period).toBe("WEEK");
  });

  it("对于问候或非用量消息识别为 isTokenQuery=false", () => {
    const res = parseQueryIntent("你好呀，请问在吗？", mockNow);
    expect(res.isTokenQuery).toBe(false);
  });
});
