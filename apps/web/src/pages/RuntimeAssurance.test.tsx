import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertItem } from "../api/types";
import { RuntimeAssurancePage } from "./RuntimeAssurance";

const postMock = vi.fn();
const invalidateMock = vi.fn();
const hookMocks = vi.hoisted(() => ({
  alerts: vi.fn(),
  principals: vi.fn(),
  resources: vi.fn(),
  providers: vi.fn(),
}));
const now = new Date();
const thisMonth = new Date(
  now.getFullYear(),
  now.getMonth(),
  7,
  14,
  32,
).toISOString();
const previousMonth = new Date(
  now.getFullYear(),
  now.getMonth() - 1,
  6,
  10,
  18,
).toISOString();
const previousMonthKey = `${new Date(previousMonth).getFullYear()}-${String(
  new Date(previousMonth).getMonth() + 1,
).padStart(2, "0")}`;

const alerts: AlertItem[] = [
  {
    id: "alert-kimi",
    alertKey: "CREDENTIAL_INVALID:resource:r1",
    domain: "CREDENTIAL_INVALID",
    signal: "credential_invalid",
    severity: "HIGH",
    title: "资源凭证失效",
    detail: "厂商返回凭证无效",
    resourceId: "r1",
    principalId: "p1",
    aiRequestId: "req-1",
    status: "OPEN",
    firstSeenAt: previousMonth,
    lastSeenAt: thisMonth,
    resolvedAt: null,
    resolutionNote: null,
    sourceClearedAt: null,
    resolvedBy: null,
  },
  {
    id: "alert-zhipu",
    alertKey: "RESOURCE_UNAVAILABLE:resource:r2",
    domain: "RESOURCE_UNAVAILABLE",
    signal: "resource_unavailable",
    severity: "MEDIUM",
    title: "上游请求持续超时",
    detail: "连续请求超过 60 秒",
    resourceId: "r2",
    principalId: "p2",
    aiRequestId: null,
    status: "AUTO_RESOLVED",
    firstSeenAt: previousMonth,
    lastSeenAt: previousMonth,
    resolvedAt: previousMonth,
    resolutionNote: null,
    sourceClearedAt: previousMonth,
    resolvedBy: null,
  },
  {
    id: "alert-handled",
    alertKey: "QUOTA_ANOMALY:system:handled",
    domain: "QUOTA_ANOMALY",
    signal: "ledger_anomaly",
    severity: "LOW",
    title: "账本异常已处置",
    detail: null,
    resourceId: null,
    principalId: null,
    aiRequestId: null,
    status: "RESOLVED",
    firstSeenAt: thisMonth,
    lastSeenAt: thisMonth,
    resolvedAt: thisMonth,
    resolutionNote: "管理员已核对",
    sourceClearedAt: thisMonth,
    resolvedBy: "admin-current",
  },
];

vi.mock("../api/client", () => ({
  post: (...args: unknown[]) => postMock(...args),
}));

vi.mock("../api/hooks", () => ({
  QUERY_KEYS: { alerts: ["alerts"] },
  useAlerts: () => hookMocks.alerts(),
  usePrincipals: (archived: string) => hookMocks.principals(archived),
  useProviderResources: () => hookMocks.resources(),
  useProviders: () => hookMocks.providers(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateMock }),
  };
});

