import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
  upstream_models: ["kimi-k2"],
  concurrency_limit: 10,
  version: 3,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  operating_snapshot: null,
};

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
    postMock.mockResolvedValue({ resource });
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
    await user.type(screen.getByLabelText("厂商总额度"), "100");
    await user.type(screen.getByLabelText("生效时间"), "2026-07-01T00:00");
    expect(screen.queryByLabelText("厂商已用额度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("厂商剩余额度")).not.toBeInTheDocument();
    expect(screen.getByText(/已用额度取当前周期内该资源的账本扣减/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("重置周期"), "MONTHLY");
    await user.type(screen.getByLabelText("重置日期"), "2026-08-01T00:00");
    await user.click(screen.getByRole("button", { name: /^登记$/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0]?.[1]).toMatchObject({
      operating_snapshot: {
        source: "ADMIN",
        total_quota: "100",
        quota_unit: "TOKEN",
        reset_cycle: "MONTHLY",
        reset_anchor_at: "2026-07-31T16:00:00.000Z",
      },
    });
    expect(postMock.mock.calls[0]?.[1].operating_snapshot).not.toHaveProperty("used_quota");
    expect(postMock.mock.calls[0]?.[1].operating_snapshot).not.toHaveProperty("remaining_quota");
    expect(postMock.mock.calls[0]?.[1].operating_snapshot).not.toHaveProperty("next_reset_at");
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
    await user.click(screen.getByRole("button", { name: /^登记$/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0]?.[1]).toMatchObject({
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

  it("保持资源 ID 和凭证不变，更新名称、模型声明与并发限制", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    const name = screen.getByLabelText("资源名称");
    await user.clear(name);
    await user.type(name, "Kimi 新套餐");
    const models = screen.getByLabelText("上游模型");
    await user.clear(models);
    await user.type(models, "kimi-k2, kimi-k2-thinking");
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
          upstream_models: ["kimi-k2", "kimi-k2-thinking"],
          concurrency_limit: 16,
        },
      );
    });
    expect(screen.queryByDisplayValue(resource.credential_fingerprint ?? "")).not.toBeInTheDocument();
  });
});
