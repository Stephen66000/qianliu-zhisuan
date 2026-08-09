import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

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

describe("POOL-043 经营账单独立路由", () => {
  beforeEach(() => {
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
});
