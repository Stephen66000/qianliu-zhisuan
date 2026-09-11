import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiClient from "../api/client";
import type { ProviderResourceItem } from "../api/types";
import { QUERY_KEYS } from "../api/hooks";
import { ResourcesPage } from "./Resources";
import { ProviderFinanceModeProvider } from "../feature-flags";
import type { ProviderFinanceMode } from "../api/types";

const postMock = vi.fn();
const patchMock = vi.fn();
const getMock = vi.fn();
const useProviderResourcesMock = vi.fn();
const useQuotaWindowsMock = vi.fn();
const useSyncQuotaWindowMock = vi.fn();
const useSupplyForecastsMock = vi.fn();
const useResourceUsageOverviewMock = vi.fn();
const useResourceRoutesMock = vi.fn();
const useRetireResourceRouteMock = vi.fn();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
    get: (...args: unknown[]) => getMock(...args),
  };
});

vi.mock("../api/hooks", () => ({
  QUERY_KEYS: {
    providerResources: ["provider-resources"],
    resourceRoutes: (id: string) => ["provider-resources", id, "routes"] as const,
    resourceUsageOverview: ["provider-resources", "usage-overview"],
    providers: ["providers"],
    supplyForecasts: ["supply-forecasts"],
    dashboard: ["dashboard"],
  },
  useProviderResources: () => useProviderResourcesMock(),
  useProviders: () => ({
    data: { providers: [{ id: "11111111-1111-4111-8111-111111111111", code: "kimi", name: "Kimi" }] },
    error: null,
  }),
  useSupplyForecasts: (enabled: boolean) => useSupplyForecastsMock(enabled),
  useResourceUsageOverview: () => useResourceUsageOverviewMock(),
  useQuotaWindows: () => useQuotaWindowsMock() ?? { data: { windows: [] } },
  useSyncQuotaWindow: () =>
    useSyncQuotaWindowMock() ?? { isPending: false, mutate: vi.fn(), isError: false },
  useResourceHealth: () => ({ data: null, isLoading: false, isError: false }),
  useResourceRoutes: (resourceId: string | null) =>
    useResourceRoutesMock(resourceId) ?? { data: { routes: [] }, isLoading: false },
  useRetireResourceRoute: (resourceId: string) =>
    useRetireResourceRouteMock(resourceId) ?? { isPending: false, mutate: vi.fn(), isError: false },
}));

vi.mock("../api/v2-hooks", () => ({
  useResourceUtilization: () => ({
    data: { month: "2026-08", generatedAt: "2026-08-23T00:00:00.000Z", resources: [] },
    isLoading: false, error: null, refetch: vi.fn(),
  }),
  useResourceMonthlyBudget: () => ({ data: { current: null, history: [] }, isLoading: false, error: null }),
  useSaveResourceMonthlyBudget: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

const resource: ProviderResourceItem = {
  id: "22222222-2222-4222-8222-222222222222",
  provider_id: "11111111-1111-4111-8111-111111111111",
  name: "Kimi 套餐",
  mode: "CODING_PLAN",
  credential_type: "SUBSCRIPTION_SESSION",
  credential_fingerprint: "1234567890abcdef",
  credential_version: 1,
  status: "ACTIVE",
  // POOL-031：资源健康详情字段（脱敏运行元数据）。
  consecutive_failures: 0,
  cooldown_until: null,
  last_probe_at: null,
  credential_refresh_status: "NOT_NEEDED",
  refresh_error_classification: null,
  credential_expires_at: null,
  resource_pool_id: null,
  upstream_models: ["kimi-k2"],
  concurrency_limit: 10,
  version: 3,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  operating_snapshot: null,
};

const discovery = {
  source: "PROVIDER_API",
  source_version: "kimi-list-models-v1",
  discovered_at: "2026-08-03T00:00:00.000Z",
  models: [
    { id: "kimi-k2", displayName: "Kimi K2", modelType: "CHAT", capabilities: ["chat", "stream"], source: "PROVIDER_API", compatible: true, unavailableReason: null },
    { id: "kimi-embedding", displayName: "Kimi Embedding", modelType: "EMBEDDING", capabilities: ["embedding"], source: "PROVIDER_API", compatible: false, unavailableReason: "Gateway 暂不承载向量模型" },
  ],
};

async function detectModels(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "检测可用模型" }));
  expect((await screen.findAllByText("kimi-k2")).length).toBeGreaterThan(0);
}

