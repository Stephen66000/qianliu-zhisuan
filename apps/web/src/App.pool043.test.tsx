import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const flags = vi.hoisted(() => ({ departmentCost: true }));

vi.mock("./components/RequireAuth", async () => {
  const { Outlet } = await vi.importActual("react-router-dom");
  return { RequireAuth: Outlet };
});
vi.mock("./pages/OperatingBillEmployees", () => ({
  OperatingBillEmployeesPage: () => <div>POOL043 员工账路由</div>,
}));
vi.mock("./pages/OperatingBillEmployeeDetail", () => ({
  OperatingBillEmployeeDetailPage: () => <div>POOL043 员工账详情路由</div>,
}));
vi.mock("./pages/OperatingBillProjects", () => ({
  OperatingBillProjectsPage: () => <div>POOL043 项目账路由</div>,
}));
vi.mock("./pages/OperatingBillDepartments", () => ({
  OperatingBillDepartmentsPage: () => <div>W20 部门账路由</div>,
}));
vi.mock("./pages/OperatingBill", () => ({
  OperatingBillPage: () => <div>经营账单总览路由</div>,
}));
vi.mock("./feature-flags", () => ({
  useFeatureFlags: () => ({ FEATURE_DEPARTMENT_COST: flags.departmentCost }),
}));

describe("POOL-043 经营账单独立路由", () => {
  beforeEach(() => {
    flags.departmentCost = true;
    window.history.replaceState({}, "", "/");
  });

  it.each([
    ["/operating-bill/employees", "POOL043 员工账路由"],
    ["/operating-bill/employees/principal-1", "POOL043 员工账详情路由"],
    ["/operating-bill/projects", "POOL043 项目账路由"],
  ])("%s 命中独立页面", (path, expected) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("部门成本开关开启时进入部门账", () => {
    window.history.replaceState({}, "", "/operating-bill/departments");
    render(<App />);
    expect(screen.getByText("W20 部门账路由")).toBeInTheDocument();
  });

  it("部门成本开关关闭时回到经营账单总览", () => {
    flags.departmentCost = false;
    window.history.replaceState({}, "", "/operating-bill/departments");
    render(<App />);
    expect(screen.getByText("经营账单总览路由")).toBeInTheDocument();
  });
});
