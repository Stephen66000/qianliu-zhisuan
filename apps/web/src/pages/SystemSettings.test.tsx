import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import { AccessContext } from "../permissions";
import { SystemSettingsPage } from "./SystemSettings";
const mock = vi.hoisted(() => ({ saveRole: vi.fn(), saveSecurity: vi.fn(), audit: vi.fn() }));
vi.mock("../api/settings", () => ({
  useRole: () => ({ data: { role: null } }),
  useSaveRole: () => ({ mutate: mock.saveRole }),
  useSecuritySettings: () => ({ data: { password_policy: "12～128 位，大小写字母、数字与特殊字符", settings: { session_minutes: 480, login_max_failures: 5, login_lock_minutes: 5, force_initial_password_change: true, security_version: 1 } } }),
  useSaveSecurity: () => ({ mutate: mock.saveSecurity }),
  useSessions: () => ({ data: { sessions: [], current_session_id: "self" } }),
  useRevokeSession: () => ({ mutate: vi.fn() }),
  useAudit: (p: URLSearchParams) => { mock.audit(p.toString()); return { data: { logs: [], total: 0, actors: [], timezone: "Asia/Shanghai" } }; },
  useVersion: () => ({ data: { product: "仟流智算", version: null, releases: [{ id: "r", from_version: "old", to_version: "new", status: "SUCCEEDED", started_at: "2026-09-09T00:00:00Z", summary: "企业信息与权限设置" }] } }),
}));
function show(url: string) { return render(<MemoryRouter initialEntries={[url]}><AccessContext.Provider value={{ roleCode: "SUPER_ADMIN" }}><SystemSettingsPage/></AccessContext.Provider></MemoryRouter>); }
describe("已确认系统设置第二版", () => {
  it("岗位命名后勾选查看与操作，并保存名称和权限", () => {
    show("/settings?tab=accounts&section=roles");
    fireEvent.change(screen.getByLabelText("岗位名称"), { target: { value: "研发查看岗" } });
    const view = screen.getByLabelText("使用主体可查看"), operate = screen.getByLabelText("使用主体可操作");
    expect(operate).toBeDisabled(); fireEvent.click(view); expect(operate).not.toBeDisabled(); fireEvent.click(operate);
    fireEvent.click(view); expect(operate).not.toBeChecked(); expect(operate).toBeDisabled(); fireEvent.click(view);
    fireEvent.click(screen.getByRole("button", { name: "保存角色与权限" }));
    expect(mock.saveRole).toHaveBeenCalledWith({ name: "研发查看岗", expected_version: 0, permissions: { principals: { view: true, operate: false } } });
  });
  it("登录安全保存真实数值", () => {
    show("/settings?tab=accounts&section=security");
    fireEvent.change(screen.getByLabelText("登录失败次数"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存登录策略" }));
    expect(mock.saveSecurity).toHaveBeenCalledWith(expect.objectContaining({ login_max_failures: 3, expected_version: 1 }));
  });
  it("审计日历向服务端传递相同日期或区间", () => {
    show("/settings?tab=audit");
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-09-08" } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-09-08" } });
    expect(mock.audit).toHaveBeenLastCalledWith(expect.stringContaining("from=2026-09-08&to=2026-09-08"));
  });
  it("关于版本无详情入口，不伪造构建版本", () => {
    show("/settings?tab=version");
    expect(screen.getByRole("heading", { name: "关于版本" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "详情" })).not.toBeInTheDocument();
    expect(screen.getByText("当前构建未提供版本标识")).toBeInTheDocument();
    expect(screen.queryByText("关于与版本")).not.toBeInTheDocument();
  });
});
