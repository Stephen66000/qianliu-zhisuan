import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncModelsPanel } from "./ResourceModelDiscovery";
import type { ProviderResourceItem } from "../../api/types";
import * as clientModule from "../../api/client";

vi.mock("../../api/hooks", () => ({
  useResourceRoutes: () => ({
    data: {
      routes: [
        {
          id: "route-k3",
          upstream_model: "k3",
          model_alias: "ql-k3",
          status: "ACTIVE",
          has_active_billing_rule: true,
          enabled: true,
          archived_at: null,
          unified_model_archived_at: null,
        },
        {
          id: "route-k3-256k",
          upstream_model: "k3-256k",
          model_alias: "ql-k3-256k",
          status: "ARCHIVED",
          has_active_billing_rule: false,
          enabled: false,
          archived_at: "2026-09-13T10:00:00Z",
          unified_model_archived_at: "2026-09-13T10:00:00Z",
        },
      ],
    },
    isLoading: false,
  }),
  useRetireResourceRoute: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useRestoreResourceRoute: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useEnableResourceRoute: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  QUERY_KEYS: {
    providerResources: ["provider-resources"],
    resourceRoutes: (id: string) => ["resource-routes", id],
  },
}));

describe("SyncModelsPanel 模型同步过滤与状态呈现", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it("已在服务的模型 (k3) 和已下架模型 (k3-256k) 不会出现在下方可加入勾选框中，仅展示未接入新模型", async () => {
    vi.spyOn(clientModule, "post").mockImplementation(async (url: string) => {
      if (url.includes("/models/sync")) {
        return {
          source: "OFFICIAL_DOCUMENTATION",
          source_version: "kimi-code-models-v1",
          discovered_at: "2026-09-13T12:00:00Z",
          models: [
            // P1 合同：sync 响应携带 selectable/credential_validation，仅 READY 可加入。
            { id: "k3", displayName: "k3", modelType: "CHAT", capabilities: ["chat"], compatible: true, unavailableReason: null,
              selectable: true, credential_validation: { status: "READY", http_status: 200, error_code: null, retryable: false, checked_at: "2026-09-13T12:00:00Z" } },
            { id: "k3-256k", displayName: "k3-256k", modelType: "CHAT", capabilities: ["chat"], compatible: false, unavailableReason: "当前套餐未开通此模型权限",
              selectable: false, credential_validation: { status: "PLAN_NOT_ENTITLED", http_status: 403, error_code: "MODEL_PROBE_PLAN_NOT_ENTITLED", retryable: false, checked_at: "2026-09-13T12:00:00Z" } },
            { id: "kimi-for-coding", displayName: "kimi-for-coding", modelType: "CHAT", capabilities: ["chat"], compatible: true, unavailableReason: null,
              selectable: true, credential_validation: { status: "READY", http_status: 200, error_code: null, retryable: false, checked_at: "2026-09-13T12:00:00Z" } },
            { id: "kimi-for-coding-highspeed", displayName: "kimi-for-coding-highspeed", modelType: "CHAT", capabilities: ["chat"], compatible: true, unavailableReason: null,
              selectable: true, credential_validation: { status: "READY", http_status: 200, error_code: null, retryable: false, checked_at: "2026-09-13T12:00:00Z" } },
          ],
          catalog_diff: { added: [], retained: ["k3"], not_advertised: [] },
        };
      }
      return {};
    });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <SyncModelsPanel
          target={{ id: "res-1", name: "Kimi", provider_id: "kimi", mode: "CODING_PLAN", status: "ACTIVE" } as unknown as ProviderResourceItem}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );

    // 上方正在服务模型应展示 ql-k3 正常服务，无官方已下架
    expect(screen.getByText(/正在服务模型/)).toBeInTheDocument();
    expect(screen.getByText("ql-k3")).toBeInTheDocument();
    expect(screen.getByText("正常服务")).toBeInTheDocument();
    expect(screen.queryByText("官方已下架")).not.toBeInTheDocument();

    // 点击立即同步
    const syncBtn = screen.getByRole("button", { name: "立即同步" });
    await user.click(syncBtn);

    await waitFor(() => {
      expect(screen.getByText("kimi-for-coding", { selector: "strong" })).toBeInTheDocument();
    });

    // 验证：k3 不应作为可加入勾选框出现（因正在服务）
    // 验证：k3-256k 不应作为可加入勾选框出现（因已下架归档且不兼容）
    const checkboxes = screen.getAllByRole("checkbox");
    // 只有 2 个模型复选框：kimi-for-coding 和 kimi-for-coding-highspeed
    expect(checkboxes).toHaveLength(2);
    expect(screen.getByText("kimi-for-coding", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("kimi-for-coding-highspeed", { selector: "strong" })).toBeInTheDocument();
  });

  it("当 not_advertised 仅包含已下架模型而非正在服务模型时，不展示全量告警横幅", async () => {
    vi.spyOn(clientModule, "post").mockImplementation(async (url: string) => {
      if (url.includes("/models/sync")) {
        return {
          source: "OFFICIAL_DOCUMENTATION",
          source_version: "kimi-code-models-v1",
          discovered_at: "2026-09-13T12:00:00Z",
          models: [
            { id: "k3", displayName: "k3", modelType: "CHAT", capabilities: ["chat"], compatible: true, unavailableReason: null,
              selectable: true, credential_validation: { status: "READY", http_status: 200, error_code: null, retryable: false, checked_at: "2026-09-13T12:00:00Z" } },
            { id: "kimi-for-coding", displayName: "kimi-for-coding", modelType: "CHAT", capabilities: ["chat"], compatible: true, unavailableReason: null,
              selectable: true, credential_validation: { status: "READY", http_status: 200, error_code: null, retryable: false, checked_at: "2026-09-13T12:00:00Z" } },
          ],
          catalog_diff: { added: [], retained: ["k3"], not_advertised: ["k3-256k"] },
        };
      }
      return {};
    });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <SyncModelsPanel
          target={{ id: "res-1", name: "Kimi", provider_id: "kimi", mode: "CODING_PLAN", status: "ACTIVE" } as unknown as ProviderResourceItem}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );

    const syncBtn = screen.getByRole("button", { name: "立即同步" });
    await user.click(syncBtn);

    await waitFor(() => {
      expect(screen.getByText("kimi-for-coding", { selector: "strong" })).toBeInTheDocument();
    });

    // 告警横幅不应显示，因为 k3 仍在服务且在官方列表中，not_advertised 的是已归档的 k3-256k
    expect(screen.queryByText(/厂商官方当前已不再列出以下模型/)).not.toBeInTheDocument();
  });
});