vi.mock("./RequestDrilldown", () => ({
  RequestDrilldown: ({ requestId }: { requestId: string }) => (
    <div data-testid="request-detail">{requestId}</div>
  ),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RuntimeAssurancePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("运行保障异常中心", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ ok: true });
    hookMocks.alerts.mockReturnValue({
      data: { alerts: [alerts[0]], history: [alerts[1], alerts[2]] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    hookMocks.principals.mockImplementation((archived: string) => ({
      data: {
        principals:
          archived === "all"
            ? [
                { id: "p1", name: "周星" },
                { id: "p2", name: "未来医生" },
              ]
            : [],
      },
      error: null,
      refetch: vi.fn(),
    }));
    hookMocks.resources.mockReturnValue({
      data: {
        resources: [
          { id: "r1", provider_id: "vendor-kimi", name: "Kimi 主账号" },
          { id: "r2", provider_id: "vendor-zhipu", name: "智谱主账号" },
        ],
      },
      error: null,
      refetch: vi.fn(),
    });
    hookMocks.providers.mockReturnValue({
      data: {
        providers: [
          { id: "vendor-kimi", name: "Kimi", code: "kimi" },
          { id: "vendor-zhipu", name: "智谱", code: "zhipu" },
        ],
      },
      error: null,
      refetch: vi.fn(),
    });
  });

  it("只展示异常中心，并将通知与人员标记为暂缓", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "异常中心" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /通知与人员/ })).toBeDisabled();
    expect(
      screen.queryByRole("tab", { name: "运行态势" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "可用性规则" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "熔断事件" }),
    ).not.toBeInTheDocument();
  });

  it("按月份、主体、厂商和搜索词组合筛选", async () => {
    const user = userEvent.setup();
    renderPage();
    // 首次发生在上月、当前月仍出现的异常必须继续显示。
    expect(screen.getByText("资源凭证失效")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("异常使用主体"), "p2");
    expect(screen.queryByText("资源凭证失效")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("异常使用主体"), "");
    fireEvent.change(screen.getByLabelText("异常月份"), {
      target: { value: previousMonthKey },
    });
    expect(screen.getByText("上游请求持续超时")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("异常厂商"), "vendor-kimi");
    expect(screen.getByText("资源凭证失效")).toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索异常"), "不存在的错误");
    expect(screen.getByText("当前筛选条件下没有异常")).toBeInTheDocument();
  });

  it("每条异常直接通过是否处理字段保存", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(
      screen.getByLabelText("资源凭证失效 是否处理"),
      "yes",
    );
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/alerts/disposition", {
        alert_key: "CREDENTIAL_INVALID:resource:r1",
        status: "RESOLVED",
      }),
    );
    await waitFor(() =>
      expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ["alerts"] }),
    );
    expect(
      screen.queryByRole("button", { name: "标记已处理" }),
    ).not.toBeInTheDocument();
  });

  it("查看详情打开右侧抽屉并展示关联请求", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = screen.getByText("资源凭证失效").closest("tr");
    if (!row) throw new Error("未找到凭证失效异常行");
    await user.click(within(row).getByRole("button", { name: /查看/ }));
    const dialog = screen.getByRole("dialog", { name: "异常详情" });
    expect(within(dialog).getByText("资源凭证失效")).toBeInTheDocument();
    expect(within(dialog).getByText("周星")).toBeInTheDocument();
    expect(within(dialog).getByTestId("request-detail")).toHaveTextContent(
      "req-1",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("详情是否处理"),
      "yes",
    );
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    await user.click(
      within(dialog).getByRole("button", { name: "关闭异常详情" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "异常详情" }),
    ).not.toBeInTheDocument();
  });

  it("自动恢复异常保持未人工处理，并在详情显示恢复时间", async () => {
    const user = userEvent.setup();
    renderPage();
    fireEvent.change(screen.getByLabelText("异常月份"), {
      target: { value: previousMonthKey },
    });
    const row = screen.getByText("上游请求持续超时").closest("tr");
    expect(row).not.toBeNull();
    if (!row) throw new Error("未找到自动恢复异常行");
    expect(within(row).getByLabelText("上游请求持续超时 是否处理")).toHaveValue(
      "no",
    );
    expect(within(row).getByText("已自动恢复")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /查看/ }));
    const dialog = screen.getByRole("dialog", { name: "异常详情" });
    expect(
      within(dialog).getByText("后台已恢复", { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByTestId("request-detail"),
    ).not.toBeInTheDocument();
  });

  it("详情区分人工处理与后台恢复，并展示处置备注", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = screen.getByText("账本异常已处置").closest("tr");
    if (!row) throw new Error("未找到已处置异常行");
    expect(within(row).getByLabelText("账本异常已处置 是否处理")).toHaveValue(
      "yes",
    );
    expect(within(row).getByText("已自动恢复")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /查看/ }));
    const dialog = screen.getByRole("dialog", { name: "异常详情" });
    expect(within(dialog).getByText("管理员已核对")).toBeInTheDocument();
    expect(within(dialog).getByText("系统级")).toBeInTheDocument();
  });

  it("关联查询失败时保留异常并明确提示失败归属", async () => {
    const principalRefetch = vi.fn();
    const resourceRefetch = vi.fn();
    const providerRefetch = vi.fn();
    hookMocks.principals.mockReturnValue({
      data: undefined,
      error: new Error("principal failed"),
      refetch: principalRefetch,
    });
    hookMocks.resources.mockReturnValue({
      data: undefined,
      error: new Error("resource failed"),
      refetch: resourceRefetch,
    });
    hookMocks.providers.mockReturnValue({
      data: undefined,
      error: new Error("provider failed"),
      refetch: providerRefetch,
    });
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("关联信息加载失败");
    expect(screen.getByText("资源凭证失效")).toBeInTheDocument();
    expect(screen.getByText("主体信息加载失败")).toBeInTheDocument();
    expect(screen.getByText("资源信息加载失败")).toBeInTheDocument();
    expect(screen.getByLabelText("异常使用主体")).toBeDisabled();
    expect(screen.getByLabelText("异常厂商")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试关联信息" }));
    expect(principalRefetch).toHaveBeenCalled();
    expect(resourceRefetch).toHaveBeenCalled();
    expect(providerRefetch).toHaveBeenCalled();
  });

  it("加载、失败和保存失败都有明确反馈", async () => {
    const refetch = vi.fn();
    hookMocks.alerts.mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      error: null,
      refetch,
    });
    const first = renderPage();
    expect(screen.getByText("正在加载异常…")).toBeInTheDocument();
    first.unmount();

    hookMocks.alerts.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error("load failed"),
      refetch,
    });
    const user = userEvent.setup();
    const second = renderPage();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalled();
    second.unmount();

    postMock.mockRejectedValueOnce(new Error("save failed"));
    renderPage();
    await user.selectOptions(
      screen.getByLabelText("资源凭证失效 是否处理"),
      "yes",
    );
    expect(
      await screen.findByText("处理状态保存失败，请重试。"),
    ).toBeInTheDocument();
  });
});
