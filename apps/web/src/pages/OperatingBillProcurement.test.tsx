import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingBillPage } from "./OperatingBill";
import { analysisFixture } from "../__tests__/operating-analysis-fixture";
const refresh = vi.fn();
let result: {
  data: typeof analysisFixture | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: typeof refresh;
} = { data: analysisFixture, isLoading: false, error: null, refetch: refresh };
vi.mock("../api/operating-analysis", () => ({
  useOperatingAnalysis: () => result,
}));
vi.mock("../api/operating-bills", () => ({
  useOperatingBill: () => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
function show(tab = "procurement") {
  return render(
    <MemoryRouter initialEntries={[`/operating-bill?month=2026-08&tab=${tab}`]}>
      <OperatingBillPage />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  refresh.mockReset();
  result = {
    data: analysisFixture,
    isLoading: false,
    error: null,
    refetch: refresh,
  };
});
describe("经营分析报表", () => {
  it("年度实付按 12 个月展开，总计使用后端金额", () => {
    show();
    expect(
      screen.getByRole("columnheader", { name: "12 月" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "年度合计" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("¥313.00").length).toBeGreaterThan(0);
  });
  it("同一月内分开到账与实付，合并两家峰值利用率", () => {
    show();
    const row = screen
      .getAllByText("2026-08")
      .map((el) => el.closest("tr"))
      .find(Boolean)!;
    expect(within(row).getByText("¥20.00")).toBeInTheDocument();
    expect(within(row).getByText("¥15.00")).toBeInTheDocument();
    expect(within(row).getByText("100%")).toBeInTheDocument();
    expect(within(row).getByText("50%")).toBeInTheDocument();
  });
  it("套餐 Token 与峰值比例同表，切换厂商读取对应事实", async () => {
    show("plans");
    expect(
      screen.getByRole("heading", { name: "Kimi 月度 Token" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "智谱" }));
    expect(
      screen.getByRole("heading", { name: "智谱 月度 Token" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "历史峰值利用率" }),
    ).toBeInTheDocument();
  });
  it("重新读取失败保留已有报表并明确提示，手动刷新可用", async () => {
    result.error = new Error("暂时无法连接");
    show();
    expect(screen.getByRole("alert")).toHaveTextContent("显示上次读取的数据");
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("首次加载失败不显示假数据", () => {
    result.data = undefined;
    result.error = new Error("接口失败");
    show();
    expect(screen.getByText("接口失败")).toBeInTheDocument();
    expect(screen.queryByText("¥313.00")).toBeNull();
  });
});
