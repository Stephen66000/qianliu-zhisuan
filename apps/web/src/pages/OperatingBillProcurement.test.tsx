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
// WP4-S4：采购复盘页需要 bill.status 做现行/历史分流（D5／AFR-06），mock 提供最小形状。
let billStatus: "DRAFT" | "CLOSED" = "DRAFT";
vi.mock("../api/operating-bills", () => ({
  useOperatingBill: () => ({
    data: { month: "2026-08", status: billStatus, version: 0, generatedAt: "2026-08-03T00:00:00Z" },
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
  billStatus = "DRAFT";
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
  it("现行月（DRAFT）复盘表退役期初/充值/期末列，保留实付与 API 费用估算（WP4-S4 / AFR-07）", () => {
    show();
    // 断言迁移（WP4-S4 合同 6）：资金轨迹列（期初余额/充值到账/期末余额）按裁定退役；
    // apiSpend 数据源已为同源估算（WP1 合同 §3 S3c），列名改"API 费用估算"；实付保留。
    expect(screen.queryByRole("columnheader", { name: "期初余额" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "充值到账" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "期末余额" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "实付（人民币）" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "API 费用估算" })).toBeInTheDocument();
    const row = screen
      .getAllByText("2026-08")
      .map((el) => el.closest("tr"))
      .find(Boolean)!;
    expect(within(row).getByText("¥15.00")).toBeInTheDocument();
    expect(within(row).queryByText("¥20.00")).not.toBeInTheDocument();
    expect(within(row).queryByText("100%")).not.toBeInTheDocument();
    const planTable = screen.getByRole("heading", { name: "套餐采购与峰值利用率" }).closest("section")!;
    expect(within(planTable).getAllByRole("columnheader")).toHaveLength(5);
    expect(within(planTable).getByText("100%")).toBeInTheDocument();
    expect(within(planTable).getByText("50%")).toBeInTheDocument();
  });
  it("关账历史版本（CLOSED）保留期初/充值/期末旧口径列（WP4-S4 / AFR-06）", () => {
    billStatus = "CLOSED";
    show();
    expect(screen.getByRole("columnheader", { name: "期初余额" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "充值到账" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "期末余额" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "API 消耗" })).toBeInTheDocument();
    const row = screen
      .getAllByText("2026-08")
      .map((el) => el.closest("tr"))
      .find(Boolean)!;
    expect(within(row).getByText("¥20.00")).toBeInTheDocument();
    expect(within(row).getByText("¥15.00")).toBeInTheDocument();
  });
  it("套餐 Token 与峰值比例同表，切换厂商读取对应事实", async () => {
    show("plans");
    expect(
      screen.getByRole("heading", { name: "Kimi 月度 Token" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kimi" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Kimi" })).toHaveClass("!bg-ql-action/15", "!text-ql-fg");
    await userEvent.click(screen.getByRole("button", { name: "智谱" }));
    expect(screen.getByRole("button", { name: "智谱" })).toHaveClass("!bg-ql-action/15", "!text-ql-fg");
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
