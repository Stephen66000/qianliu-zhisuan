import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiClient from "../api/client";
import type { ProviderResourceItem } from "../api/types";
import { ResourcesPage } from "./Resources";

const postMock = vi.fn();
const patchMock = vi.fn();
const getMock = vi.fn();
const useProviderResourcesMock = vi.fn();
const useQuotaWindowsMock = vi.fn();
const useSyncQuotaWindowMock = vi.fn();

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
    providers: ["providers"],
    supplyForecasts: ["supply-forecasts"],
    dashboard: ["dashboard"],
  },
  useProviderResources: () => useProviderResourcesMock(),
  useProviders: () => ({
    data: { providers: [{ id: "11111111-1111-4111-8111-111111111111", code: "kimi", name: "Kimi" }] },
    error: null,
  }),
  useSupplyForecasts: () => ({ data: { forecasts: [] }, error: null }),
  useQuotaWindows: () => useQuotaWindowsMock() ?? { data: { windows: [] } },
  useSyncQuotaWindow: () =>
    useSyncQuotaWindowMock() ?? { isPending: false, mutate: vi.fn(), isError: false },
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

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ResourcesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("POOL-010 厂商经营快照", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    await user.type(screen.getByLabelText("生效时间"), "2026-07-01T00:00");
    await user.type(screen.getByLabelText("套餐费用"), "299.4");
    await user.tab();
    expect(screen.getByLabelText("套餐费用")).toHaveValue("299.40");
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
        package_cost: "299.40",
        reset_cycle: "QUARTERLY",
        reset_anchor_at: "2026-07-31T16:00:00.000Z",
      },
    });
    expect(onboardPayload.operating_snapshot).not.toHaveProperty("used_quota");
    expect(onboardPayload.operating_snapshot).not.toHaveProperty("remaining_quota");
    expect(onboardPayload.operating_snapshot).not.toHaveProperty("next_reset_at");
  });

  it("API 与套餐表单只展示各自经营字段", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "登记资源" }));
    expect(screen.getByLabelText("当前余额")).toBeInTheDocument();
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

  it("PATCH 使用 expected_version 追加快照，并展示 v2/v1 历史", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "更新套餐配置" }));
    expect(await screen.findByText("v2 · ADMIN")).toBeInTheDocument();
    expect(screen.getByText("v1 · ADMIN")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("厂商总额度"));
    await user.type(screen.getByLabelText("厂商总额度"), "100");
    await user.type(screen.getByLabelText("套餐生效时间"), "2026-07-01T00:00");
    await user.selectOptions(screen.getByLabelText("重置周期"), "MONTHLY");
    await user.type(screen.getByLabelText("重置日期"), "2026-08-01T00:00");
    await user.click(screen.getByRole("button", { name: "追加快照" }));
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
  });

  it("套餐失效时间不得早于或等于生效时间", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "更新套餐配置" }));
    await user.type(screen.getByLabelText("厂商总额度"), "100");
    await user.type(screen.getByLabelText("套餐生效时间"), "2026-08-03T11:49");
    await user.type(screen.getByLabelText("套餐失效时间"), "2026-08-03T11:49");
    await user.click(screen.getByRole("button", { name: "追加快照" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "套餐失效时间必须晚于生效时间",
    );
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("金额输入拒绝三位小数且列表只展示两位", async () => {
    const user = userEvent.setup();
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
    expect(screen.getByText(/充值 CNY 109\.41 \/ 余额 68\.00 \/ 本期费用 47\.41/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更新经营数据" }));
    const balance = screen.getByLabelText("当前余额");
    expect(balance).toHaveValue("68.00");
    await user.clear(balance);
    await user.type(balance, "68.001");
    await user.click(screen.getByRole("button", { name: "追加快照" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前余额：请输入非负金额，最多保留两位小数");
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe("厂商资源基础信息编辑", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [resource] }, error: null, isLoading: false, refetch: vi.fn(),
    });
    postMock.mockImplementation(async (path: string) =>
      path.includes("model-discovery") || path.includes("models/sync")
        ? discovery
        : path.includes("models/confirm") ? { models: [] } : { result: { resourceId: resource.id } });
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
    expect(screen.queryByText("多个模型用英文逗号分隔")).not.toBeInTheDocument();
  });
});

describe("POOL-032 厂商额度窗口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    renderPage();
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
    renderPage();
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
    renderPage();
    // 保鲜：数值仍在（60），同时显示过期与限流原因。
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText(/数据已过期/)).toBeInTheDocument();
    expect(screen.getByText(/厂商返回 429（限流）/)).toBeInTheDocument();
  });

  it("从未同步显示未同步与「从未成功同步」", () => {
    useQuotaWindowsMock.mockReturnValue({ data: { windows: [] } });
    renderPage();
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
    renderPage();
    expect(screen.getByText("不适用 — 非 Coding Plan 套餐资源，无厂商窗口额度。")).toBeInTheDocument();
    expect(screen.queryByText("周额度")).not.toBeInTheDocument();
  });
});
