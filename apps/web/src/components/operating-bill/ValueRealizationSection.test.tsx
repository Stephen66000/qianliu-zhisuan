import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ValueRealizationSection } from "./ValueRealizationSection";

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
});
