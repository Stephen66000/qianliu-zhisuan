import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuotaBillingSection, getRuleStatusCategory } from "./QuotaBillingSection";
import type { BillingRule, Provider, ProviderResourceItem } from "../../api/types";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";

function mockRule(partial: Partial<BillingRule> & { id: string }): BillingRule {
  return {
    id: partial.id,
    rule_type: partial.rule_type ?? "API_PRICE",
    rule_version: partial.rule_version ?? `v-${partial.id}`,
    provider_resource_id: partial.provider_resource_id ?? null,
    upstream_model: partial.upstream_model ?? null,
    effective_from: partial.effective_from ?? "2026-01-01T00:00:00.000Z",
    effective_to: partial.effective_to ?? null,
    timezone: "Asia/Shanghai",
    days_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: null,
    end_time: null,
    time_windows: partial.time_windows ?? [],
    multiplier: partial.multiplier ?? null,
    cache_hit_price: partial.cache_hit_price ?? "0.000001",
    cache_miss_price: partial.cache_miss_price ?? "0.000002",
    output_price: partial.output_price ?? "0.000004",
    currency: "CNY",
    priority: 100,
    enabled: partial.enabled ?? true,
    source: "MANUAL",
    version: 1,
    archived_at: partial.archived_at ?? null,
    archived_by_admin_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pricing_mode: partial.pricing_mode ?? "ABSOLUTE",
  };
}

describe("getRuleStatusCategory 规则状态计算", () => {
  it("正确识别 ARCHIVED、DISABLED、PENDING、EXPIRED、ACTIVE", () => {
    const now = new Date("2026-09-12T12:00:00.000Z").getTime();

    expect(getRuleStatusCategory({
      enabled: true, effective_from: "2026-01-01T00:00:00Z", effective_to: null, archived_at: "2026-09-01T00:00:00Z"
    }, now)).toBe("ARCHIVED");

    expect(getRuleStatusCategory({
      enabled: false, effective_from: "2026-01-01T00:00:00Z", effective_to: null, archived_at: null
    }, now)).toBe("DISABLED");

    expect(getRuleStatusCategory({
      enabled: true, effective_from: "2026-10-01T00:00:00Z", effective_to: null, archived_at: null
    }, now)).toBe("PENDING");

    expect(getRuleStatusCategory({
      enabled: true, effective_from: "2026-01-01T00:00:00Z", effective_to: "2026-08-01T00:00:00Z", archived_at: null
    }, now)).toBe("EXPIRED");

    expect(getRuleStatusCategory({
      enabled: true, effective_from: "2026-01-01T00:00:00Z", effective_to: "2026-12-31T00:00:00Z", archived_at: null
    }, now)).toBe("ACTIVE");
  });
});

