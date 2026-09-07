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
describe("不完整计量的经营分析展示", () => {
  it("趋势保留数字并标记不完整，不隐藏已记录量", () => {
    render(<OperatingTrends data={partial()} />);
    expect(screen.getByRole("status")).toHaveTextContent("已记录");
    expect(screen.getByText("公司当月使用 Token").closest("article")).toHaveTextContent("约");
    expect(screen.getByText("公司当月使用 Token").closest("article")).toHaveTextContent("10,000");
    expect(screen.getByText("2026-08").closest("tr")).toHaveTextContent("不完整");
  });
  it("套餐峰值参考值带约数标记，完整月份受不完整峰值影响也标记", () => {
    render(<OperatingPlans data={partial()} />);
    expect(screen.getByRole("status")).toHaveTextContent("已记录");
    expect(screen.getByText("本月历史峰值利用率").closest("article")).toHaveTextContent("约 100%");
    expect(screen.getByText("2026-07").closest("tr")).toHaveTextContent("约 0%");
  });
  it("采购页同步标记利用率参考值，实际付款金额保持原数", () => {
    render(<OperatingProcurement data={partial()} />);
    expect(screen.getByText("约 100%")).toBeInTheDocument();
    expect(screen.getAllByText("¥313.00").length).toBeGreaterThan(0);
  });
});
