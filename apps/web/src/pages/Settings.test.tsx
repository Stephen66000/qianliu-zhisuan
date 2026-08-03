import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./Settings";

const useOperationLogsMock = vi.fn();
const useDeploymentLogsMock = vi.fn();
const useDeploymentLogMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useOperationLogs: () => useOperationLogsMock(),
  useDeploymentLogs: (params: unknown) => useDeploymentLogsMock(params),
  useDeploymentLog: (id: string | null) => useDeploymentLogMock(id),
}));

const query = (data: unknown) => ({
  data, isLoading: false, error: null, refetch: vi.fn(),
});

describe("POOL-026 系统升级日志", () => {
  beforeEach(() => {
    useOperationLogsMock.mockReset();
    useDeploymentLogsMock.mockReset();
    useDeploymentLogMock.mockReset();
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

  it("支持状态、版本和问题编号筛选，并展示回滚详情时间线", () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "升级日志" }));

    fireEvent.change(screen.getByLabelText("升级状态"), { target: { value: "ROLLED_BACK" } });
    fireEvent.change(screen.getByLabelText("版本或 Commit"), { target: { value: "def5678" } });
    fireEvent.change(screen.getByLabelText("问题编号"), { target: { value: "POOL-026" } });
    expect(useDeploymentLogsMock).toHaveBeenLastCalledWith({
      status: "ROLLED_BACK", version: "def5678", poolRef: "POOL-026",
    });

    expect(screen.getAllByText("已回滚").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /abc1234.*def5678/ }));
    expect(screen.getByText("升级详情 · release-001")).toBeInTheDocument();
    expect(screen.getByText("HEALTH_CHECK_FAILED")).toBeInTheDocument();
    expect(screen.getByText(/ROLLED_BACK · 已回滚/)).toBeInTheDocument();
  });
});
