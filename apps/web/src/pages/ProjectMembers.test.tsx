import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectMembersPage } from "./ProjectMembers";

/** 页面态与各 mutation 的可观测句柄（vi.mock 工厂内只读）。 */
const m = vi.hoisted(() => ({
  createMutate: vi.fn(),
  reviseMutate: vi.fn(),
  previewMutate: vi.fn(),
  publishMutate: vi.fn(),
  lifecycleMutate: vi.fn(),
  refetch: vi.fn(),
  state: {
    loading: false,
    error: null as Error | null,
    noData: false,
    emptyRows: false,
    accountingVersion: 7 as number | null,
    preview: null as null | {
      currentVersion: number;
      conflicts: Array<{ kind: string; message: string; totalBps?: number | null }>;
      hidden: { hiddenProjectCount: number; hiddenWeightBps: number; availableBps: number; remainingBps: number };
      segments: Array<{ weightBps: number; availableBps: number; remainingBps: number }>;
    },
  },
}));

vi.mock("../api/project-allocation", () => ({
  useProjectMemberships: () => ({
    data: m.state.loading || m.state.noData ? undefined : {
      rows: m.state.emptyRows ? [] : [
        {
          membershipId: "m-1", employeePrincipalId: "emp-1", employeeName: "张三",
          stintIndex: 1, revision: 3, status: "ACTIVE",
          joinedAt: "2026-08-01T00:00:00+08:00", leftAt: null,
          currentWeightBps: 5000, weightInterval: { from: "2026-08-01", until: null },
          otherProjectsCount: 2, otherProjectsWeightBps: 3000,
        },
        {
          membershipId: "m-2", employeePrincipalId: "emp-2", employeeName: "李四",
          stintIndex: 1, revision: 1, status: "ENDED",
          joinedAt: "2026-07-01T00:00:00+08:00", leftAt: "2026-07-31T00:00:00+08:00",
          currentWeightBps: null, weightInterval: null,
          otherProjectsCount: 0, otherProjectsWeightBps: 0,
        },
      ],
      counts: { currentMembers: 1, atMembers: 2, periodMembers: 2 },
      total: 2, limit: 100, offset: 0,
      accountingProfile: m.state.accountingVersion === null
        ? null
        : { version: m.state.accountingVersion, startedAt: "2026-08-01T00:00:00+08:00", endedAt: null },
    },
    isLoading: m.state.loading,
    isError: m.state.error !== null,
    error: m.state.error,
    refetch: m.refetch,
  }),
  useEmployeesForMembership: () => ({
    data: { principals: [{ id: "emp-1", name: "张三" }, { id: "emp-2", name: "李四" }] },
    isLoading: false, error: null,
  }),
  useCreateProjectMembership: () => ({ mutate: m.createMutate, isPending: false }),
  useReviseProjectMembership: () => ({ mutate: m.reviseMutate, isPending: false }),
  usePreviewPolicyIntent: () => ({
    mutate: m.previewMutate, isPending: false,
    data: m.state.preview ?? undefined, reset: vi.fn(),
  }),
  usePublishPolicyIntent: () => ({ mutate: m.publishMutate, isPending: false }),
  useReviseAccountingLifecycle: () => ({ mutate: m.lifecycleMutate, isPending: false }),
}));

vi.mock("../api/hooks", () => ({
  usePrincipals: () => ({
    data: { principals: [{ id: "proj-1", name: "千流平台项目" }] },
    isLoading: false, error: null,
  }),
}));

function showPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/proj-1"]}>
      <Routes>
        <Route element={<ProjectMembersPage />} path="/projects/:projectId" />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of [m.createMutate, m.reviseMutate, m.previewMutate, m.publishMutate, m.lifecycleMutate, m.refetch]) {
    fn.mockReset();
  }
  m.state.loading = false;
  m.state.error = null;
  m.state.noData = false;
  m.state.emptyRows = false;
  m.state.accountingVersion = 7;
  m.state.preview = null;
});