function renderPage(path = "/resources", financeMode: ProviderFinanceMode = "OFF") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <ProviderFinanceModeProvider value={financeMode}><ResourcesPage /></ProviderFinanceModeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  ), queryClient };
}

describe("厂商资源四 Tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [resource] }, error: null, isLoading: false, refetch: vi.fn(),
    });
    useSupplyForecastsMock.mockReturnValue({ data: { forecasts: [] }, error: null });
    useResourceUsageOverviewMock.mockReturnValue({
      data: { generatedAt: "2026-08-23T00:00:00.000Z", providerSummaries: [], modelDetails: [] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    useQuotaWindowsMock.mockReturnValue({ data: { windows: [] }, isLoading: false, isError: false });
  });

  it("默认资源利用，切换后只显示当前面板并按需启用供给预测", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "资源利用" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "登记资源" })).toBeInTheDocument();
    expect(useSupplyForecastsMock).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByRole("tab", { name: "用量总览" }));
    expect(screen.getByRole("tab", { name: "用量总览" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "登记资源" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "额度窗口" }));
    expect(screen.getByRole("heading", { name: "厂商额度窗口" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "供给与健康" }));
    expect(screen.getByRole("heading", { name: "供给预测" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "资源健康与异常" })).toBeInTheDocument();
    expect(useSupplyForecastsMock).toHaveBeenLastCalledWith(true);
  });

  it("旧健康锚点直接打开供给与健康", () => {
    renderPage(`/resources#health-${resource.id}`);
    expect(screen.getByRole("tab", { name: "供给与健康" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "资源健康与异常" })).toBeInTheDocument();
  });

  it("供给预测速度和覆盖时长最多显示两位小数", () => {
    useSupplyForecastsMock.mockReturnValue({ data: { forecasts: [{
      id: "forecast-1", provider_resource_id: resource.id, resource_name: resource.name,
      rate_1h: null, rate_24h: "0.08795916", rate_7d: "595904.78756471",
      forecast_exhaust_at: null, next_recover_at: null, coverage_hours: "2413.38532146",
      remaining_quota: "100", confidence: "MEDIUM", data_points: 2,
      not_calculable_reason: "no_consumption_rate", snapshot_at: "2026-09-05T00:00:00Z",
    }] }, error: null });
    renderPage("/resources?tab=supply-health");
    expect(screen.getByText("— / 0.09 / 595,904.79")).toBeInTheDocument();
    expect(screen.getByText("2,413.39h")).toBeInTheDocument();
    expect(screen.queryByText(/0\.08795916|2413\.38532146/)).not.toBeInTheDocument();
  });

  it("DARK增加充值与订阅Tab，统一充值订阅入口且入账保持关闭", async () => {
    const user = userEvent.setup();
    getMock.mockImplementation(async (path: string) => path.startsWith("/provider-finance/summary")
      ? { month: "2026-09", timezone: "Asia/Shanghai", cashOutflowCny: "600",
        apiRecharges: [{ currency: "CNY", amount: "600" }], apiOperatingCosts: [],
        codingPlanOrders: [], codingPlanFixedCostCny: "0", operatingCostCny: "0",
        operatingCostByCurrency: [], currentApiBalances: [{ currency: "CNY", amount: "498.39" }],
        currentApiBalancesComplete: true, complete: true, gaps: [] }
      : path.includes("/finance/events") ? { items: [], total: 0 } : { periods: [] });
    renderPage("/resources", "DARK");
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    await user.click(screen.getByRole("tab", { name: "充值与订阅" }));
    expect(await screen.findByText("人民币实付")).toBeInTheDocument();
    expect(screen.getByText("当前 API 余额")).toBeInTheDocument();
    expect(screen.getByText("CNY 498.39")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "充值／订阅" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增订阅" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "充值／订阅" }));
    await user.click(screen.getByRole("button", { name: "Coding Plan" }));
    expect(screen.getByLabelText("厂商产品模型")).toHaveValue(resource.id);
    expect(screen.getByRole("button", { name: "入账确认" })).toBeDisabled();
  });

  it("ACTIVE从充值订阅按钮登记Coding Plan并包含自然月周期入口", async () => {
    const user = userEvent.setup();
    getMock.mockImplementation(async (path: string) => path.startsWith("/provider-finance/summary")
      ? { month: "2026-09", timezone: "Asia/Shanghai", cashOutflowCny: "0",
        apiRecharges: [], apiOperatingCosts: [], codingPlanOrders: [],
        codingPlanFixedCostCny: "0", operatingCostCny: "0",
        operatingCostByCurrency: [], currentApiBalances: [],
        currentApiBalancesComplete: true, complete: true, gaps: [] }
      : path.includes("/finance/events") ? { items: [], total: 0 } : { periods: [] });
    postMock.mockResolvedValue({ event: { id: "event-1" }, periodId: "period-1" });
    renderPage("/resources?tab=finance", "ACTIVE");
    await user.click(screen.getByRole("button", { name: "充值／订阅" }));
    await user.click(screen.getByRole("button", { name: "Coding Plan" }));
    await user.type(screen.getByLabelText("订阅金额"), "199");
    await user.type(screen.getByLabelText("人民币实付"), "199");
    await user.type(screen.getByLabelText("服务周期开始日"), "2026-09-19");
    await user.click(screen.getByRole("button", { name: "入账确认" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      `/provider-resources/${resource.id}/finance/subscriptions`,
      expect.objectContaining({ kind: "RENEWAL", product_name: "Kimi 套餐",
        account_amount: "199.00", cash_paid_cny: "199.00",
        service_period_start: "2026-09-19" }),
    ));
  });
});

