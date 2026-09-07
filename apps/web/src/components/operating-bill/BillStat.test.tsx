import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BillStat, compactBillTokens } from "./BillStat";
describe("账单卡片数字", () => {
  it.each([
    ["99999999", "99,999,999", ""],
    ["100000000", "10,000", "万"],
    ["2000000000", "200,000", "万"],
    ["20000000000", "2,000,000", "万"],
    ["90071992547409931234", "9,007,199,254,740,993.12", "万"],
  ])("%s 在单位切换时保持大整数精度", (value, text, unit) => {
    expect(compactBillTokens(value)).toEqual({ text, unit });
  });
  it("缩写保留准确值供辅助阅读，零和未知不混淆", () => {
    render(
      <>
        <BillStat label="Token" value="2000000000" tokens />
        <BillStat label="零" value="0" tokens />
        <BillStat label="未知" value={null} tokens />
      </>,
    );
    expect(screen.getByLabelText("2000000000 Token")).toHaveTextContent(
      "200,000万",
    );
    expect(screen.getByLabelText("0 Token")).toHaveTextContent("0");
    expect(screen.getByLabelText("数据缺失")).toHaveTextContent("—");
  });
});