describe("项目成员与归集页面", () => {
  it("成员行渲染状态、权重与参与区间，空表显示占位", () => {
    showPage();
    expect(screen.getByRole("heading", { name: "成员与归集" })).toBeInTheDocument();
    expect(screen.getByText("千流平台项目")).toBeInTheDocument();
    expect(screen.getByText("当前成员 1 人；填写权重即同时发布该项目权重段。")).toBeInTheDocument();
    const activeRow = screen.getByRole("row", { name: /张三/ });
    expect(activeRow).toHaveTextContent("参与中");
    expect(activeRow).toHaveTextContent("50.00%");
    expect(activeRow).toHaveTextContent("2 个项目 / 30.00%");
    expect(activeRow).toHaveTextContent("2026/8/1");
    expect(activeRow).toHaveTextContent("开放");
    const endedRow = screen.getByRole("row", { name: /李四/ });
    expect(endedRow).toHaveTextContent("已结束");
    expect(endedRow).toHaveTextContent("—");
    expect(screen.getAllByRole("button", { name: "记录退出" })[1]!).toBeDisabled();
  });

  it("加载、错误与无数据三种兜底态", () => {
    m.state.loading = true;
    const loadingRender = showPage();
    expect(screen.getByRole("status")).toHaveTextContent("正在加载数据…");
    loadingRender.unmount();

    m.state.loading = false;
    m.state.error = new Error("没有权限");
    const errorRender = showPage();
    expect(screen.getByRole("alert")).toHaveTextContent("没有权限");
    errorRender.unmount();

    m.state.error = null;
    m.state.noData = true;
    showPage();
    expect(screen.getByText("未找到项目")).toBeInTheDocument();
  });

  it("成员列表为空时表格显示占位行", () => {
    m.state.emptyRows = true;
    showPage();
    expect(screen.getByText("暂无成员")).toBeInTheDocument();
  });

  it("设置核算起止携带当前核算窗口版本提交并提示结束", async () => {
    m.lifecycleMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: (data: { mode: string }) => void }) => opts.onSuccess({ mode: "ENDED" }),
    );
    showPage();
    await userEvent.click(screen.getByRole("button", { name: "设置核算起止" }));
    expect(m.lifecycleMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "页面操作核算生命周期",
        expectedVersion: 7,
      }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(screen.getByText("已结束核算")).toBeInTheDocument();
    expect(m.refetch).toHaveBeenCalledOnce();
  });

  it("无核算配置时 expectedVersion 回落为 0，提示开始核算", async () => {
    m.state.accountingVersion = null;
    m.lifecycleMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: (data: { mode?: string }) => void }) => opts.onSuccess({}),
    );
    showPage();
    await userEvent.click(screen.getByRole("button", { name: "设置核算起止" }));
    expect(m.lifecycleMutate).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 0 }),
      expect.anything(),
    );
    expect(screen.getByText("已开始核算")).toBeInTheDocument();
  });

  it("核算操作失败展示原因", async () => {
    m.lifecycleMutate.mockImplementation(
      (_payload: unknown, opts: { onError: (error: Error) => void }) => opts.onError(new Error("版本冲突")),
    );
    showPage();
    await userEvent.click(screen.getByRole("button", { name: "设置核算起止" }));
    expect(screen.getByText("操作失败：版本冲突")).toBeInTheDocument();
  });

  it("加入成员提交转换后的权重并提示成功", async () => {
    m.createMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    showPage();
    const joinButton = screen.getByRole("button", { name: "加入项目" });
    expect(joinButton).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox"), "emp-1");
    await userEvent.type(screen.getByLabelText(/权重 %/), "12.5");
    await userEvent.type(screen.getByPlaceholderText("例如：新成员加入项目"), "新成员加入");
    expect(joinButton).toBeEnabled();
    await userEvent.click(joinButton);
    expect(m.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        employeePrincipalId: "emp-1",
        reason: "新成员加入",
        weightBps: 1250,
        leftAt: null,
        idempotencyKey: expect.stringMatching(/^ui-emp-1-/),
      }),
      expect.anything(),
    );
    expect(screen.getByText("成员已加入")).toBeInTheDocument();
  });

  it("加入失败展示原因", async () => {
    m.createMutate.mockImplementation(
      (_payload: unknown, opts: { onError: (error: Error) => void }) => opts.onError(new Error("服务繁忙")),
    );
    showPage();
    await userEvent.selectOptions(screen.getByRole("combobox"), "emp-2");
    await userEvent.type(screen.getByPlaceholderText("例如：新成员加入项目"), "加入");
    await userEvent.click(screen.getByRole("button", { name: "加入项目" }));
    expect(screen.getByText("加入失败：服务繁忙")).toBeInTheDocument();
  });

  it("记录退出携带行版本提交并提示", async () => {
    m.reviseMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    showPage();
    await userEvent.click(screen.getAllByRole("button", { name: "记录退出" })[0]!);
    expect(m.reviseMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "m-1",
        expectedRevision: 3,
        reason: "退出项目",
        idempotencyKey: expect.stringMatching(/^ui-exit-m-1-/),
      }),
      expect.anything(),
    );
    expect(
      screen.getByText("已记录退出；今日仍有规则覆盖的用量按规则归集"),
    ).toBeInTheDocument();
  });

  it("调整权重先预览：提交百分比转 bps 的意图段", async () => {
    showPage();
    await userEvent.click(screen.getAllByRole("button", { name: "调整权重" })[0]!);
    expect(screen.getByText("调整权重 — 张三")).toBeInTheDocument();
    const previewButton = screen.getByRole("button", { name: "预览" });
    expect(previewButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("目标权重 %"), "30");
    await userEvent.click(previewButton);
    expect(m.previewMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        employeePrincipalId: "emp-1",
        expectedPolicyVersion: null,
        segments: [expect.objectContaining({ weightBps: 3000, validUntil: null })],
      }),
    );
  });

  it("预览通过后可发布：携带预览版本提交并关闭面板", async () => {
    m.state.preview = {
      currentVersion: 4,
      conflicts: [],
      hidden: { hiddenProjectCount: 1, hiddenWeightBps: 4000, availableBps: 6000, remainingBps: 4000 },
      segments: [{ weightBps: 3000, availableBps: 6000, remainingBps: 4000 }],
    };
    m.publishMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    showPage();
    await userEvent.click(screen.getAllByRole("button", { name: "调整权重" })[0]!);
    expect(screen.getByText(/可用容量 60%/)).toBeInTheDocument();
    expect(screen.getByText(/本段后剩余 40%/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("目标权重 %"), "30");
    await userEvent.click(screen.getByRole("button", { name: "发布" }));
    expect(m.publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        employeePrincipalId: "emp-1",
        expectedPolicyVersion: 4,
        reason: "项目页权重调整",
        segments: [expect.objectContaining({ weightBps: 3000 })],
      }),
      expect.anything(),
    );
    expect(screen.getByText("权重已发布")).toBeInTheDocument();
    expect(screen.queryByText("调整权重 — 张三")).not.toBeInTheDocument();
  });

  it("预览发现冲突时展示明细并禁用发布", async () => {
    m.state.preview = {
      currentVersion: 4,
      conflicts: [
        { kind: "OVER_CAPACITY", message: "权重合计超出可用容量", totalBps: 12000 },
        { kind: "OVERLAP", message: "与其他项目段重叠" },
      ],
      hidden: { hiddenProjectCount: 0, hiddenWeightBps: 0, availableBps: 10000, remainingBps: 0 },
      segments: [],
    };
    showPage();
    await userEvent.click(screen.getAllByRole("button", { name: "调整权重" })[0]!);
    expect(screen.getByText(/权重合计超出可用容量/)).toBeInTheDocument();
    expect(screen.getByText(/（合计 120.00%）/)).toBeInTheDocument();
    expect(screen.getByText(/本段后剩余 —/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布" })).toBeDisabled();
  });
});
