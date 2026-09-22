import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OperatingBillProjectAllocationPage } from "./OperatingBillProjectAllocation";

const m = vi.hoisted(() => ({
  enableMutate: vi.fn(),
  createRunMutate: vi.fn(),
  linesArgs: vi.fn(),
  state: {
    status: null as Record<string, unknown> | null,
    statusError: null as Error | null,
    lines: null as Record<string, unknown> | null,
    linesLoading: false,
    linesError: null as Error | null,
    unallocated: null as Record<string, unknown> | null,
  },
}));

vi.mock("../api/project-allocation", () => ({
  useAllocationStatus: () => ({
    data: m.state.status, isLoading: false, isError: m.state.statusError !== null,
    error: m.state.statusError,
  }),
  useAllocationLines: (month: string, projectId: string, offset: number) => {
    m.linesArgs(month, projectId, offset);
    return {
      data: m.state.lines, isLoading: m.state.linesLoading,
      isError: m.state.linesError !== null, error: m.state.linesError,
    };
  },
  useUnallocated: () => ({ data: m.state.unallocated, isLoading: false, error: null }),
  useEnableAllocation: () => ({ mutate: m.enableMutate, isPending: false }),
  useCreateAllocationRun: () => ({ mutate: m.createRunMutate, isPending: false }),
}));

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    month: "2026-08", enabled: true,
    currentRun: { id: "run-1", status: "SUCCEEDED", computedAt: "2026-08-31T12:00:00+08:00", stale: false },
    lastError: null, latestRun: null,
    ...overrides,
  };
}

function linesFixture(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    lines: [
      {
        ledgerLineId: "a1", requestId: "req-1", employeeName: "张三",
        allocationSource: "MEMBERSHIP_RULE", weightBps: 5000,
        requestStartedAt: "2026-08-01T10:00:00+08:00",
        shareInputTokens: "10.5", shareOutputTokens: "2.5",
        shareApiCost: "0.12", apiCostCurrency: "CNY", sharePackageCost: "0.30",
        usageQuality: "GOOD",
      },
      {
        ledgerLineId: "a2", requestId: "req-2", employeeName: null,
        allocationSource: "PROJECT_DIRECT", weightBps: null,
        requestStartedAt: "2026-08-02T10:00:00+08:00",
        shareInputTokens: "1", shareOutputTokens: "0",
        shareApiCost: null, apiCostCurrency: null, sharePackageCost: null,
        usageQuality: "BAD",
      },
    ],
    total: 60, limit: 25, offset: 0,
    ...overrides,
  };
}

/** 7 条未分配源行（>5 触发合计提示），含未知原因与未知员工分支。 */
function unallocatedFixture(lineCount = 7): Record<string, unknown> {
  return {
    runId: "run-1", tokens: "12345",
    byReason: { NO_MEMBERSHIP: "1000", WEIGHT_REMAINDER: "234" },
    apiCostByCurrency: {}, packageCostCny: "0", lineCount,
    detail: {
      runId: "run-1", total: lineCount, limit: 10, offset: 0,
      lines: Array.from({ length: lineCount }, (_, index) => ({
        ledgerLineId: `l-${index + 1}`, requestId: `r-${index + 1}`,
        employeeName: index === 5 ? null : `员工${index + 1}`,
        unallocatedReason: index === 6 ? null : index === 0 ? "HISTORICAL_UNKNOWN" : "NO_MEMBERSHIP",
        shareInputTokens: `${index + 1}0`, shareOutputTokens: "1",
        providerResourceId: null,
      })),
    },
  };
}

function showPage() {
  return render(
    <MemoryRouter initialEntries={["/operating-bill/projects/proj-1?month=2026-08"]}>
      <Routes>
        <Route element={<OperatingBillProjectAllocationPage />} path="/operating-bill/projects/:principalId" />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  m.enableMutate.mockReset();
  m.createRunMutate.mockReset();
  m.linesArgs.mockReset();
  m.state.status = statusFixture();
  m.state.statusError = null;
  m.state.lines = linesFixture();
  m.state.linesLoading = false;
  m.state.linesError = null;
  m.state.unallocated = unallocatedFixture();
});

