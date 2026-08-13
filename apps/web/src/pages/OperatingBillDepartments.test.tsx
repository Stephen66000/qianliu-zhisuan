import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DepartmentBill } from "../api/v2-types";
import { OperatingBillDepartmentsPage } from "./OperatingBillDepartments";

const useDepartmentBillMock = vi.fn();
const saveMutate = vi.fn();
const checkMutate = vi.fn();

vi.mock("../api/v2-hooks", () => ({
  useDepartmentBill: (month: string) => useDepartmentBillMock(month),
  useSaveDepartmentBudget: () => ({ mutate: saveMutate, isPending: false, error: null }),
  useCheckDepartmentBill: () => ({ mutate: checkMutate, isPending: false, data: undefined }),
}));

function departmentBill(status: "DRAFT" | "CLOSED"): DepartmentBill {
  return {
    month: "2026-08", timezone: "Asia/Shanghai", status, version: status === "CLOSED" ? 1 : 0,
    rows: [
      {
        departmentId: "11111111-1111-4111-8111-111111111111", departmentName: "研发部",
        isUnassigned: false, employeeDirectCost: "3.00000000", projectCost: "2.00000000",
        apiCost: "4.00000000", packageAllocatedCost: "1.00000000", totalCost: "5.00000000",
        inputTokens: "100", outputTokens: "20", actualTokens: "120", requestCount: 2,
        attributionSnapshotMissingCount: 0,
        budget: {
          id: "22222222-2222-4222-8222-222222222222",
          departmentId: "11111111-1111-4111-8111-111111111111", departmentName: "研发部",
          month: "2026-08", currency: "CNY", amount: "10.00000000",
          warningThreshold: "0.80000000", version: 1, updatedAt: "2026-08-13T00:00:00.000Z",
        },
        budgetUsageRate: "0.50000000", budgetStatus: "NORMAL", reasonCodes: [],
      },
      {
        departmentId: null, departmentName: "待归属", isUnassigned: true,
        employeeDirectCost: "1.00000000", projectCost: "0.00000000", apiCost: "1.00000000",
        packageAllocatedCost: "0.00000000", totalCost: "1.00000000", inputTokens: "10",
        outputTokens: "0", actualTokens: "10", requestCount: 1,
        attributionSnapshotMissingCount: 0, budget: null, budgetUsageRate: null,
        budgetStatus: "NOT_SET", reasonCodes: ["DEPARTMENT_UNASSIGNED"],
      },
    ],
    totals: {
      inputTokens: "110", outputTokens: "20", actualTokens: "130", apiCost: "5.00000000",
      packageCost: "1.00000000", totalCost: "6.00000000", requestCount: 3,
    },
    conservation: {
      status: "BALANCED", tokenDifference: "0", apiCostDifference: "0.00000000",
      packageCostDifference: "0.00000000", totalCostDifference: "0.00000000",
    },
    reasonCodes: ["DEPARTMENT_UNASSIGNED"], generatedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("W20-07 部门月账 Web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDepartmentBillMock.mockReturnValue({
      data: departmentBill("DRAFT"), isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it("员工直接、项目、API、套餐与待归属保持分栏，不相加成第二总账", () => {
    render(<MemoryRouter initialEntries={["/operating-bills/2026-08/departments?month=2026-08"]}>
      <OperatingBillDepartmentsPage />
    </MemoryRouter>);
    for (const heading of ["员工直接成本", "项目成本", "API 费用", "套餐分摊"]) {
      expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }
    const assigned = screen.getByText("研发部").closest("tr")!;
    expect(within(assigned).getByText("¥3.00")).toBeInTheDocument();
    expect(within(assigned).getByText("¥2.00")).toBeInTheDocument();
    expect(within(assigned).getByText("¥5.00")).toBeInTheDocument();
    const unassigned = screen.getByText("待归属").closest("tr")!;
    expect(within(unassigned).getByText("DEPARTMENT_UNASSIGNED")).toBeInTheDocument();
    expect(screen.getByText("BALANCED")).toBeInTheDocument();
    expect(screen.getByText("¥6.00")).toBeInTheDocument();
  });

  it("编辑期间账单被关闭后立即只读，不能继续保存", async () => {
    const user = userEvent.setup();
    const rendered = render(<MemoryRouter initialEntries={["/operating-bills/2026-08/departments?month=2026-08"]}>
      <OperatingBillDepartmentsPage />
    </MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "¥10.00 · 正常" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();

    useDepartmentBillMock.mockReturnValue({
      data: departmentBill("CLOSED"), isLoading: false, error: null, refetch: vi.fn(),
    });
    rendered.rerender(<MemoryRouter initialEntries={["/operating-bills/2026-08/departments?month=2026-08"]}>
      <OperatingBillDepartmentsPage />
    </MemoryRouter>);
    expect(screen.getByRole("spinbutton", { name: "研发部预算" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "研发部警戒线" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(saveMutate).not.toHaveBeenCalled();
  });
});
