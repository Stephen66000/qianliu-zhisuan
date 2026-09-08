import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BillStat, compactBillTokens } from "./BillStat";
describe("账单卡片数字", () => {
  it.each([
    ["99999999", "99,999,999", ""],
    ["100000000", "100,000,000", ""],
    ["2000000000", "2,000,000,000", ""],
    ["20000000000", "20,000,000,000", ""],
    ["90071992547409931234", "90,071,992,547,409,931,234", ""],
  ])("%s 完整展示大整数精度", (value, text, unit) => {
    expect(compactBillTokens(value)).toEqual({ text, unit });
  });
  it("可见文本与准确值一致，零和未知不混淆", () => {
    render(
      <>
        <BillStat label="Token" value="2000000000" tokens />
        <BillStat label="零" value="0" tokens />
        <BillStat label="未知" value={null} tokens />
      </>,
    );
    expect(screen.getByLabelText("2000000000 Token")).toHaveTextContent(
      "2,000,000,000",
    );
    expect(screen.getByLabelText("0 Token")).toHaveTextContent("0");
    expect(screen.getByLabelText("数据缺失")).toHaveTextContent("—");
  });
});
