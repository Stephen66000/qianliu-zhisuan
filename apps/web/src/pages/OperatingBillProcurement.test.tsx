import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingBill } from "../api/operating-bills";
import type * as OperatingBillsApi from "../api/operating-bills";
import type { ProcurementReview, ResourceUtilization } from "../api/v2-types";
import { DEFAULT_FEATURE_FLAGS, FeatureFlagsProvider } from "../feature-flags";
import { OperatingBillPage } from "./OperatingBill";

const saveNote = vi.fn();
const useAllPurchasesMock = vi.fn();
const useProcurementReviewMock = vi.fn();

const bill: OperatingBill = {
  month: "2026-08",
  timezone: "Asia/Shanghai",
  status: "DRAFT",
  version: 0,
  generatedAt: "2026-08-13T00:00:00.000Z",
  closedAt: null,
  closedBy: null,
  closeNote: null,
  summary: {
    totalCost: "812.50000000",
    apiCost: "12.50000000",
    packageCost: "800.00000000",
    endingBalance: "87.50000000",
    endingBalanceCurrency: "CNY",
    planUtilization: "63.75",
    activePrincipalCount: 1,
    confirmedValueAmount: "0",
    confirmedNonMonetaryCount: 0,
    unallocatedCost: "0",
  },
  providers: [],
  subjects: [],
  values: [],
  gaps: [],
  versions: [],
  events: [],
};

function resource(overrides: Partial<ResourceUtilization>): ResourceUtilization {
  return {
    resourceId: "resource-default",
    providerId: "provider-default",
    providerName: "厂商",
    resourceName: "资源",
    mode: "API",
    resourceStatus: "ACTIVE",
    requestCount: 1,
    realTokens: "1000",
    apiCost: "12.50000000",
    deductedQuota: "0",
    purchaseCashAmount: "120.00000000",
    currency: "CNY",
    budgetAmount: null,
    currentBalance: "87.50000000",
    packageCost: null,
    totalQuota: null,
    usedQuota: null,
    remainingQuota: null,
    quotaUnit: null,
    utilizationRate: null,
    idleEntitlementCost: null,
    rate1h: null,
    rate24h: null,
    rate7d: null,
    forecastExhaustAt: null,
    nextRecoverAt: null,
    coverageHours: null,
    forecastStatus: "NOT_AVAILABLE",
    utilizationStatus: "NOT_CONFIGURED",
    forecastConfidence: null,
    forecastNotCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
    forecastDataAt: null,
    lastSettledRequestAt: "2026-08-11T00:00:00.000Z",
    continuousNoCallDays: 2,
    idleStatus: "UNASSESSED",
    utilizationBasis: null,
    notCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
    dataAt: "2026-08-11T00:00:00.000Z",
    quotaWindows: [],
    ...overrides,
  };
}

