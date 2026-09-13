import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FinancialLedgerSection } from "./FinancialLedgerSection";

describe("FinancialLedgerSection 财务账", () => {
  it("正确渲染收支台账、每百万 Token 综合花费列以及导出功能", () => {
    render(<FinancialLedgerSection />);

    // 顶层指标卡
    expect(screen.getByText("年度实付总采购（现金流出）")).toBeInTheDocument();
    expect(screen.getByText("年度用量总花费（实际核算）")).toBeInTheDocument();
    expect(screen.getByText("综合每百万 Token 成本")).toBeInTheDocument();
    expect(screen.getByText("API 账户当前结余")).toBeInTheDocument();

    // 核心表格标题与列
    expect(screen.getByRole("heading", { name: "2026 年度经营收支总台账" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "📥 导出 CSV" })).toBeInTheDocument();

    expect(screen.getByRole("columnheader", { name: "账期月份" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Coding Plan 采购实付" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "本月现金流出合计" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "本月用量总花费" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "每百万 Token 花费" })).toBeInTheDocument();

    // 数据行验证
    expect(screen.getByText("2026-08")).toBeInTheDocument();
    expect(screen.getByText("2026-09")).toBeInTheDocument();
    expect(screen.getByText("年度累计 (8月~9月)")).toBeInTheDocument();
  });
});