describe("POOL-010 厂商经营快照", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSupplyForecastsMock.mockReturnValue({ data: { forecasts: [] }, error: null });
    useResourceUsageOverviewMock.mockReturnValue({
      data: { generatedAt: "2026-08-23T00:00:00.000Z", providerSummaries: [], modelDetails: [] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [resource] },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    postMock.mockImplementation(async (path: string) =>
      path.includes("model-discovery") || path.includes("models/sync")
        ? discovery
        : path.includes("/onboard")
          ? { result: { resourceId: resource.id, models: [] } }
          : { resource });
    patchMock.mockResolvedValue({ resource });
    getMock.mockResolvedValue({
      snapshots: [
        {
          id: "s2", provider_resource_id: resource.id, version: 2, source: "ADMIN",
          collected_at: "2026-07-31T02:00:00.000Z", total_quota: "100",
          used_quota: "30", remaining_quota: "70", quota_unit: "TOKEN",
          current_balance: null, current_period_cost: null, currency: "CNY",
        },
        {
          id: "s1", provider_resource_id: resource.id, version: 1, source: "ADMIN",
          collected_at: "2026-07-01T02:00:00.000Z", total_quota: "100",
          used_quota: "10", remaining_quota: "90", quota_unit: "TOKEN",
          current_balance: null, current_period_cost: null, currency: "CNY",
        },
      ],
    });
  });

  it("未知厂商数据明确显示未录入/未同步", () => {
    renderPage();
    expect(screen.getByText("未录入/未同步")).toBeInTheDocument();
  });

  it("创建套餐只录总额度与重置规则，系统字段不允许手填", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "登记资源" }));
    await user.selectOptions(screen.getByLabelText("厂商"), resource.provider_id);
    await user.type(screen.getByLabelText("资源名称"), "新套餐");
    await user.type(screen.getByLabelText("上游凭证"), "secret");
    await user.selectOptions(screen.getByLabelText("模式"), "CODING_PLAN");
    await detectModels(user);
    await user.type(screen.getByLabelText("厂商总额度"), "30000000");
    expect(screen.getByLabelText("厂商总额度")).toHaveValue("30,000,000");
    expect(screen.queryByLabelText("套餐费用")).not.toBeInTheDocument();
    expect(screen.getByText(/订阅金额和服务周期在“充值与订阅”中登记/)).toBeInTheDocument();
    expect(screen.queryByLabelText("厂商已用额度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("厂商剩余额度")).not.toBeInTheDocument();
    expect(screen.getByText(/已用额度取当前周期内该资源的账本扣减/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "每季" })).toHaveValue("QUARTERLY");
    expect(screen.getByRole("option", { name: "每年" })).toHaveValue("YEARLY");
    await user.selectOptions(screen.getByLabelText("重置周期"), "QUARTERLY");
    await user.type(screen.getByLabelText("重置日期"), "2026-08-01T00:00");
    await user.click(screen.getByRole("button", { name: "确认接入" }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const onboardPayload = postMock.mock.calls.find(([path]) => path === "/provider-resources/onboard")?.[1];
    expect(onboardPayload).toMatchObject({
      selected_model_ids: ["kimi-k2"],
      operating_snapshot: {
        source: "ADMIN",
        total_quota: "30000000",
        quota_unit: "TOKEN",
        package_cost: null,
        effective_from: null,
        effective_until: null,
        reset_cycle: "QUARTERLY",
        reset_anchor_at: "2026-07-31T16:00:00.000Z",
      },
    });
    expect(onboardPayload.operating_snapshot).not.toHaveProperty("used_quota");
    expect(onboardPayload.operating_snapshot).not.toHaveProperty("remaining_quota");
    expect(onboardPayload.operating_snapshot).not.toHaveProperty("next_reset_at");
  });

  it("资源登记不再提供资金入口，套餐只保留额度配置", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "登记资源" }));
    expect(screen.queryByLabelText("当前余额")).not.toBeInTheDocument();
    expect(screen.getByText(/API 期初、充值、余额和费用统一由“充值与订阅”资金账本管理/)).toBeInTheDocument();
    expect(screen.queryByLabelText("厂商总额度")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("模式"), "CODING_PLAN");
    expect(screen.getByLabelText("厂商总额度")).toBeInTheDocument();
    expect(screen.queryByLabelText("厂商已用额度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("当前余额")).not.toBeInTheDocument();
  });

  it("套餐切回 API 后可正常登记，隐藏的重置周期不阻塞提交", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "登记资源" }));
    await user.selectOptions(screen.getByLabelText("厂商"), resource.provider_id);
    await user.type(screen.getByLabelText("资源名称"), "新 API");
    await user.type(screen.getByLabelText("上游凭证"), "secret");
    await user.selectOptions(screen.getByLabelText("模式"), "CODING_PLAN");
    await user.selectOptions(screen.getByLabelText("重置周期"), "MONTHLY");
    await user.selectOptions(screen.getByLabelText("模式"), "API");
    await detectModels(user);
    await user.click(screen.getByRole("button", { name: "确认接入" }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls.find(([path]) => path === "/provider-resources/onboard")?.[1]).toMatchObject({
      mode: "API",
      operating_snapshot: undefined,
    });
  });

  it("PATCH 使用 expected_version 保存配置，并展示 v2/v1 历史", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "更新额度配置" }));
    expect(await screen.findByText("v2 · ADMIN")).toBeInTheDocument();
    expect(screen.getByText("v1 · ADMIN")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("厂商总额度"));
    await user.type(screen.getByLabelText("厂商总额度"), "100");
    await user.selectOptions(screen.getByLabelText("重置周期"), "MONTHLY");
    await user.type(screen.getByLabelText("重置日期"), "2026-08-01T00:00");
    expect(screen.getByText("历史修改记录（倒序）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存额度配置" }));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(patchMock).toHaveBeenCalledWith(
      `/provider-resources/${resource.id}`,
      expect.objectContaining({
        expected_version: 3,
        operating_snapshot: expect.objectContaining({
          total_quota: "100",
          reset_cycle: "MONTHLY",
        }),
      }),
    );
    const payload = patchMock.mock.calls[0]?.[1].operating_snapshot;
    expect(payload).not.toHaveProperty("used_quota");
    expect(payload).not.toHaveProperty("remaining_quota");
    expect(payload).not.toHaveProperty("next_reset_at");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["resource-utilization"],
    }));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: QUERY_KEYS.resourceUsageOverview,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: QUERY_KEYS.supplyForecasts,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["provider-finance"],
    });
  });

  it("额度快照不再包含套餐费用和服务周期字段", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "更新额度配置" }));
    await user.type(screen.getByLabelText("厂商总额度"), "100");
    await user.click(screen.getByRole("button", { name: "保存额度配置" }));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const payload = patchMock.mock.calls[0]?.[1].operating_snapshot;
    expect(payload).toMatchObject({ package_cost: null, effective_from: null,
      effective_until: null });
  });

  it("API旧快照金额不再显示或提供编辑入口", () => {
    useProviderResourcesMock.mockReturnValue({
      data: {
        resources: [{
          ...resource,
          name: "API 金额资源",
          mode: "API",
          operating_snapshot: {
            id: "snapshot-api", provider_resource_id: resource.id, version: 1,
            source: "ADMIN", collected_at: "2026-08-03T00:00:00.000Z", currency: "CNY",
            recharge_amount: "109.41000000", current_balance: "68.00000000",
            cumulative_cost: "47.41000000", current_period_cost: "47.41000000",
            cost_period_start: null, cost_period_end: null, balance_updated_at: null,
            package_name: null, package_cost: null, total_quota: null, quota_unit: null,
            used_quota: null, remaining_quota: null, effective_from: null, effective_until: null,
            reset_cycle: null, reset_anchor_at: null, reset_timezone: null,
            usage_calculation: "MANUAL_SNAPSHOT", next_reset_at: null,
          },
        }],
      },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("资金账本未启用")).toBeInTheDocument();
    expect(screen.queryByText("充值 CNY 109.41")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新经营数据" })).not.toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe("厂商资源基础信息编辑", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSupplyForecastsMock.mockReturnValue({ data: { forecasts: [] }, error: null });
    useResourceUsageOverviewMock.mockReturnValue({
      data: { generatedAt: "2026-08-23T00:00:00.000Z", providerSummaries: [], modelDetails: [] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [resource] },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    patchMock.mockResolvedValue({ resource });
  });

  it("保持资源 ID、凭证和已发现模型不变，只更新名称与并发限制", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    const name = screen.getByLabelText("资源名称");
    await user.clear(name);
    await user.type(name, "Kimi 新套餐");
    expect(screen.queryByLabelText("上游模型")).not.toBeInTheDocument();
    const concurrency = screen.getByLabelText("并发上限");
    await user.clear(concurrency);
    await user.type(concurrency, "16");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        `/provider-resources/${resource.id}`,
        {
          expected_version: 3,
          name: "Kimi 新套餐",
          concurrency_limit: 16,
        },
      );
    });
    expect(screen.queryByDisplayValue(resource.credential_fingerprint ?? "")).not.toBeInTheDocument();
  });
});

