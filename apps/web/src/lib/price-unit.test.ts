import { describe, expect, it } from "vitest";
import { formatPricePerMillion, toPerMillion, toPerToken } from "./price-unit";

describe("price-unit 单位转换工具", () => {
  describe("toPerMillion (单 Token ➔ 百万 Token)", () => {
    it("正确转换标准单 Token 价格为百万 Token 整数价格", () => {
      expect(toPerMillion("0.000001")).toBe("1");
      expect(toPerMillion("0.000002")).toBe("2");
      expect(toPerMillion("0.000004")).toBe("4");
      expect(toPerMillion("0.000012")).toBe("12");
    });

    it("正确转换带小数的百万 Token 价格", () => {
      expect(toPerMillion("0.0000005")).toBe("0.5");
      expect(toPerMillion("0.0000001")).toBe("0.1");
      expect(toPerMillion("0.0000025")).toBe("2.5");
      expect(toPerMillion("0.00000005")).toBe("0.05");
    });

    it("正确处理 0 和空值", () => {
      expect(toPerMillion("0")).toBe("0");
      expect(toPerMillion("0.000000")).toBe("0");
      expect(toPerMillion("")).toBe("");
      expect(toPerMillion(null)).toBe("");
      expect(toPerMillion(undefined)).toBe("");
    });
  });

  describe("toPerToken (百万 Token ➔ 单 Token)", () => {
    it("正确转换整数百万 Token 价格为单 Token 价格", () => {
      expect(toPerToken("1")).toBe("0.000001");
      expect(toPerToken("2")).toBe("0.000002");
      expect(toPerToken("4")).toBe("0.000004");
      expect(toPerToken("12")).toBe("0.000012");
    });

    it("正确转换小数百万 Token 价格为单 Token 价格", () => {
      expect(toPerToken("0.5")).toBe("0.0000005");
      expect(toPerToken("0.1")).toBe("0.0000001");
      expect(toPerToken("2.5")).toBe("0.0000025");
      expect(toPerToken("0.05")).toBe("0.00000005");
    });

    it("正确处理 0 和空值", () => {
      expect(toPerToken("0")).toBe("0");
      expect(toPerToken("0.00")).toBe("0");
      expect(toPerToken("")).toBe("");
      expect(toPerToken(null)).toBe("");
      expect(toPerToken(undefined)).toBe("");
    });

    it("双向无损互转", () => {
      const cases = ["1", "2", "4", "0.5", "0.1", "12.5", "0.05"];
      for (const val of cases) {
        const perToken = toPerToken(val);
        const back = toPerMillion(perToken);
        expect(back).toBe(val);
      }
    });
  });

  describe("formatPricePerMillion", () => {
    it("格式化显示百万 Token 价格", () => {
      expect(formatPricePerMillion("0.000002", "CNY")).toBe("¥2.00 / 百万 Token");
      expect(formatPricePerMillion("0.0000005", "CNY")).toBe("¥0.50 / 百万 Token");
      expect(formatPricePerMillion("0.000002", "USD")).toBe("$2.00 / 百万 Token");
      expect(formatPricePerMillion("0.000002", "CNY", { showUnit: false })).toBe("¥2.00");
    });

    it("空值与 0 处理", () => {
      expect(formatPricePerMillion(null)).toBe("—");
      expect(formatPricePerMillion("")).toBe("—");
      expect(formatPricePerMillion("0", "CNY")).toBe("¥0.00 / 百万 Token");
    });
  });
});
