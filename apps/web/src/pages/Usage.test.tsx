/**
 * W18 用量账本单测 —— 表格渲染 / 套餐内展示 / 分页 / 空态。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageResult } from "../api/types";
import { UsagePage } from "./Usage";

const useUsageMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useUsage: (params: unknown) => useUsageMock(params),
  usePrincipals: () => ({
    data: { principals: [{ id: "00000000-0000-4000-8000-000000000001", name: "张三" }] },
  }),
  useProviders: () => ({
    data: { providers: [{ id: "00000000-0000-4000-8000-000000000002", name: "智谱" }] },
  }),
  useProviderResources: () => ({
    data: {
      resources: [{
        id: "00000000-0000-4000-8000-000000000003",
        provider_id: "00000000-0000-4000-8000-000000000002",
        name: "智谱主资源",
      }],
    },
  }),
  useUnifiedModels: () => ({
    data: {
      models: [{
        id: "00000000-0000-4000-8000-000000000004",
        alias: "glm-4.6",
        display_name: "GLM 4.6",
      }],
    },
  }),
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
    agentFamily: "CODEX",
    agentVersion: "0.146.0",
    agentIdentitySource: "DECLARED_HEADER",
    agentIdentityConfidence: "DECLARED",
    clientIdentityRuleVersion: "2026-08-03.v1",
    unifiedModel: "glm-4.6",
    status: "SUCCEEDED",
    errorClassification: null,
    errorCode: null,
    startedAt: "2026-07-28T02:00:00.000Z",
    finishedAt: "2026-07-28T02:00:01.200Z",
    durationMs: 1200,
    finalProviderId: "00000000-0000-4000-8000-000000000002",
    finalProviderCode: "zhipu",
    finalProviderName: "智谱",
    finalProviderResourceId: "00000000-0000-4000-8000-000000000003",
    finalProviderResourceName: "智谱主资源",
    overage: false,
    totalInputTokens: "200",
    totalOutputTokens: "100",
    totalCacheTokens: "0",
    totalReasoningTokens: "0",
    totalDeductedQuota: "300",
    totalApiCost: "0",
    usageQuality: "UPSTREAM_REPORTED",
    attemptCount: 1,
    hasSettlement: true,
  };
}

function renderUsage(initialEntry = "/usage") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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
    const row = screen.getByRole("row", { name: /req-0001/ });
    expect(within(row).getByText("张三")).toBeInTheDocument();
    expect(within(row).getByText("glm-4.6")).toBeInTheDocument();
    expect(within(row).getByText("智谱主资源")).toBeInTheDocument();
    expect(within(row).getByText("套餐内")).toBeInTheDocument();
    expect(within(row).queryByText("0.00")).toBeNull();
    expect(within(row).getByText("1.2s")).toBeInTheDocument();
    expect(within(row).getByText("成功")).toBeInTheDocument();
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

  it("无结算请求显示未结算，不冒充套餐内", () => {
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([{
        ...sampleRecord(),
        status: "FAILED",
        hasSettlement: false,
        usageQuality: "UNKNOWN",
        attemptCount: 0,
      }], 1),
      refetch: vi.fn(),
    });
    renderUsage();
    expect(screen.getByText("未结算")).toBeInTheDocument();
    expect(screen.queryByText("套餐内")).not.toBeInTheDocument();
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
    expect(useUsageMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));
  });

  it("从 URL 恢复组合筛选，清除后恢复完整列表", async () => {
    const user = userEvent.setup();
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([sampleRecord()], 1),
      refetch: vi.fn(),
    });
    renderUsage(
      "/usage?search=req-00&principal_id=00000000-0000-4000-8000-000000000001&overage_only=true&page=3",
    );
    expect(screen.getByLabelText("搜索主体、姓名或项目")).toHaveValue("req-00");
    expect(screen.getByLabelText("主体")).toHaveValue("00000000-0000-4000-8000-000000000001");
    expect(screen.getByLabelText("只看超额")).toBeChecked();
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "req-00",
      principal_id: "00000000-0000-4000-8000-000000000001",
      overage_only: true,
      offset: 40,
    }));

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByLabelText("搜索主体、姓名或项目")).toHaveValue("");
    expect(screen.getByLabelText("只看超额")).not.toBeChecked();
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      search: undefined,
      principal_id: undefined,
      overage_only: undefined,
      offset: 0,
    }));
  });

  it("筛选变化重置页码并传给后端", async () => {
    const user = userEvent.setup();
    useUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: usageResult([sampleRecord()], 60),
      refetch: vi.fn(),
    });
    renderUsage("/usage?page=2");
    await user.selectOptions(screen.getByLabelText("Agent"), "WORKBUDDY");
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      agent_family: "WORKBUDDY",
      offset: 0,
    }));
  });
  it("输入姓名或项目后点击查询或回车才应用，并重置页码", async () => {
    const user = userEvent.setup();
    useUsageMock.mockReturnValue({ isLoading: false, error: null, data: usageResult([], 60), refetch: vi.fn() });
    renderUsage("/usage?tab=details&page=3");
    const search = screen.getByRole("searchbox", { name: "搜索主体、姓名或项目" });
    await user.type(search, "张三");
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: undefined, offset: 40 }));
    await user.click(screen.getByRole("button", { name: "查询" }));
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: "张三", offset: 0 }));
    const applied = screen.getByRole("searchbox", { name: "搜索主体、姓名或项目" });
    await user.clear(applied);
    await user.type(applied, " 星河项目{Enter}");
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: "星河项目", offset: 0 }));
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(useUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: undefined }));
  });

});
