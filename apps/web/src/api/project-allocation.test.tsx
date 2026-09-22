import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useAllocationLines, useAllocationStatus, useCreateAllocationRun,
  useCreateProjectMembership, useEnableAllocation, useEmployeesForMembership,
  usePreviewPolicyIntent, useProjectMemberships, usePublishPolicyIntent,
  useReviseAccountingLifecycle, useReviseProjectMembership, useUnallocated,
} from "./project-allocation";

const http = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./client", () => http);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

/** 按 offset 返回不同 runId 的归集明细分页响应。 */
function linesResponse(runId: string, offset: number) {
  return Promise.resolve({
    runId, lines: [], total: 0, limit: 25, offset,
  });
}

beforeEach(() => {
  http.get.mockReset().mockResolvedValue({});
  http.post.mockReset().mockResolvedValue({});
});

describe("项目归集查询 hooks", () => {
  it("成员列表按项目取数，at 参数可选", async () => {
    const plain = renderHook(() => useProjectMemberships("proj-1"), { wrapper });
    const withAt = renderHook(() => useProjectMemberships("proj-1", "2026-08-01"), { wrapper });
    await waitFor(() => expect(plain.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(withAt.result.current.isSuccess).toBe(true));
    expect(http.get).toHaveBeenCalledWith("/principals/proj-1/project-memberships?limit=100");
    expect(http.get).toHaveBeenCalledWith("/principals/proj-1/project-memberships?limit=100&at=2026-08-01");
  });

  it("员工下拉目录使用 EMPLOYEE 过滤", async () => {
    const hook = renderHook(() => useEmployeesForMembership(), { wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(http.get).toHaveBeenCalledWith("/principals?type=EMPLOYEE&limit=100");
  });

  it("归集状态仅在合法月份查询", async () => {
    const valid = renderHook(() => useAllocationStatus("2026-08"), { wrapper });
    await waitFor(() => expect(valid.result.current.isSuccess).toBe(true));
    expect(http.get).toHaveBeenCalledWith("/operating-bills/2026-08/project-allocation-status");
    renderHook(() => useAllocationStatus("2026-8"), { wrapper });
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it("未分配汇总带 detail 明细上限", async () => {
    http.get.mockResolvedValue({ tokens: "1", byReason: {}, detail: { lines: [] } });
    const hook = renderHook(() => useUnallocated("2026-08", 5), { wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(http.get).toHaveBeenCalledWith("/operating-bills/2026-08/project-unallocated?limit=5");
    expect(hook.result.current.data?.tokens).toBe("1");
  });

  it("分页固定批次：首页存 runId，次页携带 run_id，换月后固定解除", async () => {
    http.get.mockImplementation((path: string) => {
      if (path.includes("/2026-08/")) return linesResponse("run-a", 0);
      return linesResponse("run-b", 0);
    });
    const hook = renderHook(
      (props: { month: string; offset: number }) =>
        useAllocationLines(props.month, "proj-1", props.offset),
      { initialProps: { month: "2026-08", offset: 0 }, wrapper },
    );
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(http.get).toHaveBeenNthCalledWith(
      1,
      "/operating-bills/2026-08/projects/proj-1/allocation-lines?limit=25&offset=0",
    );
    // 首页响应的 runId 已存为固定批次
    expect(hook.result.current.data?.runId).toBe("run-a");

    hook.rerender({ month: "2026-08", offset: 25 });
    await waitFor(() =>
      expect(http.get).toHaveBeenNthCalledWith(
        2,
        "/operating-bills/2026-08/projects/proj-1/allocation-lines?limit=25&offset=25&run_id=run-a",
      ),
    );

    // 月份变化：offset=0 不携带 run_id，且新月份的 runId 覆盖旧固定
    hook.rerender({ month: "2026-09", offset: 0 });
    await waitFor(() =>
      expect(http.get).toHaveBeenNthCalledWith(
        3,
        "/operating-bills/2026-09/projects/proj-1/allocation-lines?limit=25&offset=0",
      ),
    );
    await waitFor(() => expect(hook.result.current.data?.runId).toBe("run-b"));

    hook.rerender({ month: "2026-09", offset: 25 });
    await waitFor(() =>
      expect(http.get).toHaveBeenNthCalledWith(
        4,
        "/operating-bills/2026-09/projects/proj-1/allocation-lines?limit=25&offset=25&run_id=run-b",
      ),
    );
  });

  it("项目为空或月份非法时不查询归集明细", () => {
    renderHook(() => useAllocationLines("2026-08", "", 0), { wrapper });
    renderHook(() => useAllocationLines("bad-month", "proj-1", 0), { wrapper });
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe("项目归集 mutation hooks", () => {
  it("加入/退出成员与权重意图按端点提交并失效成员列表", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["project-memberships", "proj-1", null], { rows: [] });
    function render<T>(hook: () => T) {
      return renderHook(hook, {
        wrapper: function Provider({ children }: { children: ReactNode }) {
          return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
        },
      });
    }

    const create = render(() => useCreateProjectMembership("proj-1"));
    await create.result.current.mutateAsync({
      employeePrincipalId: "emp-1", joinedAt: "2026-08-01", reason: "加入", idempotencyKey: "k1",
    });
    expect(http.post).toHaveBeenCalledWith("/principals/proj-1/project-memberships", {
      employeePrincipalId: "emp-1", joinedAt: "2026-08-01", reason: "加入", idempotencyKey: "k1",
    });
    expect(client.getQueryState(["project-memberships", "proj-1", null])?.isInvalidated).toBe(true);

    const revise = render(() => useReviseProjectMembership("proj-1"));
    await revise.result.current.mutateAsync({
      membershipId: "m-1", expectedRevision: 3, leftAt: "2026-09-01", reason: "退出", idempotencyKey: "k2",
    });
    expect(http.post).toHaveBeenCalledWith(
      "/principals/proj-1/project-memberships/m-1/revisions",
      { membershipId: "m-1", expectedRevision: 3, leftAt: "2026-09-01", reason: "退出", idempotencyKey: "k2" },
    );

    const preview = render(() => usePreviewPolicyIntent("proj-1"));
    const previewView = {
      currentVersion: 4, conflicts: [], hidden: { hiddenProjectCount: 0, hiddenWeightBps: 0, availableBps: 10000, remainingBps: 9000 },
      segments: [], visibleRules: [],
    };
    http.post.mockResolvedValueOnce(previewView);
    await preview.result.current.mutateAsync({
      employeePrincipalId: "emp-1", expectedPolicyVersion: null,
      segments: [{ validFrom: "2026-09-22", validUntil: null, weightBps: 3000 }],
    });
    expect(http.post).toHaveBeenCalledWith("/principals/proj-1/project-allocation-intents/preview", {
      employeePrincipalId: "emp-1", expectedPolicyVersion: null,
      segments: [{ validFrom: "2026-09-22", validUntil: null, weightBps: 3000 }],
    });
    await waitFor(() => expect(preview.result.current.data).toEqual(previewView));

    const publish = render(() => usePublishPolicyIntent("proj-1"));
    await publish.result.current.mutateAsync({
      employeePrincipalId: "emp-1", expectedPolicyVersion: 4, reason: "调整", idempotencyKey: "k3",
      segments: [{ validFrom: "2026-09-22", validUntil: null, weightBps: 3000 }],
    });
    expect(http.post).toHaveBeenCalledWith("/principals/proj-1/project-allocation-intents/versions", {
      employeePrincipalId: "emp-1", expectedPolicyVersion: 4, reason: "调整", idempotencyKey: "k3",
      segments: [{ validFrom: "2026-09-22", validUntil: null, weightBps: 3000 }],
    });

    const lifecycle = render(() => useReviseAccountingLifecycle("proj-1"));
    await lifecycle.result.current.mutateAsync({ effectiveAt: "2026-09-30", reason: "结束", expectedVersion: 7 });
    expect(http.post).toHaveBeenCalledWith("/principals/proj-1/accounting-lifecycle-revisions", {
      effectiveAt: "2026-09-30", reason: "结束", expectedVersion: 7,
    });
  });

  it("启用归集与促发重算提交到月度端点并失效状态", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["project-allocation-status", "2026-08"], { enabled: false });
    function render<T>(hook: () => T) {
      return renderHook(hook, {
        wrapper: function Provider({ children }: { children: ReactNode }) {
          return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
        },
      });
    }

    const enable = render(() => useEnableAllocation("2026-08"));
    await enable.result.current.mutateAsync({ startMonth: "2026-08", reason: "启用" });
    expect(http.post).toHaveBeenCalledWith(
      "/operating-bills/2026-08/project-allocation-enablement",
      { startMonth: "2026-08", reason: "启用" },
    );
    expect(client.getQueryState(["project-allocation-status", "2026-08"])?.isInvalidated).toBe(true);

    const createRun = render(() => useCreateAllocationRun("2026-08"));
    await createRun.result.current.mutateAsync({ reason: "重算" });
    expect(http.post).toHaveBeenCalledWith(
      "/operating-bills/2026-08/project-allocation-runs",
      { reason: "重算" },
    );
  });
});