describe("项目账归集详情页", () => {
  it("状态卡展示计算结果、时间与批次提示", () => {
    m.state.status = statusFixture({ latestRun: { id: "run-2", status: "RUNNING", createdAt: null, lastError: null } });
    showPage();
    expect(screen.getByRole("heading", { name: "项目归集明细" })).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getByText(/计算于 2026\/8\/31 12:00:00/)).toBeInTheDocument();
    expect(screen.getByText("批次计算中")).toBeInTheDocument();
  });

  it("状态分支：待计算、待更新、上次错误与失败原因", () => {
    m.state.status = statusFixture({
      currentRun: null,
      lastError: "上次计算超时",
      latestRun: { id: "run-2", status: "FAILED", createdAt: null, lastError: "存储超限" },
    });
    const first = showPage();
    expect(screen.getByText("待计算")).toBeInTheDocument();
    expect(screen.getByText("上次计算超时")).toBeInTheDocument();
    expect(screen.getByText("批次失败：存储超限")).toBeInTheDocument();
    first.unmount();

    m.state.status = statusFixture({
      currentRun: { id: "run-1", status: "SUCCEEDED", computedAt: null, stale: true },
      lastError: null, latestRun: { id: "run-2", status: "QUEUED", createdAt: null, lastError: null },
    });
    const second = showPage();
    expect(screen.getByText("待更新")).toBeInTheDocument();
    expect(screen.getByText("已登记批次，等待执行")).toBeInTheDocument();
    second.unmount();

    // 非成功批次：状态卡原样展示批次状态
    m.state.status = statusFixture({
      currentRun: { id: "run-3", status: "RUNNING", computedAt: null, stale: false },
      latestRun: null,
    });
    showPage();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
  });

  it("未分配卡展示汇总、原因拆分与明细前 5 行，超 5 行提示合计", () => {
    showPage();
    expect(screen.getByText("12345")).toBeInTheDocument();
    expect(screen.getByText("无参与关系 1000；权重余量 234")).toBeInTheDocument();
    expect(screen.getByText("历史关系未知 · 员工1 · 10 Token")).toBeInTheDocument();
    expect(screen.getByText("无参与关系 · 员工2 · 20 Token")).toBeInTheDocument();
    expect(screen.queryByText(/未知员工/)).not.toBeInTheDocument();
    expect(screen.queryByText("员工6")).not.toBeInTheDocument();
    expect(screen.getByText("共 7 条未分配源行")).toBeInTheDocument();
  });

  it("未分配行数不超过 5 时不显示合计提示，原因键未知时原样展示", () => {
    const view = unallocatedFixture(2);
    view.byReason = { SOME_NEW_REASON: "88" };
    m.state.unallocated = view;
    showPage();
    expect(screen.getByText("SOME_NEW_REASON 88")).toBeInTheDocument();
    expect(screen.queryByText(/条未分配源行/)).not.toBeInTheDocument();
  });

  it("归集明细表渲染来源标签、份额与质量列", () => {
    showPage();
    expect(screen.getByRole("cell", { name: "成员规则分摊（50.00%）" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "项目直接调用" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "项目主体" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "13.0000" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "0.12 CNY" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "0.30" })).toBeInTheDocument();
    expect(screen.getAllByRole("cell", { name: "—" })).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "GOOD" })).toBeInTheDocument();
  });

  it("分页按钮推进 offset 并以新 offset 触发读取", async () => {
    showPage();
    expect(screen.getByText("1–25 / 60")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(m.linesArgs).toHaveBeenLastCalledWith("2026-08", "proj-1", 0);
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("26–50 / 60")).toBeInTheDocument();
    expect(m.linesArgs).toHaveBeenLastCalledWith("2026-08", "proj-1", 25);
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(screen.getByText("1–25 / 60")).toBeInTheDocument();
    expect(m.linesArgs).toHaveBeenLastCalledWith("2026-08", "proj-1", 0);
  });

  it("批次总数不超过一页时不显示分页", () => {
    m.state.lines = linesFixture({ total: 25 });
    showPage();
    expect(screen.queryByText("1–25 / 60")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
  });

  it("未启用归集时提供启用入口并提交启动月份", async () => {
    m.state.status = statusFixture({ enabled: false });
    m.enableMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: () => void; onError: (error: Error) => void }) => {
        opts.onSuccess();
        opts.onError(new Error("已启用"));
      },
    );
    showPage();
    expect(screen.getByText("该账期未启用项目归集。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "启用项目归集" }));
    expect(m.enableMutate).toHaveBeenCalledWith(
      { startMonth: "2026-08", reason: "项目账页启用归集" },
      expect.anything(),
    );
  });

  it("促发重算按钮提交原因", async () => {
    m.createRunMutate.mockImplementation(
      (_payload: unknown, opts: { onSuccess: () => void; onError: (error: Error) => void }) => {
        opts.onSuccess();
        opts.onError(new Error("已有批次执行中"));
      },
    );
    showPage();
    await userEvent.click(screen.getByRole("button", { name: "促发重算" }));
    expect(m.createRunMutate).toHaveBeenCalledWith(
      { reason: "项目账页手工促发" },
      expect.anything(),
    );
  });

  it("明细加载、失败与空批次兜底态", () => {
    m.state.linesLoading = true;
    const loading = showPage();
    expect(screen.getByRole("status")).toHaveTextContent("正在加载数据…");
    loading.unmount();

    m.state.linesLoading = false;
    m.state.linesError = new Error("归集批次读取失败");
    const error = showPage();
    expect(screen.getByRole("alert")).toHaveTextContent("归集批次读取失败");
    error.unmount();

    m.state.linesError = null;
    m.state.lines = linesFixture({ runId: null, lines: [] });
    showPage();
    expect(screen.getByText("该账期还没有可用的归集批次")).toBeInTheDocument();
  });

  it("runId 存在但无明细行时显示空表占位", () => {
    m.state.lines = linesFixture({ lines: [] });
    showPage();
    expect(screen.getByText("无明细")).toBeInTheDocument();
  });
});
