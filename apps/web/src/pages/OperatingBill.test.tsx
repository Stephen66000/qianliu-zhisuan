import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { OperatingBill } from "../api/operating-bills";
import { OperatingBillPage } from "./OperatingBill";

const mutate = vi.fn();
const bill: OperatingBill = {
  month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT", version: 0,
  generatedAt: "2026-08-03T00:00:00Z", closedAt: null, closedBy: null, closeNote: null,
  summary: { totalCost: "312.34", apiCost: "12.34", packageCost: "300", endingBalance: "87.66", endingBalanceCurrency: "CNY", planUtilization: "50", activePrincipalCount: 1, confirmedValueAmount: "0", confirmedNonMonetaryCount: 0, unallocatedCost: "0" },
  providers: [{ providerResourceId: "r1", providerCode: "zhipu", providerName: "智谱", resourceName: "Z Plan", mode: "CODING_PLAN", currency: "CNY", apiCost: "0", packageCost: "300", totalCost: "300", endingBalance: null, totalQuota: "10000", usedQuota: "5000", remainingQuota: "5000", quotaUnit: "TOKEN", utilization: "50", activePrincipalCount: 1, status: "ACTIVE", planAssessment: "UNDERUSED", idleEntitlementCost: "150", assessmentBasis: "按未使用比例折算，不代表退款" }],
  subjects: [{ principalId: "p1", principalName: "员工甲", principalType: "EMPLOYEE", providers: ["智谱"], inputTokens: "100", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0", totalTokens: "120", deductedQuota: "120", apiCost: "12.34", packageAllocatedCost: "300", totalAllocatedCost: "312.34", activeDays: 2, requestCount: 3 }],
  values: [], gaps: [], versions: [], events: [],
};

vi.mock("../api/operating-bills", async () => {
  const actual = await vi.importActual("../api/operating-bills");
  return {
    ...actual,
    useOperatingBill: () => ({ isLoading: false, error: null, data: bill, refetch: vi.fn() }),
    useCreateOperatingBillValue: () => ({ mutate, isPending: false, error: null }),
    useConfirmOperatingBillValue: () => ({ mutate, isPending: false, error: null }),
    useConfirmOperatingBillResource: () => ({ mutate, isPending: false, error: null }),
    useCloseOperatingBill: () => ({ mutate, isPending: false, error: null }),
    useReopenOperatingBill: () => ({ mutate, isPending: false, error: null }),
    useAssignOperatingBillProject: () => ({ mutate, isPending: false, error: null }),
    useImportOperatingBillSnapshots: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  };
});
vi.mock("../api/hooks", () => ({ usePrincipals: () => ({ data: { principals: [] } }) }));
vi.mock("../api/v2-hooks", () => ({
  useAllPurchases: () => ({ data: { items: [], cashTotals: [] }, isLoading: false, error: null }),
  useProcurementReview: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useSaveProcurementNote: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

describe("POOL-025 经营账单", () => {
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
});
