import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingBill } from "../api/operating-bills";
import { OperatingBillPage, parseSnapshotCsv } from "./OperatingBill";

import { analysisFixture } from "../__tests__/operating-analysis-fixture";

const mutate = vi.fn();
const importSnapshots = vi.fn();
const confirmResource = vi.fn();
const closeBill = vi.fn();
const reopenBill = vi.fn();
const createValue = vi.fn();
const confirmValue = vi.fn();
const recordOpeningBalance = vi.fn();
const recordRecharge = vi.fn();
const bill: OperatingBill = {
  month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT", version: 0,
  generatedAt: "2026-08-03T00:00:00Z", closedAt: null, closedBy: null, closeNote: null,
  summary: { totalCost: "312.34", apiCost: "12.34", packageCost: "300", endingBalance: "87.66", endingBalanceCurrency: "CNY", planUtilization: "50", activePrincipalCount: 1, confirmedValueAmount: "0", confirmedNonMonetaryCount: 0, unallocatedCost: "0" },
  providers: [{ providerResourceId: "r1", providerCode: "zhipu", providerName: "智谱", resourceName: "Z Plan", mode: "CODING_PLAN", currency: "CNY", apiCost: "0", packageCost: "300", totalCost: "300", endingBalance: null, totalQuota: "10000", usedQuota: "5000", remainingQuota: "5000", quotaUnit: "TOKEN", utilization: "50", activePrincipalCount: 1, status: "ACTIVE", planAssessment: "UNDERUSED", idleEntitlementCost: "150", assessmentBasis: "按未使用比例折算，不代表退款" }],
  subjects: [{ principalId: "p1", principalName: "员工甲", principalType: "EMPLOYEE", providers: ["智谱"], inputTokens: "100", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0", totalTokens: "120", deductedQuota: "120", apiCost: "12.34", packageAllocatedCost: "300", totalAllocatedCost: "312.34", activeDays: 2, requestCount: 3 }],
  values: [], gaps: [], versions: [], events: [],
};

let currentBill = bill;

vi.mock("../api/operating-analysis", () => ({
  useOperatingAnalysis: () => ({
    data: analysisFixture,
    isLoading: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../api/operating-bill-payments", () => ({
  useOperatingBillPayments: () => ({ data: [], isLoading: false, error: null }),
}));

vi.mock("../api/operating-bills", async () => {
  const actual = await vi.importActual("../api/operating-bills");
  return {
    ...actual,
    useOperatingBill: () => ({ isLoading: false, error: null, data: currentBill, refetch: vi.fn() }),
    useRecordOpeningBalance: () => ({ mutate: recordOpeningBalance, isPending: false, error: null }),
    useRecordResourcePurchase: () => ({ mutate: recordRecharge, isPending: false, error: null }),
    useCreateOperatingBillValue: () => ({ mutate: createValue, isPending: false, error: null }),
    useConfirmOperatingBillValue: () => ({ mutate: confirmValue, isPending: false, error: null }),
    useConfirmOperatingBillResource: () => ({ mutate: confirmResource, isPending: false, error: null }),
    useCloseOperatingBill: () => ({ mutate: closeBill, isPending: false, error: null }),
    useReopenOperatingBill: () => ({ mutate: reopenBill, isPending: false, error: null }),
    useAssignOperatingBillProject: () => ({ mutate, isPending: false, error: null }),
    useImportOperatingBillSnapshots: () => ({ mutateAsync: importSnapshots, isPending: false, error: null }),
  };
});
vi.mock("../api/hooks", () => ({
  usePrincipals: () => ({ data: { principals: [] } }),
  useProviderResources: () => ({ data: { resources: [{
    id: "api-resource",
    operating_snapshot: { id: "snapshot-recharge-100", recharge_amount: "100", currency: "CNY" },
  }] } }),
}));
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
    recordRecharge.mockReset();
  });

  it("展示真实成本口径并可切换经营账单页签", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const totalCard = screen.getAllByText("本月总花费")
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(totalCard).toHaveTextContent("—");
    expect(screen.getAllByText("¥12.34").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥300.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("期初余额 + 本月充值 - 期末余额")).toBeNull();
    await user.click(screen.getByRole("link", { name: /套餐利用率/ }));
    expect(
      screen.getByRole("heading", { name: "Kimi 月度 Token" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /结账管理/ })).toBeNull();
  });

  it("缺期初余额时保留缺口，移除重复计价说明", () => {
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
        packageCost: "621.10",
        apiSpends: [], packageCosts: [{ currency: "CNY", amount: "621.10" }],
        totalSpends: [],
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
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("待补期初余额")).toBeInTheDocument();
    expect(screen.queryByText("账本 API 计价（核对证据） ¥12.34")).toBeNull();
    for (const label of ["期初余额", "本月充值", "期末余额", "API 花费", "套餐费用", "本月总花费"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("¥87.66").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥621.10").length).toBeGreaterThan(0);
    const totalCard = screen.getAllByText("本月总花费")
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(totalCard).toHaveTextContent("—");
    expect(totalCard).not.toHaveTextContent("¥621.10");
    expect(screen.getByRole("link", { name: "厂商资源" })).toHaveAttribute(
      "href",
      "/resources",
    );
  });

  it("POOL20-039/047：CNY、USD 与跨币种时六项保留各自金额和币种", () => {
    currentBill = {
      ...bill,
      summary: {
        ...bill.summary,
        openingBalance: null, monthlyRecharge: null, endingBalance: null,
        apiCost: "25", packageCost: null, totalCost: null,
        endingBalanceCurrency: null,
        openingBalances: [{ currency: "USD", amount: "100" }],
        rechargeAmounts: [{ currency: "CNY", amount: "20" }, { currency: "USD", amount: "5" }],
        endingBalances: [{ currency: "USD", amount: "80" }],
        apiSpends: [{ currency: "USD", amount: "25" }],
        packageCosts: [{ currency: "CNY", amount: "30" }],
        totalSpends: [],
        apiSpendReason: "不可跨币种合计",
      },
      providers: [],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const card = (label: string) => screen.getAllByText(label)
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(card("期初余额")).toHaveTextContent("USD 100.00");
    expect(card("本月充值")).toHaveTextContent("¥20.00 / USD 5.00");
    expect(card("期末余额")).toHaveTextContent("USD 80.00");
    expect(card("API 花费")).toHaveTextContent("USD 25.00");
    expect(card("套餐费用")).toHaveTextContent("¥30.00");
    expect(card("本月总花费")).toHaveTextContent("—");
    expect(card("本月总花费")).not.toHaveTextContent("¥30.00");
    expect(card("期初余额")).not.toHaveTextContent("¥100.00");
  });

  it("旧 CLOSED 无币种数组时按 provider 行分别恢复 API 与套餐币种", () => {
    const plan = { ...bill.providers[0]!, currency: "CNY", packageCostCurrency: undefined };
    const api = {
      ...bill.providers[0]!, providerResourceId: "legacy-api", providerCode: "legacy-api",
      providerName: "Legacy API", resourceName: "Legacy API", mode: "API" as const,
      currency: "USD", apiCost: "12.5", apiSpendCurrency: undefined,
      packageCost: "0", packageCostCurrency: undefined, totalCost: "12.5",
      endingBalance: "80", totalQuota: null, usedQuota: null, remainingQuota: null,
      quotaUnit: null, utilization: null, planAssessment: null,
      idleEntitlementCost: null, assessmentBasis: null,
    };
    currentBill = {
      ...bill, status: "CLOSED",
      summary: {
        ...bill.summary, apiCost: "12.5", packageCost: "300", totalCost: null,
        endingBalanceCurrency: "USD", apiSpends: undefined, packageCosts: undefined,
        totalSpends: undefined, apiSpendReason: "不可跨币种合计",
      },
      providers: [api, plan],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const card = (label: string) => screen.getAllByText(label)
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(card("API 花费")).toHaveTextContent("USD 12.50");
    expect(card("套餐费用")).toHaveTextContent("¥300.00");
    expect(card("本月总花费")).toHaveTextContent("¥300.00 / USD 12.50");
    expect(card("套餐费用")).not.toHaveTextContent("USD 300.00");
  });

  it("旧 plan-only CLOSED 无数组时从套餐 provider 保留 CNY 费用", () => {
    currentBill = {
      ...bill, status: "CLOSED",
      summary: {
        ...bill.summary, apiCost: "0", packageCost: "300", totalCost: "300",
        endingBalanceCurrency: null, apiSpends: undefined, packageCosts: undefined,
        totalSpends: undefined,
      },
      providers: [{ ...bill.providers[0]!, currency: "CNY", packageCostCurrency: undefined }],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const packageCard = screen.getAllByText("套餐费用")
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(packageCard).toHaveTextContent("¥300.00");
  });

  it("月度总览移除充值登记和旧快照 CSV 入口", () => {
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.queryByText("登记本月充值")).toBeNull();
    expect(screen.queryByText("导入账单 CSV")).toBeNull();
    expect(recordRecharge).not.toHaveBeenCalled();
  });

  it("保留旧解析器，对账与导出入口已下线", () => {
    expect(parseSnapshotCsv("provider_resource_id,collected_at,current_balance\nr1,2026-08-18T00:00:00Z,88")).toEqual([{
      provider_resource_id: "r1",
      snapshot: { collected_at: "2026-08-18T00:00:00Z", current_balance: "88" },
    }]);
    expect(() => parseSnapshotCsv("provider_resource_id\nr1")).toThrow("CSV 缺少 provider_resource_id 或 collected_at 表头");
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /对账与导出/ })).toBeNull();
  });

  it("旧结账地址回到月度总览，不能触发结账写入", () => {
    render(
      <MemoryRouter
        initialEntries={["/operating-bill?month=2026-08&tab=closing"]}
      >
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "厂商投入构成" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认结账并冻结" })).toBeNull();
    expect(closeBill).not.toHaveBeenCalled();
    expect(reopenBill).not.toHaveBeenCalled();
  });

  it("资金投影的零套餐费用显示零，缺失费用仍显示缺失", () => {
    currentBill = {
      ...bill,
      summary: { ...bill.summary, packageCost: "0", packageCosts: [] },
      providers: [{ ...bill.providers[0]!, packageCost: "0" }],
    };
    const view = render(
      <MemoryRouter>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const card = () =>
      screen
        .getAllByText("套餐费用")
        .map((el) => el.closest("article"))
        .find(Boolean)!;
    expect(card()).toHaveTextContent("¥0.00");
    currentBill = {
      ...currentBill,
      summary: { ...currentBill.summary, packageCost: null },
      providers: [{ ...bill.providers[0]!, packageCost: null }],
    };
    view.rerender(
      <MemoryRouter>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(card()).toHaveTextContent("—");
    expect(card()).not.toHaveTextContent("¥0.00");
  });

  it("Coding Plan 使用主体展示人数，不再展示套餐 Token 额度", () => {
    render(
      <MemoryRouter>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("columnheader", { name: "使用主体" }),
    ).toBeInTheDocument();
    const row = screen.getByText("Z Plan").closest("tr")!;
    expect(row.children[5]).toHaveTextContent(/^1$/);
    expect(row).not.toHaveTextContent("5000 / 10000");
  });
});

it("monthly overview starts with the selected month's exact total tokens", () => {
  render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
  const card=screen.getByText("本月token使用量").closest("article");
  expect(card).toHaveTextContent("100,000,000");
});
