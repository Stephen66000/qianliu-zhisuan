import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangePasswordPage } from "./ChangePassword";

const changeMock = vi.fn();

vi.mock("../api/admins", () => ({
  useChangeOwnPassword: () => ({ mutate: changeMock, error: null, isPending: false }),
}));

describe("POOL-015 修改管理员密码", () => {
  beforeEach(() => vi.clearAllMocks());

  it("两次新密码不一致时阻止提交", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ChangePasswordPage /></MemoryRouter>);
    await user.type(screen.getByLabelText("当前密码"), "OldPass!2026");
    await user.type(screen.getByLabelText("新密码"), "NewStrong!2026");
    await user.type(screen.getByLabelText("确认新密码"), "Different!2026");
    expect(screen.getByRole("alert")).toHaveTextContent("两次输入的新密码不一致");
    expect(screen.getByRole("button", { name: "确认修改并重新登录" })).toBeDisabled();
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("匹配时提交当前密码和新密码", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ChangePasswordPage /></MemoryRouter>);
    await user.type(screen.getByLabelText("当前密码"), "OldPass!2026");
    await user.type(screen.getByLabelText("新密码"), "NewStrong!2026");
    await user.type(screen.getByLabelText("确认新密码"), "NewStrong!2026");
    await user.click(screen.getByRole("button", { name: "确认修改并重新登录" }));
    expect(changeMock).toHaveBeenCalledWith(
      { current_password: "OldPass!2026", new_password: "NewStrong!2026" },
      expect.any(Object),
    );
  });
});
