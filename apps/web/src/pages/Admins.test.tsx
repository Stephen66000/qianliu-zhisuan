import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminsPage } from "./Admins";

const createMock = vi.fn();
const statusMock = vi.fn();

vi.mock("../api/auth", () => ({
  useAdminSession: () => ({ data: { admin: { adminUserId: "admin-current" } } }),
}));

vi.mock("../api/admins", () => ({
  useAdmins: () => ({
    data: {
      admins: [
        {
          id: "admin-current",
          enterprise_id: "enterprise-1",
          username: "owner",
          display_name: "当前管理员",
          status: "ACTIVE",
          must_change_password: false,
          version: 1,
          created_at: "2026-08-02T00:00:00.000Z",
          updated_at: "2026-08-02T00:00:00.000Z",
        },
        {
          id: "admin-second",
          enterprise_id: "enterprise-1",
          username: "ops",
          display_name: "运维管理员",
          status: "ACTIVE",
          must_change_password: true,
          version: 1,
          created_at: "2026-08-02T00:00:00.000Z",
          updated_at: "2026-08-02T00:00:00.000Z",
        },
      ],
    },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useCreateAdmin: () => ({ mutate: createMock, error: null, isPending: false }),
  useRenameAdmin: () => ({ mutate: vi.fn(), error: null, isPending: false }),
  useResetAdminPassword: () => ({ mutate: vi.fn(), error: null, isPending: false }),
  useSetAdminStatus: () => ({ mutate: statusMock, error: null, isPending: false }),
}));

describe("POOL-015 管理员管理", () => {
  beforeEach(() => vi.clearAllMocks());

  it("创建管理员后仅在一次性窗口展示初始密码", async () => {
    createMock.mockImplementation((_input, options) => options.onSuccess());
    const user = userEvent.setup();
    render(<MemoryRouter><AdminsPage /></MemoryRouter>);
    await user.type(screen.getByLabelText("管理员用户名"), "new-admin");
    await user.type(screen.getByLabelText("管理员显示名称"), "新管理员");
    await user.type(screen.getByLabelText("管理员初始密码"), "StrongPass!2026");
    await user.click(screen.getByRole("button", { name: "创建管理员" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(
      {
        username: "new-admin",
        display_name: "新管理员",
        password: "StrongPass!2026",
      },
      expect.any(Object),
    ));
    expect(screen.getByText("StrongPass!2026")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除明文" }));
    expect(screen.queryByText("StrongPass!2026")).not.toBeInTheDocument();
  });

  it("当前管理员不能在列表中停用自己", async () => {
    render(<MemoryRouter><AdminsPage /></MemoryRouter>);
    expect(screen.getByText("owner（当前）")).toBeInTheDocument();
    expect(screen.getByText("请使用修改密码")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "停用" })).toHaveLength(1);
  });
});