const review: ProcurementReview = {
  month: "2026-08",
  resources: [
    {
      ...resource({
        resourceId: "deepseek-api",
        providerName: "DeepSeek",
        resourceName: "API 账户",
      }),
      reviewLabel: "数据不足",
      reviewReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
    },
    {
      ...resource({
        resourceId: "kimi-plan",
        providerName: "Kimi",
        resourceName: "Coding Plan",
        mode: "CODING_PLAN",
        requestCount: 3,
        realTokens: "3000",
        apiCost: "0",
        purchaseCashAmount: "300.00000000",
        packageCost: "300.00000000",
        totalQuota: "100",
        usedQuota: "20",
        remainingQuota: "80",
        quotaUnit: "POINT",
        utilizationRate: "0.2",
        utilizationStatus: "LOW_UTILIZATION",
        forecastNotCalculableReason: "NO_CONSUMPTION_RATE",
        lastSettledRequestAt: "2026-08-08T00:00:00.000Z",
        continuousNoCallDays: 5,
        notCalculableReason: null,
      }),
      reviewLabel: "利用不足",
      reviewReason: "套餐原生额度使用比例",
    },
    {
      ...resource({
        resourceId: "zhipu-plan",
        providerName: "智谱",
        resourceName: "Coding Plan",
        mode: "CODING_PLAN",
        requestCount: 8,
        realTokens: "9000",
        apiCost: "0",
        purchaseCashAmount: "500.00000000",
        packageCost: "500.00000000",
        totalQuota: "100",
        usedQuota: "90",
        remainingQuota: "10",
        quotaUnit: "POINT",
        utilizationRate: "0.9",
        utilizationStatus: "HEALTHY",
        forecastExhaustAt: "2026-08-15T00:00:00.000Z",
        forecastConfidence: "HIGH",
        forecastNotCalculableReason: null,
        forecastDataAt: "2026-08-13T00:00:00.000Z",
        lastSettledRequestAt: "2026-08-13T00:00:00.000Z",
        continuousNoCallDays: 0,
        notCalculableReason: null,
      }),
      reviewLabel: "利用正常",
      reviewReason: "套餐原生额度使用比例",
    },
  ],
  note: {
    text: "上期保持观察",
    version: 3,
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedBy: "资源管理员",
  },
};

vi.mock("../api/operating-bills", async (importOriginal) => {
  const actual = await importOriginal<typeof OperatingBillsApi>();
  return {
    ...actual,
    useOperatingBill: () => ({ isLoading: false, error: null, data: bill, refetch: vi.fn() }),
    useCreateOperatingBillValue: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useConfirmOperatingBillValue: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useCloseOperatingBill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useReopenOperatingBill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useImportOperatingBillSnapshots: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  };
});

vi.mock("../api/v2-hooks", () => ({
  useAllPurchases: (...args: unknown[]) => useAllPurchasesMock(...args),
  useProcurementReview: (...args: unknown[]) => useProcurementReviewMock(...args),
  useSaveProcurementNote: () => ({ mutate: saveNote, isPending: false, error: null }),
}));

