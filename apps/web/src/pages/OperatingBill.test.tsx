import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingBill } from "../api/operating-bills";
import { OperatingBillPage, parseSnapshotCsv } from "./OperatingBill";

const mutate = vi.fn();
const importSnapshots = vi.fn();
const confirmResource = vi.fn();
const closeBill = vi.fn();
const reopenBill = vi.fn();
const createValue = vi.fn();
const confirmValue = vi.fn();
const recordOpeningBalance = vi.fn();
const bill: OperatingBill = {
  month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT", version: 0,
  generatedAt: "2026-08-03T00:00:00Z", closedAt: null, closedBy: null, closeNote: null,
  summary: { totalCost: "312.34", apiCost: "12.34", packageCost: "300", endingBalance: "87.66", endingBalanceCurrency: "CNY", planUtilization: "50", activePrincipalCount: 1, confirmedValueAmount: "0", confirmedNonMonetaryCount: 0, unallocatedCost: "0" },
  providers: [{ providerResourceId: "r1", providerCode: "zhipu", providerName: "智谱", resourceName: "Z Plan", mode: "CODING_PLAN", currency: "CNY", apiCost: "0", packageCost: "300", totalCost: "300", endingBalance: null, totalQuota: "10000", usedQuota: "5000", remainingQuota: "5000", quotaUnit: "TOKEN", utilization: "50", activePrincipalCount: 1, status: "ACTIVE", planAssessment: "UNDERUSED", idleEntitlementCost: "150", assessmentBasis: "按未使用比例折算，不代表退款" }],
  subjects: [{ principalId: "p1", principalName: "员工甲", principalType: "EMPLOYEE", providers: ["智谱"], inputTokens: "100", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0", totalTokens: "120", deductedQuota: "120", apiCost: "12.34", packageAllocatedCost: "300", totalAllocatedCost: "312.34", activeDays: 2, requestCount: 3 }],
  values: [], gaps: [], versions: [], events: [],
};

let currentBill = bill;

vi.mock("../api/operating-bills", async () => {
  const actual = await vi.importActual("../api/operating-bills");
  return {
    ...actual,
    useOperatingBill: () => ({ isLoading: false, error: null, data: currentBill, refetch: vi.fn() }),
    useRecordOpeningBalance: () => ({ mutate: recordOpeningBalance, isPending: false, error: null }),
    useCreateOperatingBillValue: () => ({ mutate: createValue, isPending: false, error: null }),
    useConfirmOperatingBillValue: () => ({ mutate: confirmValue, isPending: false, error: null }),
    useConfirmOperatingBillResource: () => ({ mutate: confirmResource, isPending: false, error: null }),
    useCloseOperatingBill: () => ({ mutate: closeBill, isPending: false, error: null }),
    useReopenOperatingBill: () => ({ mutate: reopenBill, isPending: false, error: null }),
    useAssignOperatingBillProject: () => ({ mutate, isPending: false, error: null }),
    useImportOperatingBillSnapshots: () => ({ mutateAsync: importSnapshots, isPending: false, error: null }),
  };
});
vi.mock("../api/hooks", () => ({ usePrincipals: () => ({ data: { principals: [] } }) }));
vi.mock("../api/v2-hooks", () => ({
  useAllPurchases: () => ({ data: { items: [], cashTotals: [] }, isLoading: false, error: null }),
  useProcurementReview: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useSaveProcurementNote: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

describe("POOL-025 经营账单", () => {
  beforeEach(() => {
    currentBill = bill;
    mutate.mockReset();
    importSnapshots.mockReset();
    importSnapshots.mockResolvedValue(undefined);
    confirmResource.mockReset();
    closeBill.mockReset();
    reopenBill.mockReset();
    createValue.mockReset();
    confirmValue.mockReset();
    recordOpeningBalance.mockReset();
  });

  it("展示真实成本口径并可切换经营账单页签", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    expect(screen.getByText("¥312.34")).toBeInTheDocument();
    expect(screen.getByText("期初余额 + 本月充值 - 期末余额")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /套餐利用分析/ }));
    expect(screen.getByText("¥150.00")).toBeInTheDocument();
    expect(screen.getByText(/不代表退款/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /结账管理/ }));
    expect(screen.getByText("数据完整性检查通过")).toBeInTheDocument();
  });

  it.each([
    ["缺开始", null, "2026-08-31"],
    ["缺结束", "2026-08-01", null],
  ])("POOL20-041：套餐%s时经营账单不计算利用不足和闲置金额", (_label, start, end) => {
    currentBill = {
      ...bill,
      summary: { ...bill.summary, planUtilization: null },
      providers: [{
        ...bill.providers[0]!, servicePeriodStart: start, servicePeriodEnd: end,
        utilization: null, planAssessment: null, idleEntitlementCost: null,
        assessmentBasis: null,
      }],
    };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=plans"]}><OperatingBillPage /></MemoryRouter>);
    const row = screen.getByText("Z Plan").closest("tr")!;
    expect(row).toHaveTextContent("数据不足");
    expect(row).not.toHaveTextContent("未用满");
    expect(row).not.toHaveTextContent("¥150.00");
  });

  it("缺期初余额时明确待补，并保留账本 API 计价核对证据", () => {
    currentBill = {
      ...bill,
      summary: {
        ...bill.summary,
        totalCost: null,
        apiCost: null,
        ledgerApiCost: "12.34",
        openingBalance: null,
        monthlyRecharge: "100",
        apiSpendStatus: "OPENING_BALANCE_MISSING",
        apiSpendReason: "待补期初余额",
      },
      providers: [{
        ...bill.providers[0]!,
        providerResourceId: "api-resource",
        providerCode: "deepseek",
        providerName: "DeepSeek",
        resourceName: "API 账户",
        mode: "API",
        apiCost: null,
        ledgerApiCost: "12.34",
        openingBalance: null,
        rechargeAmount: "100",
        apiSpendStatus: "OPENING_BALANCE_MISSING",
        apiSpendReason: "待补期初余额",
        packageCost: "0",
        totalCost: null,
        endingBalance: "87.66",
      }],
    };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    expect(screen.getAllByText("待补期初余额").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("账本 API 计价（核对证据） ¥12.34")).toBeInTheDocument();
    for (const label of ["期初余额", "本月充值", "期末余额", "API 花费", "套餐费用", "本月总花费"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("¥87.66").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "补录期初余额" })).toBeInTheDocument();
  });

  it("POOL20-039/047：CNY、USD 与跨币种时六项保留各自金额和币种", () => {
    currentBill = {
      ...bill,
      summary: {
        ...bill.summary,
        openingBalance: null, monthlyRecharge: null, endingBalance: null,
        apiCost: null, packageCost: null, totalCost: null,
        endingBalanceCurrency: null,
        openingBalances: [{ currency: "USD", amount: "100" }],
        rechargeAmounts: [{ currency: "CNY", amount: "20" }, { currency: "USD", amount: "5" }],
        endingBalances: [{ currency: "USD", amount: "80" }],
        apiSpends: [{ currency: "USD", amount: "25" }],
        packageCosts: [{ currency: "CNY", amount: "30" }],
        totalSpends: [{ currency: "CNY", amount: "30" }, { currency: "USD", amount: "25" }],
        apiSpendReason: "不可跨币种合计",
      },
      providers: [],
    };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    const card = (label: string) => screen.getAllByText(label)
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(card("期初余额")).toHaveTextContent("USD 100.00");
    expect(card("本月充值")).toHaveTextContent("¥20.00 / USD 5.00");
    expect(card("期末余额")).toHaveTextContent("USD 80.00");
    expect(card("API 花费")).toHaveTextContent("USD 25.00");
    expect(card("套餐费用")).toHaveTextContent("¥30.00");
    expect(card("本月总花费")).toHaveTextContent("¥30.00 / USD 25.00");
    expect(card("期初余额")).not.toHaveTextContent("¥100.00");
  });

  it("经营账单内补录期初余额并请求保存后重算", async () => {
    const user = userEvent.setup();
    currentBill = {
      ...bill,
      summary: { ...bill.summary, totalCost: null, apiCost: null, openingBalance: null,
        monthlyRecharge: "0", apiSpendReason: "待补期初余额", endingBalance: "70" },
      providers: [{
        ...bill.providers[0]!, providerResourceId: "api-resource", providerName: "DeepSeek",
        resourceName: "API 账户", mode: "API", currency: "CNY", openingBalance: null,
        rechargeAmount: "0", apiCost: null, apiSpendReason: "待补期初余额",
        packageCost: "0", totalCost: null, endingBalance: "70",
      }],
    };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    await user.type(screen.getByPlaceholderText("期初余额"), "100");
    await user.type(screen.getByRole("textbox", { name: "期初余额说明" }), "财务对账");
    await user.click(screen.getByRole("button", { name: "保存并重算" }));
    expect(recordOpeningBalance).toHaveBeenCalledWith({
      provider_resource_id: "api-resource", amount: "100.00", currency: "CNY", reason: "财务对账",
    }, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("POOL20-046：多 API 资源连续补录时同步剩余资源与币种", async () => {
    const user = userEvent.setup();
    const apiProvider = {
      ...bill.providers[0]!, mode: "API" as const, apiCost: null, openingBalance: null,
      rechargeAmount: "0", apiSpendReason: "待补期初余额", packageCost: "0",
      totalCost: null, endingBalance: "50",
    };
    const first = { ...apiProvider, providerResourceId: "api-cny", resourceName: "人民币 API", currency: "CNY" };
    const second = { ...apiProvider, providerResourceId: "api-usd", resourceName: "美元 API", currency: "USD" };
    currentBill = {
      ...bill,
      summary: { ...bill.summary, openingBalance: null, apiCost: null, totalCost: null },
      providers: [first, second],
    };
    const view = render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    await user.type(screen.getByPlaceholderText("期初余额"), "100");
    await user.click(screen.getByRole("button", { name: "保存并重算" }));
    expect(recordOpeningBalance.mock.calls[0]?.[0]).toMatchObject({
      provider_resource_id: "api-cny", currency: "CNY",
    });
    recordOpeningBalance.mock.calls[0]?.[1].onSuccess();
    currentBill = { ...currentBill, providers: [second] };
    view.rerender(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "期初余额资源" })).toHaveValue("api-usd"));
    expect(screen.getByRole("textbox", { name: "期初余额币种" })).toHaveValue("USD");
    await user.type(screen.getByPlaceholderText("期初余额"), "80");
    await user.click(screen.getByRole("button", { name: "保存并重算" }));
    expect(recordOpeningBalance.mock.calls[1]?.[0]).toMatchObject({
      provider_resource_id: "api-usd", amount: "80.00", currency: "USD",
    });
  });

  it("保留对账 Coming Soon 和草稿账单 CSV 导入入口", async () => {
    const user = userEvent.setup();
    expect(parseSnapshotCsv("provider_resource_id,collected_at,current_balance\nr1,2026-08-18T00:00:00Z,88")).toEqual([{
      provider_resource_id: "r1",
      snapshot: { collected_at: "2026-08-18T00:00:00Z", current_balance: "88" },
    }]);
    expect(() => parseSnapshotCsv("provider_resource_id\nr1")).toThrow("CSV 缺少 provider_resource_id 或 collected_at 表头");
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    await user.click(screen.getByRole("link", { name: /对账与导出/ }));
    expect(screen.getByText("Coming Soon")).toBeInTheDocument();
  });

  it("结账前可确认资源事实并冻结草稿", async () => {
    const user = userEvent.setup();
    currentBill = {
      ...bill,
      providers: [{
        ...bill.providers[0]!,
        providerResourceId: "r1",
        purchases: [{ id: "purchase-1", type: "PACKAGE_PURCHASE", amount: "300", currency: "CNY", purchasedAt: "2026-08-01T00:00:00Z", servicePeriodStart: "2026-08-01", servicePeriodEnd: "2026-08-31", source: "ADMIN" }],
        servicePeriodStart: "2026-08-01",
        servicePeriodEnd: "2026-08-31",
        operatingSnapshotSource: "PROVIDER_SYNC",
        operatingSnapshotVersion: 2,
        operatingSnapshotAt: "2026-08-18T00:00:00Z",
        requestRange: { from: "2026-08-01T00:00:00Z", to: "2026-08-18T00:00:00Z", count: 3 },
        confirmation: { status: "PENDING", note: null, confirmedBy: null, confirmedAt: null, version: 0, matchesCurrentFacts: false },
      }],
    };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=closing"]}><OperatingBillPage /></MemoryRouter>);
    expect(screen.getByText("PROVIDER_SYNC")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: /Z Plan 确认状态/ }), "CONFIRMED");
    await user.click(screen.getByRole("button", { name: "保存确认" }));
    expect(confirmResource).toHaveBeenCalledWith({ status: "CONFIRMED", note: null });
  });

  it("已确认草稿可结账，已结账账期可填写原因重开", async () => {
    const user = userEvent.setup();
    currentBill = {
      ...bill,
      providers: [{ ...bill.providers[0]!, confirmation: { status: "CONFIRMED", note: "已核对", confirmedBy: "管理员", confirmedAt: "2026-08-18T00:00:00Z", version: 1, matchesCurrentFacts: true } }],
      versions: [{ id: "v1", version: 1, closedAt: "2026-08-18T00:00:00Z", closedBy: "管理员", closeNote: "已确认", exceptions: [] }],
      events: [{ id: "e1", action: "CLOSED", version: 1, reason: null, actor: "管理员", createdAt: "2026-08-18T00:00:00Z" }],
    };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=closing"]}><OperatingBillPage /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "确认结账并冻结" }));
    expect(closeBill).toHaveBeenCalledWith({ allow_incomplete: false, note: null });

    currentBill = { ...currentBill, status: "CLOSED", version: 1 };
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=closing"]}><OperatingBillPage /></MemoryRouter>);
    await user.type(screen.getByRole("textbox", { name: "重开原因" }), "需要补录采购凭证");
    await user.click(screen.getByRole("button", { name: "重开账期" }));
    expect(reopenBill).toHaveBeenCalledWith("需要补录采购凭证");
  });
});