describe("POOL-027 模型发现向导", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSupplyForecastsMock.mockReturnValue({ data: { forecasts: [] }, error: null });
    useResourceUsageOverviewMock.mockReturnValue({
      data: { generatedAt: "2026-08-23T00:00:00.000Z", providerSummaries: [], modelDetails: [] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [resource] }, error: null, isLoading: false, refetch: vi.fn(),
    });
    postMock.mockImplementation(async (path: string) =>
      path.includes("model-discovery") || path.includes("models/sync")
        ? discovery
        : path.includes("models/confirm") ? { models: [{
          alias: "ql-kimi-k2", upstreamModel: "kimi-k2", status: "PENDING_CONFIG",
        }] } : { result: { resourceId: resource.id } });
  });

  it("检测后默认只全选兼容模型，向量模型不可误选", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "登记资源" }));
    await user.selectOptions(screen.getByLabelText("厂商"), resource.provider_id);
    await user.type(screen.getByLabelText("资源名称"), "Kimi API");
    await user.type(screen.getByLabelText("上游凭证"), "secret");
    await detectModels(user);
    expect(screen.getByRole("checkbox", { name: /kimi-k2 chat、stream/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /kimi-embedding/ })).toBeDisabled();
    expect(screen.getByText("Gateway 暂不承载向量模型")).toBeInTheDocument();
  });

  it("已有资源可同步并确认加入，不再提供自由文本模型入口", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "同步模型" }));
    // 页面另含「厂商额度窗口」的「立即同步」按钮（POOL-032），限定到模型同步面板内点击。
    const syncModelsSection = screen.getByRole("heading", { name: /同步「Kimi 套餐」可用模型/ })
      .closest("section")!;
    await user.click(within(syncModelsSection).getByRole("button", { name: "立即同步" }));
    expect(await screen.findByText("可加入")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认加入所选模型" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      `/provider-resources/${resource.id}/models/confirm`,
      { selected_model_ids: ["kimi-k2"] },
    ));
    expect(await screen.findByText("已确认加入 1 个模型")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "继续配置" })).toHaveAttribute("href", "/quota-rules");
    expect(screen.queryByText("多个模型用英文逗号分隔")).not.toBeInTheDocument();
  });

  it("已有模型支持在厂商资源内直接一键下架，完成路由归档与规则联动清理", async () => {
    const user = userEvent.setup();
    const routeItem = {
      id: "route-111",
      enterprise_id: "enterprise-1",
      unified_model_id: "model-111",
      unified_model_name: "kimi-k2",
      model_alias: "kimi-k2-alias",
      upstream_model: "kimi-k2",
      model_type: "CHAT",
      capabilities: ["chat"],
      protocol_type: "OPENAI",
      priority: 100,
      weight: 100,
      status: "ACTIVE" as const,
      archived_at: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      has_active_billing_rule: true,
    };
    useResourceRoutesMock.mockReturnValue({
      data: { routes: [routeItem] },
      isLoading: false,
    });
    const mutateRetireMock = vi.fn((_routeId: string, options?: { onSuccess?: (res: unknown) => void }) => {
      options?.onSuccess?.({
        route_id: "route-111",
        unified_model_id: "model-111",
        unified_model_archived: true,
        archived_billing_rules: 1,
        disabled_assignments: 2,
      });
    });
    useRetireResourceRouteMock.mockReturnValue({
      isPending: false,
      mutate: mutateRetireMock,
      error: null,
    });

    renderPage();
    await user.click(screen.getByRole("button", { name: "同步模型" }));

    // 看到已接入模型及正常服务标签
    expect(screen.getByText("kimi-k2-alias")).toBeInTheDocument();
    expect(screen.getByText("正常服务")).toBeInTheDocument();

    // 点击下架模型
    await user.click(screen.getByRole("button", { name: "下架模型" }));
    expect(screen.getByText(/确认下架模型「kimi-k2-alias」？/)).toBeInTheDocument();

    // 点击确认下架
    await user.click(screen.getByRole("button", { name: "确认下架" }));
    expect(mutateRetireMock).toHaveBeenCalledWith("route-111", expect.any(Object));
    expect(await screen.findByText(/模型「kimi-k2-alias」已成功下架！/)).toBeInTheDocument();
  });
});

