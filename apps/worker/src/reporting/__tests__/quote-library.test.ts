import { describe, expect, it } from "vitest";
import {
  PERSONAL_WEEKLY_QUOTES,
  TOP1_INCENTIVE_QUOTES,
  pickPersonalWeeklyQuote,
  pickTop1IncentiveQuote,
} from "../quote-library.js";

describe("Quote Library for Reporting & Incentives", () => {
  it("个人周报金句库包含 55 条金句，且每条长度不超过 13 字符", () => {
    expect(PERSONAL_WEEKLY_QUOTES.length).toBe(55);
    for (const q of PERSONAL_WEEKLY_QUOTES) {
      expect(q.length).toBeGreaterThanOrEqual(6);
      expect(q.length).toBeLessThanOrEqual(13);
    }
  });

  it("登顶第 1 名金句库包含 9 条高光金句，且每条长度不超过 13 字符", () => {
    expect(TOP1_INCENTIVE_QUOTES.length).toBe(9);
    for (const q of TOP1_INCENTIVE_QUOTES) {
      expect(q.length).toBeGreaterThanOrEqual(6);
      expect(q.length).toBeLessThanOrEqual(13);
    }
  });

  it("pickPersonalWeeklyQuote 能够依据 Seed 打散分配不同金句", () => {
    const q1 = pickPersonalWeeklyQuote("张三:2026-W37");
    const q2 = pickPersonalWeeklyQuote("李四:2026-W37");
    const q3 = pickPersonalWeeklyQuote("王五:2026-W37");
    const q4 = pickPersonalWeeklyQuote("赵六:2026-W37");

    expect(typeof q1).toBe("string");
    expect(PERSONAL_WEEKLY_QUOTES).toContain(q1);
    expect(PERSONAL_WEEKLY_QUOTES).toContain(q2);

    // 验证不同姓名打散（不全相同）
    const set = new Set([q1, q2, q3, q4]);
    expect(set.size).toBeGreaterThan(1);
  });

  it("pickTop1IncentiveQuote 能够有效分配登顶金句", () => {
    const quote = pickTop1IncentiveQuote("李佳:2026-W37");
    expect(typeof quote).toBe("string");
    expect(TOP1_INCENTIVE_QUOTES).toContain(quote);
  });
});
