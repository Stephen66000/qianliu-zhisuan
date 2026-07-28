/**
 * W18 用量账本单测 —— 表格渲染 / 套餐内展示 / 分页 / 空态。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageResult } from "../api/types";
import { UsagePage } from "./Usage";

const useUsageMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useUsage: (params: unknown) => useUsageMock(params),
}));

function usageResult(records: UsageResult["records"], total: number): UsageResult {
  return { records, total, limit: 20, offset: 0 };
}

function sampleRecord(): UsageResult["records"][number] {
  return {
    requestId: "req-0001",
    principalId: "p1",
    principalName: "张三",
    principalType: "EMPLOYEE",
    clientId: "cli-1",
    unifiedModel: "glm-4.6",
    status: "SUCCEEDED",
    errorClassification: null,
    errorCode: null,
    startedAt: "2026-07-28T02:00:00.000Z",
    finishedAt: "2026-07-28T02:00:01.200Z",
    durationMs: 1200,
    totalInputTokens: "200",
    totalOutputTokens: "100",
    totalCacheTokens: "0",
    totalDeductedQuota: "300",
    totalApiCost: "0",
    usageQuality: "UPSTREAM_REPORTED",
    attemptCount: 1,
  };
}

function renderUsage() {
  return render(
    <MemoryRouter>
      <UsagePage />
    </MemoryRouter>,
  );
}

describe("W18 用量账本", () => {
  beforeEach(() => {
    useUsageMock.mockReset();
  });

  it("空态：说明为什么为空 + 下一步（PRD §10.4）", () => {
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([], 0),
      refetch: vi.fn(),
    });
    renderUsage();
    expect(screen.getByText("没有账本记录")).toBeInTheDocument();
    expect(screen.getByText(/当前筛选条件没有账本记录/)).toBeInTheDocument();
  });

  it("有数据：token 千分位、耗时格式化、套餐内展示（不写 ¥0）", () => {
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([sampleRecord()], 1),
      refetch: vi.fn(),
    });
    renderUsage();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("glm-4.6")).toBeInTheDocument();
    expect(screen.getByText("套餐内")).toBeInTheDocument();
    expect(screen.queryByText("0.00")).toBeNull();
    expect(screen.getByText("1.2s")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
  });

  it("失败记录用 danger 标签", () => {
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([{ ...sampleRecord(), status: "FAILED" }], 1),
      refetch: vi.fn(),
    });
    renderUsage();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("分页：总数 > 一页时下一页可点", () => {
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([sampleRecord()], 45),
      refetch: vi.fn(),
    });
    renderUsage();
    expect(screen.getByText(/共 45 条/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 3 页/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  });

  it("请求参数包含分页 limit/offset", () => {
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([], 0),
      refetch: vi.fn(),
    });
    renderUsage();
    expect(useUsageMock).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });
});