describe("POOL-032 厂商额度窗口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSupplyForecastsMock.mockReturnValue({ data: { forecasts: [] }, error: null });
    useResourceUsageOverviewMock.mockReturnValue({
      data: { generatedAt: "2026-08-23T00:00:00.000Z", providerSummaries: [], modelDetails: [] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [resource] }, error: null, isLoading: false, refetch: vi.fn(),
    });
    useQuotaWindowsMock.mockReturnValue({ data: { windows: [] } });
    useSyncQuotaWindowMock.mockReturnValue({ isPending: false, mutate: vi.fn(), isError: false });
  });

  it("缺失字段显示厂商未提供，绝不显示 0；UNSUPPORTED 不渲染数值", () => {
    useQuotaWindowsMock.mockReturnValue({
      data: {
        windows: [
          {
            id: "w1", provider_resource_id: resource.id, window_type: "WEEKLY",
            limit_value: "100", used_value: "60", remaining_value: "40",
            unit: "POINT", ratio: "0.6", reset_at: "2026-08-10T03:00:00.000Z",
            provider_data_at: "2026-08-07T02:33:42.000Z", collected_at: "2026-08-07T02:33:42.000Z",
            source: "PROVIDER_SYNC", adapter_version: "pool032-v1", sync_status: "SUCCESS",
            sync_error_code: null, last_success_at: "2026-08-07T02:33:42.000Z",
          },
          {
            id: "w2", provider_resource_id: resource.id, window_type: "FIVE_HOUR",
            limit_value: null, used_value: null, remaining_value: null, unit: null, ratio: null,
            reset_at: null, provider_data_at: "2026-08-07T02:33:42.000Z",
            collected_at: "2026-08-07T02:33:42.000Z", source: "PROVIDER_SYNC",
            adapter_version: "pool032-v1", sync_status: "UNSUPPORTED",
            sync_error_code: null, last_success_at: "2026-08-07T02:33:42.000Z",
          },
        ],
      },
    });
    renderPage("/resources?tab=quota-windows");
    // 周额度展示已用 60。
    expect(screen.getByText("周额度")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    // 5 小时窗口不支持 → 显示厂商未提供，不出现数值。
    expect(screen.getByText("滚动 5 小时额度")).toBeInTheDocument();
    expect(screen.getByText("厂商未提供实时查询")).toBeInTheDocument();
    // 绝不出现 0 作为已用数值。
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
  });

  it("点击立即同步触发 POST /quota-sync", async () => {
    const mutate = vi.fn();
    useSyncQuotaWindowMock.mockReturnValue({ isPending: false, mutate, isError: false });
    renderPage("/resources?tab=quota-windows");
    await userEvent.click(screen.getByRole("button", { name: "立即同步" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("STALE 保留上次成功快照并显示过期提示与失败原因", () => {
    useQuotaWindowsMock.mockReturnValue({
      data: {
        windows: [
          {
            id: "w1", provider_resource_id: resource.id, window_type: "WEEKLY",
            limit_value: "100", used_value: "60", remaining_value: "40",
            unit: "POINT", ratio: "0.6", reset_at: "2026-08-10T03:00:00.000Z",
            provider_data_at: "2026-08-07T00:00:00.000Z", collected_at: "2026-08-07T02:33:42.000Z",
            source: "PROVIDER_SYNC", adapter_version: "pool032-v1", sync_status: "STALE",
            sync_error_code: "RATE_LIMITED", last_success_at: "2026-08-07T00:00:12.000Z",
          },
        ],
      },
    });
    renderPage("/resources?tab=quota-windows");
    // 保鲜：数值仍在（60），同时显示过期与限流原因。
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText(/数据已过期/)).toBeInTheDocument();
    expect(screen.getByText(/厂商返回 429（限流）/)).toBeInTheDocument();
  });

  it("窗口额度最多显示两位小数", () => {
    useQuotaWindowsMock.mockReturnValue({ data: { windows: [{
      id: "decimal-window", provider_resource_id: resource.id, window_type: "WEEKLY",
      limit_value: "100.00000000", used_value: "65.12600000", remaining_value: "34.87400000",
      unit: "POINT", ratio: "0.65126", reset_at: null, provider_data_at: "2026-09-05T00:00:00Z",
      collected_at: "2026-09-05T00:00:00Z", source: "PROVIDER_SYNC", adapter_version: "test",
      sync_status: "SUCCESS", sync_error_code: null, last_success_at: "2026-09-05T00:00:00Z",
    }] } });
    renderPage("/resources?tab=quota-windows");
    expect(screen.getAllByText("65.13").length).toBeGreaterThan(0);
    expect(screen.getByText("/ 100")).toBeInTheDocument();
    expect(screen.getByText(/剩余 34\.87/)).toBeInTheDocument();
    expect(screen.queryByText(/65\.126|34\.874/)).not.toBeInTheDocument();
  });

  it("从未同步显示未同步与「从未成功同步」", () => {
    useQuotaWindowsMock.mockReturnValue({ data: { windows: [] } });
    renderPage("/resources?tab=quota-windows");
    expect(screen.getByText(/未同步 — 点击右上「立即同步」首次拉取厂商额度/)).toBeInTheDocument();
    expect(screen.getByText("○ 从未成功同步")).toBeInTheDocument();
  });

  it("非 Coding Plan（API）资源显示不适用，不展示窗口", () => {
    useProviderResourcesMock.mockReturnValue({
      data: {
        resources: [
          { ...resource, name: "DeepSeek API", mode: "API" as const },
        ],
      },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    renderPage("/resources?tab=quota-windows");
    expect(screen.getByText("不适用 — 非 Coding Plan 套餐资源，无厂商窗口额度。")).toBeInTheDocument();
    expect(screen.queryByText("周额度")).not.toBeInTheDocument();
  });
});
