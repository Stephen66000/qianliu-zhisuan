import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperatingBill } from "../api/operating-bills";
import { OperatingBillPage } from "./OperatingBill";

const bill: OperatingBill = {
  month: "2026-08",
  timezone: "Asia/Shanghai",
  status: "DRAFT",
  version: 0,
  generatedAt: "2026-08-09T00:00:00Z",
  closedAt: null,
  closedBy: null,
  closeNote: null,
  summary: {
    totalCost: "0",
    apiCost: "0",
    packageCost: "0",
    endingBalance: null,
    endingBalanceCurrency: null,
    planUtilization: null,
    activePrincipalCount: 0,
    confirmedValueAmount: "0",
    confirmedNonMonetaryCount: 0,
    unallocatedCost: "0",
  },
  providers: [],
  subjects: [],
  values: [{
    id: "value-1",
    title: "已提交价值",
    value_type: "MONETARY",
    amount: "8.00",
    metric_value: null,
    metric_unit: null,
    description: null,
    evidence_ref: "evidence-1",
    related_principal_name: null,
    status: "PENDING",
    submitted_by_name: "管理员甲",
    confirmed_by_name: null,
  }],
  gaps: [],
  versions: [],
  events: [],
};

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../api/operating-bills", () => ({
  useCloseOperatingBill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useConfirmOperatingBillValue: () => ({ mutate: mocks.confirm, isPending: false, error: null }),
  useCreateOperatingBillValue: () => ({ mutate: mocks.create, isPending: false, error: null }),
  useImportOperatingBillSnapshots: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useOperatingBill: () => ({ isLoading: false, error: null, data: bill, refetch: vi.fn() }),
  useReopenOperatingBill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("../api/v2-hooks", () => ({
  useAllPurchases: () => ({ data: { items: [], cashTotals: [] }, isLoading: false, error: null }),
  useProcurementReview: vi.fn(),
  useSaveProcurementNote: vi.fn(),
}));

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}`}</output>;
}

describe("POOL-043 旧主体页分流", () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.create.mockReset();
    mocks.create.mockImplementation((_body, options: { onSuccess: () => void }) => {
      options.onSuccess();
    });
  });

  it("旧 subjects 入口保留月份并替换到独立员工账", () => {
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=subjects"]}>
        <Routes>
          <Route element={<OperatingBillPage />} path="/operating-bill" />
          <Route element={<><div>独立员工账</div><LocationProbe /></>} path="/operating-bill/employees" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("独立员工账")).toBeInTheDocument();
    expect(screen.getByText("/operating-bill/employees?month=2026-08")).toBeInTheDocument();
  });

  it("显式 overview 页签仍命中月度总览", () => {
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=overview"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "月度总览" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "厂商投入构成" })).toBeInTheDocument();
  });

  it("保留非主体页签的原有独立内容", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08&tab=value"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "新增价值事项" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "价值确认" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const save = screen.getByRole("button", { name: "保存待确认" });
    await user.click(save);
    expect(mocks.create).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("价值事项"), "节省成本");
    await user.type(screen.getByPlaceholderText("金额"), "1.234");
    await user.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent("最多保留两位小数");
    await user.clear(screen.getByPlaceholderText("金额"));
    await user.type(screen.getByPlaceholderText("金额"), "12.34");
    await user.type(screen.getByPlaceholderText("证据引用"), "invoice-1");
    await user.click(save);
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "节省成本",
        value_type: "MONETARY",
        amount: "12.34",
        metric_value: null,
        evidence_ref: "invoice-1",
      }),
      expect.any(Object),
    );

    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(mocks.confirm).toHaveBeenCalledWith("value-1");

    await user.selectOptions(screen.getByRole("combobox"), "NON_MONETARY");
    await user.type(screen.getByPlaceholderText("价值事项"), "产出文档");
    await user.type(screen.getByPlaceholderText("指标值"), "3 份");
    await user.click(save);
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "产出文档",
        value_type: "NON_MONETARY",
        amount: null,
        metric_value: "3 份",
      }),
      expect.any(Object),
    );
  });
});