describe("QuotaBillingSection 多维筛选栏", () => {
  const providers = [
    { id: "prov-zhipu", name: "智谱 AI" },
    { id: "prov-kimi", name: "Moonshot / Kimi" },
  ] as unknown as Provider[];

  const resources: ProviderResourceItem[] = [
    {
      id: "res-zhipu-1",
      provider_id: "prov-zhipu",
      name: "智谱大模型资源",
      mode: "API",
      credential_type: "API_KEY",
      credential_fingerprint: null,
      credential_version: 1,
      status: "ACTIVE",
      consecutive_failures: 0,
      cooldown_until: null,
      last_probe_at: null,
      credential_refresh_status: "SUCCESS",
      refresh_error_classification: null,
      credential_expires_at: null,
      resource_pool_id: null,
      upstream_models: ["glm-5.3"],
      concurrency_limit: null,
      version: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      operating_snapshot: null,
    },
    {
      id: "res-kimi-1",
      provider_id: "prov-kimi",
      name: "Kimi 套餐资源",
      mode: "CODING_PLAN",
      credential_type: "API_KEY",
      credential_fingerprint: null,
      credential_version: 1,
      status: "ACTIVE",
      consecutive_failures: 0,
      cooldown_until: null,
      last_probe_at: null,
      credential_refresh_status: "SUCCESS",
      refresh_error_classification: null,
      credential_expires_at: null,
      resource_pool_id: null,
      upstream_models: ["moonshot-k3"],
      concurrency_limit: null,
      version: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      operating_snapshot: null,
    },
  ];

  const rules: BillingRule[] = [
    mockRule({
      id: "rule-zhipu-base",
      rule_version: "v-zhipu-base",
      provider_resource_id: "res-zhipu-1",
      upstream_model: "glm-5.3",
      enabled: true,
    }),
    mockRule({
      id: "rule-zhipu-peak",
      rule_version: "v-zhipu-peak",
      provider_resource_id: "res-zhipu-1",
      upstream_model: "glm-5.3",
      enabled: true,
      time_windows: [{ timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "14:00", end_time: "18:00" }],
    }),
    mockRule({
      id: "rule-kimi-base",
      rule_version: "v-kimi-base",
      provider_resource_id: "res-kimi-1",
      upstream_model: "moonshot-k3",
      enabled: false,
    }),
  ];

  function buildMockModel(): QuotaRulesPageModel {
    return {
      rules,
      resources,
      providers,
      models: [],
      allRoutes: [],
      allRules: rules,
      enabledRoutes: [],
      routes: [],
      visibleModels: [],
      readyRoutes: [],
      principals: [],
      policies: [],
      canCreateRule: true,
      showRuleForm: false,
      setShowRuleForm: vi.fn(),
      ruleForm: {
        handleSubmit: vi.fn(),
        register: vi.fn(),
        formState: { errors: {} },
        getValues: vi.fn(),
        setValue: vi.fn(),
        reset: vi.fn(),
        watch: vi.fn(),
      } as unknown as QuotaRulesPageModel["ruleForm"],
      routeForm: {
        register: vi.fn(),
        getValues: vi.fn(),
        setValue: vi.fn(),
        reset: vi.fn(),
      } as unknown as QuotaRulesPageModel["routeForm"],
      selectedRuleType: "API_PRICE",
      ruleWindowFields: [],
      appendRuleWindow: vi.fn(),
      removeRuleWindow: vi.fn(),
      updateModel: { mutate: vi.fn(), isPending: false } as unknown as QuotaRulesPageModel["updateModel"],
      updateRule: { mutate: vi.fn(), isPending: false } as unknown as QuotaRulesPageModel["updateRule"],
      createRule: { mutate: vi.fn(), isPending: false, reset: vi.fn() } as unknown as QuotaRulesPageModel["createRule"],
      archiveConfig: { mutate: vi.fn(), isPending: false } as unknown as QuotaRulesPageModel["archiveConfig"],
      setArchiveTarget: vi.fn(),
      rulesQuery: { isLoading: false, error: null, refetch: vi.fn() } as unknown as QuotaRulesPageModel["rulesQuery"],
      modelsQuery: { isLoading: false, error: null, refetch: vi.fn() } as unknown as QuotaRulesPageModel["modelsQuery"],
      selectedModelId: null,
      setSelectedModelId: vi.fn(),
      selectedRuleRouteId: "",
      setSelectedRuleRouteId: vi.fn(),
      queuedRules: [],
      setQueuedRules: vi.fn(),
      sourceRuleIds: [],
      setSourceRuleIds: vi.fn(),
      replaceExisting: false,
      setReplaceExisting: vi.fn(),
      setSubmissionId: vi.fn(),
      showArchived: false,
      setShowArchived: vi.fn(),
    } as unknown as QuotaRulesPageModel;
  }

  it("默认渲染全部 3 条规则及总数统计", () => {
    const model = buildMockModel();
    render(<QuotaBillingSection model={model} />);

    expect(screen.getByTestId("rule-count-summary")).toHaveTextContent("共 3 条规则");
    expect(screen.getByText("v-zhipu-base")).toBeInTheDocument();
    expect(screen.getByText("v-zhipu-peak")).toBeInTheDocument();
    expect(screen.getByText("v-kimi-base")).toBeInTheDocument();
  });

  it("按厂商筛选规则", async () => {
    const user = userEvent.setup();
    const model = buildMockModel();
    render(<QuotaBillingSection model={model} />);

    const providerSelect = screen.getByLabelText("筛选厂商");
    await user.selectOptions(providerSelect, "prov-zhipu");

    expect(screen.getByTestId("rule-count-summary")).toHaveTextContent("显示 2 / 共 3 条规则");
    expect(screen.getByText("v-zhipu-base")).toBeInTheDocument();
    expect(screen.getByText("v-zhipu-peak")).toBeInTheDocument();
    expect(screen.queryByText("v-kimi-base")).not.toBeInTheDocument();
  });

  it("按模型筛选规则并可点击重置筛选按钮", async () => {
    const user = userEvent.setup();
    const model = buildMockModel();
    render(<QuotaBillingSection model={model} />);

    const modelSelect = screen.getByLabelText("筛选模型");
    await user.selectOptions(modelSelect, "moonshot-k3");

    expect(screen.getByTestId("rule-count-summary")).toHaveTextContent("显示 1 / 共 3 条规则");
    expect(screen.getByText("v-kimi-base")).toBeInTheDocument();
    expect(screen.queryByText("v-zhipu-base")).not.toBeInTheDocument();

    // 点击工具栏的重置筛选按钮
    const resetBtn = screen.getByRole("button", { name: "重置筛选" });
    await user.click(resetBtn);

    expect(screen.getByTestId("rule-count-summary")).toHaveTextContent("共 3 条规则");
    expect(screen.getByText("v-zhipu-base")).toBeInTheDocument();
    expect(screen.getByText("v-kimi-base")).toBeInTheDocument();
  });

  it("按状态筛选规则（如停用状态）", async () => {
    const user = userEvent.setup();
    const model = buildMockModel();
    render(<QuotaBillingSection model={model} />);

    const statusSelect = screen.getByLabelText("筛选状态");
    await user.selectOptions(statusSelect, "DISABLED");

    expect(screen.getByTestId("rule-count-summary")).toHaveTextContent("显示 1 / 共 3 条规则");
    expect(screen.queryByText("v-zhipu-base")).not.toBeInTheDocument();
    expect(screen.queryByText("v-zhipu-peak")).not.toBeInTheDocument();
    expect(screen.getByText("v-kimi-base")).toBeInTheDocument();
  });

  it("无匹配项时提示并支持重置", async () => {
    const user = userEvent.setup();
    const model = buildMockModel();
    render(<QuotaBillingSection model={model} />);

    // prov-kimi 下没有生效中的规则（kimi-base 是 disabled）
    await user.selectOptions(screen.getByLabelText("筛选厂商"), "prov-kimi");
    await user.selectOptions(screen.getByLabelText("筛选状态"), "ACTIVE");

    expect(screen.getByText("未找到符合筛选条件的计价规则")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除筛选" })).toBeInTheDocument();

    // 点击清除筛选
    await user.click(screen.getByRole("button", { name: "清除筛选" }));

    expect(screen.getByTestId("rule-count-summary")).toHaveTextContent("共 3 条规则");
    expect(screen.getByText("v-zhipu-base")).toBeInTheDocument();
  });
});
