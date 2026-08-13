import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import {
  operatingBillMonth,
  OperatingBillShell,
} from "./OperatingBillShell";
import { DEFAULT_FEATURE_FLAGS, FeatureFlagsProvider } from "../../feature-flags";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

describe("POOL-043 经营账单壳层", () => {
  it("回退开关隐藏新增部门和采购页签，保留 1.0 页签", () => {
    render(
      <MemoryRouter>
        <FeatureFlagsProvider value={{
          ...DEFAULT_FEATURE_FLAGS,
          FEATURE_DEPARTMENT_COST: false,
          FEATURE_PROCUREMENT_REVIEW: false,
        }}>
          <OperatingBillShell active="overview" month="2026-08">
            <p>总览内容</p>
          </OperatingBillShell>
        </FeatureFlagsProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "部门账" })).toBeNull();
    expect(screen.queryByRole("link", { name: "采购复盘" })).toBeNull();
    expect(screen.getByRole("link", { name: "月度总览" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "员工账" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "项目账" })).toBeInTheDocument();
  });

  it("月份切换删除分页并让员工／项目入口保留厂商", () => {
    render(
      <MemoryRouter initialEntries={["/operating-bill/employees?month=2026-08&page=3&provider_code=deepseek"]}>
        <OperatingBillShell active="employees" month="2026-08" status="DRAFT">
          <p>员工内容</p>
        </OperatingBillShell>
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByText("待结账")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "经营账单页签" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("link", { name: "员工账" })).toHaveAttribute(
      "href",
      "/operating-bill/employees?month=2026-08&provider_code=deepseek",
    );
    expect(screen.getByRole("link", { name: "员工账" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "项目账" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "项目账" })).toHaveAttribute(
      "href",
      "/operating-bill/projects?month=2026-08&provider_code=deepseek",
    );
    expect(screen.getByRole("link", { name: "月度总览" })).toHaveAttribute(
      "href",
      "/operating-bill?month=2026-08",
    );
    expect(screen.getByRole("link", { name: "套餐利用分析" })).toHaveAttribute(
      "href",
      "/operating-bill?month=2026-08&tab=plans",
    );
    expect(screen.getByLabelText("账单月份")).toHaveAttribute("min", "2000-01");
    expect(screen.getByLabelText("账单月份")).toHaveAttribute("max", "2200-12");
    fireEvent.change(screen.getByLabelText("账单月份"), { target: { value: "2026-07" } });
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?month=2026-07&provider_code=deepseek",
    );
  });

  it("区分 CLOSED 版本、无版本和无状态，非法月份回退当前月", () => {
    const first = render(
      <MemoryRouter>
        <OperatingBillShell active="projects" month="2026-08" status="CLOSED" version={2}>
          <p>项目内容</p>
        </OperatingBillShell>
      </MemoryRouter>,
    );
    expect(screen.getByText("已结账 v2")).toBeInTheDocument();
    first.unmount();

    const second = render(
      <MemoryRouter>
        <OperatingBillShell active="overview" month="2026-08" status="CLOSED">
          <p>总览内容</p>
        </OperatingBillShell>
      </MemoryRouter>,
    );
    expect(screen.getByText("已结账")).toBeInTheDocument();
    second.unmount();

    render(
      <MemoryRouter>
        <OperatingBillShell active="value" month="2026-08">
          <p>价值内容</p>
        </OperatingBillShell>
      </MemoryRouter>,
    );
    expect(screen.queryByText("已结账")).toBeNull();
    expect(screen.queryByText("待结账")).toBeNull();
    const currentMonth = operatingBillMonth("not-a-month");
    expect(currentMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(operatingBillMonth("1999-01")).toBe(currentMonth);
    expect(operatingBillMonth("2026-00")).toBe(currentMonth);
    expect(operatingBillMonth("2026-13")).toBe(currentMonth);
    expect(operatingBillMonth("2000-01")).toBe("2000-01");
    expect(operatingBillMonth("2200-12")).toBe("2200-12");
  });
});
