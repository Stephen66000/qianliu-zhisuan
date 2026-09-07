import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageOverview } from "../../api/v2-types";
import { UsageOverviewPanel } from "./UsageOverviewPanel";

const useUsageOverviewMock = vi.fn();
const usePrincipalOptionsMock = vi.fn();
const usePrincipalOptionMock = vi.fn();
const resolvePrincipalExactMatchMock = vi.fn();

vi.mock("../../api/v2-hooks", () => ({
  useUsageOverview: (query: string) => useUsageOverviewMock(query),
  usePrincipalOptions: (type: string, search: string, offset: number, limit: number) => usePrincipalOptionsMock(type, search, offset, limit),
  usePrincipalOption: (id: string | null) => usePrincipalOptionMock(id),
  resolvePrincipalExactMatch: (type: string, name: string) => resolvePrincipalExactMatchMock(type, name),
}));

const projectId = "20000000-0000-4000-8000-000000000001";
const anchor = "2026-08-12T04:00:00.000Z";

function overview(overrides: Partial<UsageOverview> = {}): UsageOverview {
  return {
    subjectType: "PROJECT",
    subjectId: projectId,
    period: "WEEK",
    anchor,
    timezone: "Asia/Shanghai",
    range: { from: "2026-08-09T16:00:00.000Z", to: "2026-08-16T16:00:00.000Z" },
    metrics: { activeSubjects: 1, requestCount: "2", inputTokens: "100", outputTokens: "20", cacheTokens: "50", reasoningTokens: "5", realTokens: "120", apiCost: "1.5", deductedQuota: "120", usageQuality: "PROVIDER_REPORTED", providerReportedCount: 2, estimatedCount: 0, accountAggregatedCount: 0, mixedCount: 0, unknownCount: 0 },
    trend: [{ bucketStart: "2026-08-09T16:00:00.000Z", bucketEnd: "2026-08-10T16:00:00.000Z", label: "周一", collectionStatus: "COMPLETE", requestCount: "2", inputTokens: "100", outputTokens: "20", cacheTokens: "50", reasoningTokens: "5", realTokens: "120", apiCost: "1.5", deductedQuota: "120" }],
    ranking: [{ subjectId: projectId, subjectName: "星河项目", departmentLabel: "研发", requestCount: "2", inputTokens: "100", outputTokens: "20", cacheTokens: "50", reasoningTokens: "5", realTokens: "120", apiCost: "1.5", deductedQuota: "120", share: "1" }],
    factWatermark: "2026-08-12T03:00:00.000Z",
    generatedAt: "2026-08-12T04:01:00.000Z",
    detailQuery: { principalId: null, projectId, subjectType: "PROJECT", settledOnly: true, from: "2026-08-09T16:00:00.000Z", toExclusive: "2026-08-16T16:00:00.000Z" },
    stale: false,
    source: "LIVE_LEDGER",
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderPanel(entry = `/usage?tab=overview&subject_type=PROJECT&period=WEEK&subject_id=${projectId}&anchor=${encodeURIComponent(anchor)}`) {
  return render(<MemoryRouter initialEntries={[entry]}><UsageOverviewPanel /><LocationProbe /></MemoryRouter>);
}

describe("W20-04 用量概览 Web", () => {
  beforeEach(() => {
    useUsageOverviewMock.mockReset();
    usePrincipalOptionsMock.mockReset();
    usePrincipalOptionMock.mockReset();
    resolvePrincipalExactMatchMock.mockReset();
    useUsageOverviewMock.mockReturnValue({ isLoading: false, error: null, data: overview(), refetch: vi.fn() });
    usePrincipalOptionsMock.mockReturnValue({ isLoading: false, error: null, data: { principals: [{ id: projectId, type: "PROJECT", name: "星河项目" }], total: 45, limit: 20, offset: 0 } });
    usePrincipalOptionMock.mockReturnValue({ data: { principal: { id: projectId, type: "PROJECT", name: "星河项目" } } });
    resolvePrincipalExactMatchMock.mockResolvedValue({
      principal: { id: projectId, type: "PROJECT", name: "星河项目" }, match_count: 1,
    });
  });

  it("从 URL 恢复主体/周期/单项目并传给后端聚合", () => {
    renderPanel();
    const call = new URLSearchParams(useUsageOverviewMock.mock.calls.at(-1)?.[0]);
    expect(Object.fromEntries(call)).toMatchObject({ subject_type: "PROJECT", period: "WEEK", subject_id: projectId, anchor });
    expect(screen.getByRole("combobox", { name: "用量主体类型" })).toHaveValue("PROJECT");
    expect(screen.getByRole("button", { name: "本周" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "指定用量主体" })).toHaveValue(projectId);
  });

  it("指标保留数值，移除计量说明与技术来源文案", () => {
    useUsageOverviewMock.mockReturnValue({
      isLoading: false, error: null, refetch: vi.fn(),
      data: overview({ metrics: {
        ...overview().metrics, usageQuality: "ACCOUNT_AGGREGATED",
        providerReportedCount: 0, accountAggregatedCount: 2,
      } }),
    });
    renderPanel();
    expect(screen.queryByText(/账户聚合计量|计量未知|聚合读模型|实时账本|聚合数据已滞后/)).not.toBeInTheDocument();
    expect(screen.getByText(/数据时间/)).toBeInTheDocument();
    expect(screen.queryByText("参考日期")).not.toBeInTheDocument();
    expect(screen.queryByText(/输入名称后点击/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("用量锚点")).toBeInTheDocument();
  });

  it("排名点击回写 URL，明细下钻携带主体口径与半开时间", async () => {
    const user = userEvent.setup();
    renderPanel("/usage?tab=overview&subject_type=PROJECT&period=WEEK");
    await user.click(screen.getByRole("button", { name: "星河项目" }));
    expect(screen.getByTestId("location")).toHaveTextContent(`subject_id=${projectId}`);
    const details = screen.getByRole("link", { name: "查看请求明细" });
    const target = new URL(details.getAttribute("href")!, "http://localhost");
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      tab: "details",
      subject_type: "PROJECT",
      settled_only: "true",
      status: "SUCCEEDED",
      project_id: projectId,
      from: "2026-08-09T16:00:00.000Z",
      to_exclusive: "2026-08-16T16:00:00.000Z",
    });
  });

  it("主体选择器使用服务端搜索与分页", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole("searchbox", { name: "搜索用量主体" }), "星河");
    await waitFor(() => expect(usePrincipalOptionsMock).toHaveBeenLastCalledWith("PROJECT", "星河", 0, 20));
    await user.click(screen.getByRole("button", { name: "主体下一页" }));
    await waitFor(() => expect(usePrincipalOptionsMock).toHaveBeenLastCalledWith("PROJECT", "星河", 20, 20));
  });

  it("唯一精确匹配按 Enter 立即应用主体并刷新 URL 口径", async () => {
    const user = userEvent.setup();
    renderPanel("/usage?tab=overview&subject_type=PROJECT&period=MONTH");
    const search = screen.getByRole("searchbox", { name: "搜索用量主体" });
    await user.type(search, "星河项目");
    await waitFor(() => expect(usePrincipalOptionsMock).toHaveBeenLastCalledWith(
      "PROJECT", "星河项目", 0, 20,
    ));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`subject_id=${projectId}`));
    expect(resolvePrincipalExactMatchMock).toHaveBeenCalledWith("PROJECT", "星河项目");
  });

  it("点击查询与 Enter 使用相同的唯一主体确认，空搜索恢复全部主体", async () => {
    const user = userEvent.setup();
    renderPanel();
    const search = screen.getByRole("searchbox", { name: "搜索用量主体" });
    await user.type(search, "星河项目");
    expect(resolvePrincipalExactMatchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(resolvePrincipalExactMatchMock).toHaveBeenCalledWith("PROJECT", "星河项目"));
    await waitFor(() => expect(screen.getByRole("button", { name: "查询" })).toBeEnabled());
    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "查询" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("subject_id=");
  });

  it("无精确匹配时提示选择候选，单页候选不展示翻页按钮", async () => {
    resolvePrincipalExactMatchMock.mockResolvedValueOnce({ principal: null, match_count: 0 });
    usePrincipalOptionsMock.mockReturnValue({ isLoading: false, error: null, data: { principals: [], total: 0 } });
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole("searchbox", { name: "搜索用量主体" }), "不存在");
    await user.click(screen.getByRole("button", { name: "查询" }));
    expect(await screen.findByText(/没有完全匹配的主体/)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "主体下一页" })).not.toBeInTheDocument();
  });

  it("企业内存在分页同名主体时 Enter 不自动应用", async () => {
    resolvePrincipalExactMatchMock.mockResolvedValueOnce({ principal: null, match_count: 2 });
    const user = userEvent.setup();
    renderPanel("/usage?tab=overview&subject_type=PROJECT&period=MONTH");
    await user.type(screen.getByRole("searchbox", { name: "搜索用量主体" }), "重名项目");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(resolvePrincipalExactMatchMock).toHaveBeenCalledWith("PROJECT", "重名项目"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("subject_id=");
    expect(await screen.findByText(/找到同名主体/)).toHaveAttribute("role", "status");
  });

  it("精确匹配请求失败时给出可访问提示且不回写旧选择", async () => {
    resolvePrincipalExactMatchMock.mockRejectedValueOnce(new Error("network unavailable"));
    const user = userEvent.setup();
    renderPanel("/usage?tab=overview&subject_type=PROJECT&period=MONTH");
    await user.type(screen.getByRole("searchbox", { name: "搜索用量主体" }), "失败项目");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("精确匹配失败，请稍后重试或从列表选择"))
      .toHaveAttribute("role", "status");
    expect(screen.getByTestId("location")).not.toHaveTextContent("subject_id=");
  });

  it("POOL20-042：主体类型或搜索词变化后丢弃过期精确匹配响应", async () => {
    let release!: (value: { principal: { id: string; type: "PROJECT"; name: string }; match_count: number }) => void;
    resolvePrincipalExactMatchMock.mockReturnValueOnce(new Promise((resolve) => {
      release = resolve;
    }));
    const user = userEvent.setup();
    renderPanel("/usage?tab=overview&subject_type=PROJECT&period=MONTH");
    const search = screen.getByRole("searchbox", { name: "搜索用量主体" });
    await user.type(search, "旧项目");
    await user.keyboard("{Enter}");
    await user.selectOptions(screen.getByRole("combobox", { name: "用量主体类型" }), "EMPLOYEE");
    await user.clear(search);
    await user.type(search, "新员工");
    await act(async () => {
      release({ principal: { id: projectId, type: "PROJECT", name: "旧项目" }, match_count: 1 });
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("subject_type=EMPLOYEE"));
    expect(screen.getByTestId("location")).not.toHaveTextContent(`subject_id=${projectId}`);
  });

  it("覆盖加载、错误与空数据三态", () => {
    useUsageOverviewMock.mockReturnValueOnce({ isLoading: true, error: null, data: undefined, refetch: vi.fn() });
    const loading = renderPanel();
    expect(screen.getByLabelText("正在汇总周期用量…")).toBeInTheDocument();
    loading.unmount();

    useUsageOverviewMock.mockReturnValueOnce({ isLoading: false, error: new Error("概览加载失败"), data: undefined, refetch: vi.fn() });
    const failed = renderPanel();
    expect(screen.getByRole("alert")).toHaveTextContent("概览加载失败");
    failed.unmount();

    useUsageOverviewMock.mockReturnValueOnce({ isLoading: false, error: null, data: overview({ ranking: [], trend: [] }), refetch: vi.fn() });
    renderPanel();
    expect(screen.getByText("本周期暂无已结算用量")).toBeInTheDocument();
  });
});
