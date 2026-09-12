import { describe, expect, it } from "vitest";
import {
  escapeXml,
  formatDateRange,
  formatLatestRequestTime,
  formatModelName,
  formatNumber,
  formatPercentage,
  formatTokenVolume,
} from "../format-utils.js";

describe("Format Utilities for Reporting", () => {
  describe("formatTokenVolume - 统一万/亿计量法则", () => {
    it("小于 1 亿按万换算，保留 1 位小数四舍五入", () => {
      expect(formatTokenVolume(328500)).toBe("32.9 万");
      expect(formatTokenVolume(1280000)).toBe("128.0 万");
      expect(formatTokenVolume(46928)).toBe("4.7 万");
      expect(formatTokenVolume(99999999)).toBe("10000.0 万");
    });

    it("大于等于 1 亿升格为亿单位", () => {
      expect(formatTokenVolume(100000000)).toBe("1.0 亿");
      expect(formatTokenVolume(135000000)).toBe("1.4 亿");
      expect(formatTokenVolume(2500000000)).toBe("25.0 亿");
    });

    it("支持日均后缀 isDailyAvg", () => {
      expect(formatTokenVolume(47000, { isDailyAvg: true })).toBe("4.7 万 /天");
      expect(formatTokenVolume(120000000, { isDailyAvg: true })).toBe("1.2 亿 /天");
    });

    it("支持单词后缀 showTokensWord", () => {
      expect(formatTokenVolume(328500, { showTokensWord: true })).toBe("32.9 万 Tokens");
      expect(formatTokenVolume(100000000, { showTokensWord: true })).toBe("1.0 亿 Tokens");
    });

    it("处理 0 或负数或异常值", () => {
      expect(formatTokenVolume(0)).toBe("0.0 万");
      expect(formatTokenVolume(-100)).toBe("0.0 万");
      expect(formatTokenVolume(NaN)).toBe("0.0 万");
      expect(formatTokenVolume(0, { isDailyAvg: true })).toBe("0.0 万 /天");
    });

    it("支持 bigint 和字符串数字输入", () => {
      expect(formatTokenVolume(500000n)).toBe("50.0 万");
      expect(formatTokenVolume("685000")).toBe("68.5 万");
      expect(formatTokenVolume(150000000n)).toBe("1.5 亿");
    });
  });

  describe("formatPercentage", () => {
    it("正确格式化浮点小数为百分比", () => {
      expect(formatPercentage(0.33333)).toBe("33.3%");
      expect(formatPercentage(0.5)).toBe("50.0%");
      expect(formatPercentage("0.25")).toBe("25.0%");
    });

    it("若已有 % 则原样保留", () => {
      expect(formatPercentage("33.3%")).toBe("33.3%");
    });

    it("处理非正常输入", () => {
      expect(formatPercentage(0)).toBe("0.0%");
      expect(formatPercentage(-1)).toBe("0.0%");
    });
  });

  describe("formatModelName", () => {
    it("正确规范化常用大模型显示代号", () => {
      expect(formatModelName("deepseek-chat")).toBe("DeepSeek V3");
      expect(formatModelName("deepseek-v3")).toBe("DeepSeek V3");
      expect(formatModelName("deepseek-reasoner")).toBe("DeepSeek R1");
      expect(formatModelName("claude-3-5-sonnet-20241022")).toBe("Claude 3.5 Sonnet");
      expect(formatModelName("gpt-4o-mini-2024-07-18")).toBe("GPT-4o mini");
      expect(formatModelName("gpt-4o-2024-08-06")).toBe("GPT-4o");
      expect(formatModelName("glm-5-turbo")).toBe("GLM 5.3");
      expect(formatModelName("glm-4-flash")).toBe("GLM-4");
      expect(formatModelName("qwen-max")).toBe("Qwen Max");
      expect(formatModelName("moonshot-v1-8k")).toBe("Kimi Chat");
    });
  });

  describe("escapeXml", () => {
    it("转义 XML 特殊字符", () => {
      expect(escapeXml('Hello & "World" <1> >0 \'test\'')).toBe(
        "Hello &amp; &quot;World&quot; &lt;1&gt; &gt;0 &apos;test&apos;",
      );
    });
  });

  describe("formatNumber", () => {
    it("以千分位格式化整数", () => {
      expect(formatNumber(10450)).toBe("10,450");
      expect(formatNumber("1620")).toBe("1,620");
      expect(formatNumber(75)).toBe("75");
    });
  });

  describe("formatDateRange", () => {
    it("正确格式化月日区间", () => {
      const from = new Date("2026-09-07T00:00:00+08:00");
      const to = new Date("2026-09-13T23:59:59+08:00");
      expect(formatDateRange(from, to)).toBe("9.7 - 9.13");
    });
  });

  describe("formatLatestRequestTime", () => {
    it("正确转换最晚时间为中国习惯文案", () => {
      // 2026-09-10 23:15 is Thursday (周四)
      const date = new Date("2026-09-10T23:15:00+08:00");
      const result = formatLatestRequestTime(date, "Asia/Shanghai");
      expect(result).toContain("周四");
      expect(result).toContain("23:15");
      expect(result).toContain("深夜");
    });
  });
});
