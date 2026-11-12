import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BillStat, compactBillTokens } from "./BillStat";
describe("账单卡片数字", () => {
  it.each([
    ["99999999", "10,000", "万 Token"],
    ["100000000", "1", "亿 Token"],
    ["2000000000", "20", "亿 Token"],
    ["20000000000", "200", "亿 Token"],
    ["90071992547409931234", "900,719,925,474.1", "亿 Token"],
  ])("%s 以万或亿展示", (value, text, unit) => {
    expect(compactBillTokens(value)).toEqual({ text, unit });
  });
  it("保留准确值的辅助标签，零和未知不混淆", () => {
    render(
      <>
        <BillStat label="Token" value="2000000000" tokens />
        <BillStat label="零" value="0" tokens />
        <BillStat label="未知" value={null} tokens />
      </>,
    );
    expect(screen.getByLabelText("2000000000 Token")).toHaveTextContent(
      /20\s*亿 Token/,
    );
    expect(screen.getByLabelText("0 Token")).toHaveTextContent(/0\s*万 Token/);
    expect(screen.getByLabelText("数据缺失")).toHaveTextContent("—");
  });
});
