import { render, screen } from "@testing-library/react";
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
  });

  it("展示真实成本口径并可切换经营账单页签", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}><OperatingBillPage /></MemoryRouter>);
    expect(screen.getByText("¥312.34")).toBeInTheDocument();
    expect(screen.getByText("仅 API 模式调用成本")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /套餐利用分析/ }));
    expect(screen.getByText("¥150.00")).toBeInTheDocument();
    expect(screen.getByText(/不代表退款/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /结账管理/ }));
    expect(screen.getByText("数据完整性检查通过")).toBeInTheDocument();
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
