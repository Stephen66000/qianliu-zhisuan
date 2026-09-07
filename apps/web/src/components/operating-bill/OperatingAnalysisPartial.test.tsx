import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { analysisFixture } from "../../__tests__/operating-analysis-fixture";
import { OperatingTrends } from "./OperatingTrends";
import { OperatingPlans } from "./OperatingPlans";
import { OperatingProcurement } from "./OperatingProcurement";

function partial() {
  const data = structuredClone(analysisFixture);
  data.months[7]!.usageIncomplete = true;
  data.plans[0]!.historyIncomplete = true;
  data.plans[0]!.months[7]!.usageIncomplete = true;
  return data;
}
describe("经营报表展示已记录数值", () => {
  it("趋势完整显示已记录数值，不把质量标记变成月份缺失", () => {
    render(<OperatingTrends data={partial()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("公司当月使用 Token").closest("article")).not.toHaveTextContent("约");
    expect(screen.getByText("公司当月使用 Token").closest("article")).toHaveTextContent("100,000,000");
    expect(screen.getByText("2026-08").closest("tr")).not.toHaveTextContent("不完整");
  });
  it("套餐峰值和利用率正常显示，不传播近似标记", () => {
    render(<OperatingPlans data={partial()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("本月历史峰值利用率").closest("article")).toHaveTextContent("100%");
    expect(screen.getByText("2026-07").closest("tr")).toHaveTextContent("0%");
  });
  it("采购页分开付款事实与利用率，均展示计算值", () => {
    render(<OperatingProcurement data={partial()} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getAllByText("¥313.00").length).toBeGreaterThan(0);
  });
});
