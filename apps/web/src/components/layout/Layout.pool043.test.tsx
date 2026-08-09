import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSession } from "../../api/types";
import type { ThemeState } from "../../theme/useTheme";
import { AppLayout } from "./AppLayout";
import { Topbar } from "./Topbar";

const mocks = vi.hoisted(() => ({
  isPending: false,
  logout: vi.fn(),
  preference: "system" as "system" | "light" | "dark",
  setPreference: vi.fn(),
}));

vi.mock("../../api/auth", () => ({
  useLogout: () => ({ isPending: mocks.isPending, mutate: mocks.logout }),
}));
vi.mock("../../theme/useTheme", () => ({
  useTheme: () => ({
    preference: mocks.preference,
    resolved: "light",
    setPreference: mocks.setPreference,
  }),
}));

const admin: AdminSession = {
  adminUserId: "admin-1",
  enterpriseId: "enterprise-1",
  username: "admin",
  displayName: "管理员甲",
  mustChangePassword: false,
};

describe("POOL-043 响应式应用布局", () => {
  beforeEach(() => {
    mocks.isPending = false;
    mocks.preference = "system";
    mocks.logout.mockReset();
    mocks.setPreference.mockReset();
  });

  it("移动端使用纵向壳层和横向导航，中尺寸恢复侧边栏", async () => {
    const user = userEvent.setup();
    mocks.logout.mockImplementation((_input, options: { onSettled: () => void }) => {
      options.onSettled();
    });
    const { container } = render(
      <MemoryRouter initialEntries={["/operating-bill/employees"]}>
        <Routes>
          <Route element={<AppLayout admin={admin} />} path="/operating-bill">
            <Route element={<div>employee outlet</div>} path="employees" />
          </Route>
          <Route element={<div>登录目标</div>} path="/login" />
        </Routes>
      </MemoryRouter>,
    );

    expect(container.firstElementChild).toHaveClass("flex-col", "md:flex-row");
    expect(container.querySelector("aside")).toHaveClass("w-full", "md:h-screen", "md:w-64");
    expect(screen.getByRole("navigation", { name: "主导航" })).toHaveClass(
      "overflow-x-auto",
      "md:flex-col",
    );
    expect(screen.getByRole("link", { name: "经营账单" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("employee outlet").closest("main")).toHaveClass(
      "px-4",
      "sm:px-6",
      "md:px-8",
    );
    expect(screen.getByText("管理员甲")).toHaveClass("hidden", "sm:inline");

    await user.click(screen.getByTitle("主题：深色"));
    expect(mocks.setPreference).toHaveBeenCalledWith("dark");
    await user.click(screen.getByRole("button", { name: "退出" }));
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(screen.getByText("登录目标")).toBeInTheDocument();
  });

  it("显示用户名后备值，退出进行中时禁用按钮", () => {
    mocks.isPending = true;
    const theme: ThemeState = {
      preference: "light",
      resolved: "light",
      setPreference: mocks.setPreference,
    };
    render(
      <MemoryRouter>
        <Topbar admin={{ ...admin, displayName: "" }} theme={theme} />
      </MemoryRouter>,
    );

    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出" })).toBeDisabled();
    expect(screen.getByTitle("主题：浅色")).toHaveAttribute("aria-pressed", "true");
  });
});
