import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperatingBill } from "../api/operating-bills";
import { OperatingBillPage } from "./OperatingBill";

import { analysisFixture } from "../__tests__/operating-analysis-fixture";

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

vi.mock("../api/operating-bills", () => ({
  useCloseOperatingBill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useConfirmOperatingBillValue: () => ({ mutate: mocks.confirm, isPending: false, error: null }),
  useCreateOperatingBillValue: () => ({ mutate: mocks.create, isPending: false, error: null }),
  useImportOperatingBillSnapshots: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useOperatingBill: () => ({ isLoading: false, error: null, data: bill, refetch: vi.fn() }),
  useRecordOpeningBalance: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRecordResourcePurchase: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useReopenOperatingBill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("../api/v2-hooks", () => ({
  useAllPurchases: () => ({ data: { items: [], cashTotals: [] }, isLoading: false, error: null }),
  useProcurementReview: vi.fn(),
  useSaveProcurementNote: vi.fn(),
}));

vi.mock("../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviders: () => ({ data: { providers: [] } }),
  useProviderResources: () => ({ data: { resources: [] } }),
}));

vi.mock("../api/provider-finance", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviderSubscriptionPeriods: () => ({ data: { periods: [] } }),
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
      <MemoryRouter
        initialEntries={["/operating-bill?month=2026-08&tab=subjects"]}
      >
        <Routes>
          <Route element={<OperatingBillPage />} path="/operating-bill" />
          <Route
            element={
              <>
                <div>独立员工账</div>
                <LocationProbe />
              </>
            }
            path="/operating-bill/employees"
          />
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

  it("价值确认留空，不展示或写入已有价值事项", () => {
    render(
      <MemoryRouter
        initialEntries={["/operating-bill?month=2026-08&tab=value"]}
      >
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "价值体现" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("region", { name: "价值体现" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("已提交价值")).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