describe("W20-09 采购复盘 Web", () => {
  beforeEach(() => {
    saveNote.mockReset();
    useAllPurchasesMock.mockReturnValue({
      data: { items: [], cashTotals: [] }, isLoading: false, error: null,
    });
    useProcurementReviewMock.mockReturnValue({
      data: review, isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it("采购复盘开关关闭时回到总览且不读取采购清单", () => {
    render(
      <FeatureFlagsProvider value={{
        ...DEFAULT_FEATURE_FLAGS,
        FEATURE_DEPARTMENT_COST: false,
        FEATURE_PROCUREMENT_REVIEW: false,
      }}>
        <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=procurement"]}>
          <Routes><Route element={<OperatingBillPage />} path="/operating-bill" /></Routes>
        </MemoryRouter>
      </FeatureFlagsProvider>,
    );
    expect(screen.getByRole("heading", { name: "厂商投入构成" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "本月买了什么" })).not.toBeInTheDocument();
    expect(useAllPurchasesMock).toHaveBeenLastCalledWith("2026-08", [], false);
  });

  it("采购复盘加载态和错误态不伪造结果", () => {
    useProcurementReviewMock.mockReturnValue({
      data: undefined, isLoading: true, error: null, refetch: vi.fn(),
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=procurement"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("正在生成采购复盘…")).toBeInTheDocument();
    unmount();

    useProcurementReviewMock.mockReturnValue({
      data: undefined, isLoading: false, error: new Error("采购事实不可用"), refetch: vi.fn(),
    });
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=procurement"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("采购事实不可用")).toBeInTheDocument();
  });

  it("无资源时明确展示空态和不可计算的套餐平均利用", () => {
    useProcurementReviewMock.mockReturnValue({
      data: { ...review, resources: [], note: { ...review.note, updatedBy: null } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=procurement"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("本月暂无资源事实")).toBeInTheDocument();
    expect(screen.getByText("套餐平均利用").parentElement).toHaveTextContent("—");
    expect(screen.getByText("当前版本 v3")).toBeInTheDocument();
  });

  it("月度总花费、API 花费、套餐费用和采购现金保持分栏", () => {
    useAllPurchasesMock.mockReturnValue({
      data: {
        items: [{
          id: "purchase-1", providerResourceId: "deepseek-api", purchaseType: "API_RECHARGE",
          description: "8 月充值", amount: "1000.00000000", currency: "CNY",
          purchasedAt: "2026-08-10T00:00:00.000Z", evidenceRef: null, createdBy: "经营管理员",
        }],
        cashTotals: [{ currency: "CNY", amount: "1000.00000000" }],
      },
      isLoading: false, error: null,
    });
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("本月总花费").closest("article")).toHaveTextContent("¥812.50");
    const apiMetric = screen.getAllByText("API 花费").find((node) => node.closest("article"));
    expect(apiMetric?.closest("article")).toHaveTextContent("¥12.50");
    const packageMetric = screen.getAllByText("套餐费用").find((node) => node.closest("article"));
    expect(packageMetric?.closest("article")).toHaveTextContent("¥800.00");
    const purchase = screen.getByText("8 月充值").closest("tr")!;
    expect(within(purchase).getByText("¥1,000.00")).toBeInTheDocument();
    expect(within(purchase).getByText("API 充值")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "现金支出" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "API 花费" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "套餐费用" })).toBeInTheDocument();
  });

  it("按资源展示采购、利用率、标签依据与耗尽/无调用事实", () => {
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=procurement"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );

    const api = screen.getByText("DeepSeek · API 账户").closest("tr")!;
    expect(within(api).getByText("¥120.00")).toBeInTheDocument();
    expect(within(api).getByText("¥12.50")).toBeInTheDocument();
    expect(within(api).getByText("数据不足")).toBeInTheDocument();
    expect(within(api).getAllByText("MONTHLY_BUDGET_NOT_CONFIGURED")).toHaveLength(2);
    expect(within(api).getByText(/连续 2 天无调用/)).toBeInTheDocument();

    const kimi = screen.getByText("Kimi · Coding Plan").closest("tr")!;
    expect(within(kimi).getAllByText("¥300.00")).toHaveLength(2);
    expect(within(kimi).getByText("20.0%")).toBeInTheDocument();
    expect(within(kimi).getByText("利用不足")).toBeInTheDocument();
    expect(within(kimi).getByText("套餐原生额度使用比例")).toBeInTheDocument();
    expect(within(kimi).getByText(/连续 5 天无调用/)).toBeInTheDocument();

    const zhipu = screen.getByText("智谱 · Coding Plan").closest("tr")!;
    expect(within(zhipu).getAllByText("¥500.00")).toHaveLength(2);
    expect(within(zhipu).getByText("90.0%")).toBeInTheDocument();
    expect(within(zhipu).getByText("利用正常")).toBeInTheDocument();
    expect(within(zhipu).getByText(/预计耗尽/)).toBeInTheDocument();

    expect(screen.queryByText("人工判断")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动采购|创建采购|下单/ })).not.toBeInTheDocument();
  });

  it("保留冻结的备注文案，保存时携带当前乐观锁版本", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=procurement"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("采购复盘备注（人工填写）")).toBeInTheDocument();
    expect(screen.getByText(/v3 · 资源管理员/)).toBeInTheDocument();
    const note = screen.getByRole("textbox", { name: "采购复盘备注" });
    await user.clear(note);
    await user.type(note, "下期继续观察 Kimi", { initialSelectionStart: 0, initialSelectionEnd: 6 });
    await user.click(screen.getByRole("button", { name: "保存备注" }));
    expect(saveNote).toHaveBeenCalledWith(
      { note: "下期继续观察 Kimi", expected_version: 3 },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
