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

  it("登顶第 1 名金句库包含 38 条高光金句，且每条长度不超过 14 字符", () => {
    expect(TOP1_INCENTIVE_QUOTES.length).toBe(38);
    for (const q of TOP1_INCENTIVE_QUOTES) {
      expect(q.length).toBeGreaterThanOrEqual(6);
      expect(q.length).toBeLessThanOrEqual(14);
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

  it("场景一：同一员工在全年 52 周内领取的个人周报金句 100% 绝对无任何重复", () => {
    const quotes = [];
    for (let w = 1; w <= 52; w++) {
      const q = pickPersonalWeeklyQuote("李佳", w);
      quotes.push(q);
      expect(PERSONAL_WEEKLY_QUOTES).toContain(q);
    }
    const uniqueQuotes = new Set(quotes);
    expect(uniqueQuotes.size).toBe(52); // 全年 52 周无任何一条碰撞重复
  });

  it("场景二：同一员工连续多次登顶第 1 名（本周第一、下周又是第一），金句 100% 绝对无任何重复", () => {
    const quotes = [];
    // 连续 38 次登顶测试
    for (let winCount = 0; winCount < 38; winCount++) {
      const q = pickTop1IncentiveQuote("李佳", winCount);
      quotes.push(q);
      expect(TOP1_INCENTIVE_QUOTES).toContain(q);
    }
    const uniqueQuotes = new Set(quotes);
    expect(uniqueQuotes.size).toBe(38); // 轮转完全部 38 条高光金句，0 碰撞
  });

  it("场景二：登顶金句亦支持按自然周输入保证相邻周次不重复", () => {
    const qWeek37 = pickTop1IncentiveQuote("李佳", "2026-W37");
    const qWeek38 = pickTop1IncentiveQuote("李佳", "2026-W38");
    expect(qWeek37).not.toBe(qWeek38);
  });
});
