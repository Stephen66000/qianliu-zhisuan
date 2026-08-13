import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DepartmentBill } from "../../api/v2-types";
import { DepartmentBudgetPanel } from "./DepartmentBudgetPanel";

const useDepartmentBillMock = vi.fn();
const useSaveDepartmentBudgetMock = vi.fn();
const mutateAsyncMock = vi.fn();

vi.mock("../../api/v2-hooks", () => ({
  useDepartmentBill: (month: string) => useDepartmentBillMock(month),
  useSaveDepartmentBudget: (month: string) => useSaveDepartmentBudgetMock(month),
}));

function bill(status: DepartmentBill["status"] = "DRAFT", rows: DepartmentBill["rows"] = []): DepartmentBill {
  return {
    month: "2026-08", timezone: "Asia/Shanghai", status, version: status === "CLOSED" ? 1 : 0,
    rows,
    totals: {
      inputTokens: "100", outputTokens: "20", actualTokens: "120",
      apiCost: "4.00000000", packageCost: "0.00000000", totalCost: "4.00000000",
      requestCount: 2,
    },
    conservation: {
      status: "BALANCED", tokenDifference: "0", apiCostDifference: "0.00000000",
      packageCostDifference: "0.00000000", totalCostDifference: "0.00000000",
    },
    reasonCodes: [], generatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function departmentRow(overrides: Partial<DepartmentBill["rows"][number]> = {}): DepartmentBill["rows"][number] {
  return {
    departmentId: "11111111-1111-4111-8111-111111111111",
    departmentName: "研发部", isUnassigned: false,
    employeeDirectCost: "3.00000000", projectCost: "1.00000000",
    apiCost: "4.00000000", packageAllocatedCost: "0.00000000", totalCost: "4.00000000",
    inputTokens: "100", outputTokens: "20", actualTokens: "120", requestCount: 2,
    attributionSnapshotMissingCount: 0,
    budget: {
      id: "22222222-2222-4222-8222-222222222222",
      departmentId: "11111111-1111-4111-8111-111111111111",
      departmentName: "研发部", month: "2026-08", currency: "CNY",
      amount: "10.00000000", warningThreshold: "0.80000000", version: 2,
      updatedAt: "2026-08-13T00:00:00.000Z",
    },
    budgetUsageRate: "0.40000000", budgetStatus: "NORMAL", reasonCodes: [],
    ...overrides,
  };
}

function query(data?: DepartmentBill, options?: { loading?: boolean; error?: Error }) {
  return {
    data, isLoading: options?.loading ?? false, error: options?.error ?? null, refetch: vi.fn(),
  };
}

describe("W20-06 部门预算 Web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsyncMock.mockResolvedValue({});
    useSaveDepartmentBudgetMock.mockReturnValue({
      mutateAsync: mutateAsyncMock, isPending: false, error: null,
    });
  });

  it("展示预算、归集成本、真实 Token、使用率、警戒线和状态并带版本保存", async () => {
    useDepartmentBillMock.mockReturnValue(query(bill("DRAFT", [departmentRow()])));
    const user = userEvent.setup();
    render(<DepartmentBudgetPanel />);

    expect(screen.getByText("归集成本")).toBeInTheDocument();
    expect(screen.getByText("实际 Token")).toBeInTheDocument();
    expect(screen.getByText("正常")).toBeInTheDocument();
    expect(screen.getByText("40.0%")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    const amount = screen.getByRole("spinbutton", { name: "研发部月度预算" });
    const threshold = screen.getByRole("spinbutton", { name: "研发部警戒线" });
    await user.clear(amount);
    await user.type(amount, "20");
    await user.clear(threshold);
    await user.type(threshold, "0.7");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        departmentId: "11111111-1111-4111-8111-111111111111",
        amount: "20", currency: "CNY", warning_threshold: "0.7", expected_version: 2,
      });
    });
  });

  it("加载、失败及无部门均有明确状态", async () => {
    useDepartmentBillMock.mockReturnValue(query(undefined, { loading: true }));
    const rendered = render(<DepartmentBudgetPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载数据");

    const retry = vi.fn();
    useDepartmentBillMock.mockReturnValue({
      data: undefined, isLoading: false, error: new Error("部门服务不可用"), refetch: retry,
    });
    rendered.rerender(<DepartmentBudgetPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("部门服务不可用");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();

    useDepartmentBillMock.mockReturnValue(query(bill("DRAFT", [departmentRow({
      departmentId: null, departmentName: "待归属", isUnassigned: true, budget: null,
    })])));
    rendered.rerender(<DepartmentBudgetPanel />);
    expect(screen.getByText("暂无部门")).toBeInTheDocument();
    expect(screen.getByText(/通讯录同步或 Excel 导入/)).toBeInTheDocument();
  });

  it("已结账月份预算输入与保存均禁用", () => {
    useDepartmentBillMock.mockReturnValue(query(bill("CLOSED", [departmentRow()])));
    render(<DepartmentBudgetPanel />);
    expect(screen.getByRole("spinbutton", { name: "研发部月度预算" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "研发部警戒线" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "已结账" })).toBeDisabled();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });
});
