import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnterpriseSettingsPanel as SettingsPage } from "../components/settings/EnterpriseSettingsPanel";

const useOperationLogsMock = vi.fn();
const useDeploymentLogsMock = vi.fn();
const useDeploymentLogMock = vi.fn();
const updateSettingsMock = vi.hoisted(() => vi.fn());
const enterpriseSettingsQuery = vi.hoisted(() => ({
  data: { settings: {
    id: "enterprise-1", name: "仟流智算", management_contact: "管理员",
    contact_email: "admin@example.com", timezone: "Asia/Shanghai",
    default_currency: "CNY", version: 3, updated_at: "2026-09-09T00:00:00.000Z",
  } },
  isLoading: false, error: null, refetch: vi.fn(),
}));

vi.mock("../api/hooks", () => ({
  useOperationLogs: () => useOperationLogsMock(),
  useDeploymentLogs: (params: unknown) => useDeploymentLogsMock(params),
  useDeploymentLog: (id: string | null) => useDeploymentLogMock(id),
}));

vi.mock("../api/v2-hooks", () => ({
  useEnterpriseSettings: () => enterpriseSettingsQuery,
  useUpdateEnterpriseSettings: () => ({
    mutate: updateSettingsMock, isPending: false, isSuccess: false, error: null,
  }),
}));

const query = (data: unknown) => ({
  data, isLoading: false, error: null, refetch: vi.fn(),
});

describe("POOL-026 系统升级日志", () => {
  beforeEach(() => {
    useOperationLogsMock.mockReset();
    useDeploymentLogsMock.mockReset();
    useDeploymentLogMock.mockReset();
    updateSettingsMock.mockReset();
    useOperationLogsMock.mockReturnValue(query({ logs: [] }));
    useDeploymentLogsMock.mockReturnValue(query({
      total: 1,
      items: [{
        id: "deployment-1", deployment_id: "release-001",
        started_at: "2026-08-03T01:00:00.000Z", finished_at: "2026-08-03T01:10:00.000Z",
        status: "ROLLED_BACK", from_version: "abc1234", to_version: "def5678",
        git_commit: "def5678", artifact_sha256: "a".repeat(64),
        migration_from: "0034", migration_to: "0035", release_id: "release-001",
        actor: "mac-mini-release", summary: "健康检查失败后回滚", pool_refs: ["POOL-026"],
        backup_ref: "backup-001", rollback_target: "abc1234",
        health_summary: { gateway: "FAIL" }, smoke_summary: { chromium: "SKIPPED" },
        evidence_refs: ["V3/Evidence/POOL-026-20260803.md"],
        failure_classification: "HEALTH_CHECK_FAILED",
      }],
    }));
    useDeploymentLogMock.mockImplementation((id: string | null) => query(id ? {
      deployment: useDeploymentLogsMock().data.items[0],
      events: [
        { id: "e1", event_key: "manifest:IN_PROGRESS", event_type: "IN_PROGRESS", occurred_at: "2026-08-03T01:00:00.000Z", actor: "mac-mini-release", note: "开始", payload: null },
        { id: "e2", event_key: "manifest:ROLLED_BACK", event_type: "ROLLED_BACK", occurred_at: "2026-08-03T01:10:00.000Z", actor: "mac-mini-release", note: "已回滚", payload: null },
      ],
    } : undefined));
  });

  it("默认展示企业信息并保存联系人、邮箱和统计口径", () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "企业信息" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("管理联系人"), { target: { value: "新联系人" } });
    fireEvent.change(screen.getByLabelText("联系邮箱"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存企业信息" }));
    expect(updateSettingsMock).toHaveBeenCalledWith({
      expected_version: 3, name: "仟流智算", management_contact: "新联系人",
      contact_email: "new@example.com", timezone: "Asia/Shanghai", default_currency: "CNY",
    });
    expect(screen.queryByRole("button", { name: /Logo/i })).not.toBeInTheDocument();
  });

  it("取消修改恢复已保存企业资料", () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("管理联系人"), { target: { value: "未保存" } });
    fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
    expect(screen.getByLabelText("管理联系人")).toHaveValue("管理员");
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
