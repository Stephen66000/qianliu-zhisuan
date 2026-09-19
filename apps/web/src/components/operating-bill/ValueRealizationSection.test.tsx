import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ValueRealizationSection,
  computePlanValueRow,
  computePlanValueSummary,
} from "./ValueRealizationSection";

describe("ValueRealizationSection 价值体现", () => {
  it("正确渲染四大价值指标卡、账号复用核算表和套餐摊薄表", () => {
    render(<ValueRealizationSection month="2026-09" />);

    // 指标卡标题
    expect(screen.getByText("当月账号等效少购节约")).toBeInTheDocument();
    expect(screen.getByText("账号平均复用倍比")).toBeInTheDocument();
    expect(screen.getByText("Coding Plan 实际摊薄单价")).toBeInTheDocument();
    expect(screen.getByText("Coding Plan 等效采购降本")).toBeInTheDocument();

    // 表格 1 与 表格 2 的行内容
    expect(screen.getByRole("heading", { name: "1. 账号复用核算表" })).toBeInTheDocument();
    expect(screen.getAllByText("Kimi Coding Plan")).toHaveLength(2);
    expect(screen.getAllByText("智谱 Coding Plan")).toHaveLength(2);
    expect(screen.getByText("DeepSeek (API 集中托管)")).toBeInTheDocument();

    // 表格 2
    expect(screen.getByRole("heading", { name: "2. Coding Plan 额度摊薄单价与超值对比" })).toBeInTheDocument();
    expect(screen.getByText("官方同级 API 市价")).toBeInTheDocument();
    expect(screen.getByText("等效折扣率")).toBeInTheDocument();
  });

  it("汇总口径复算：Kimi 162.26M/¥199/¥12 + 智谱 444.49M/¥422.10/¥15 → 0.7 折 / -92.8%", () => {
    const kimi = computePlanValueRow(199.0, 162.26, 12.0);
    const zhipu = computePlanValueRow(422.1, 444.49, 15.0);
    const summary = computePlanValueSummary(kimi, zhipu);

    // 汇总金额与明细行自洽
    expect(summary.totalPlanPrice).toBeCloseTo(621.1, 2);
    expect(summary.totalOfficialCost).toBeCloseTo(1947.12 + 6667.35, 2);
    expect(summary.totalPlanTokensM).toBeCloseTo(606.75, 2);

    // 加权平均官方基准单价 = 总等效 API 成本 ÷ 总 Token（非算术平均 13.50）
    expect(summary.blendedOfficialRate).toBeCloseTo(14.2, 2);

    // 汇总折数与降幅由汇总金额推导
    expect(summary.weightedDiscount.toFixed(1)).toBe("0.7");
    expect((100 - summary.weightedDiscount * 10).toFixed(1)).toBe("92.8");
    // 等价恒等式：折数 = 10 × 总月费 ÷ 总等效 API 成本
    expect(summary.weightedDiscount).toBeCloseTo(
      (10 * summary.totalPlanPrice) / summary.totalOfficialCost,
      10,
    );
  });

  it("数据缺失时显示「数据不足」，不输出兜底的伪造数字", () => {
    render(<ValueRealizationSection month="2026-09" />);
    expect(screen.getAllByText("数据不足").length).toBeGreaterThan(0);
    // 不再出现硬编码兜底 Token（50M / 92.5M 假数据）
    expect(screen.queryByText(/50\.00 M/)).not.toBeInTheDocument();
    expect(screen.queryByText(/92\.50 M/)).not.toBeInTheDocument();
  });
});
