import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingRule } from "../api/types.js";
import {
  BillingRuleSchema,
  QuotaRulesPage,
  buildBillingRulePayload,
  buildDispatchPolicyPayload,
} from "./QuotaRules.js";

const useBillingRulesMock = vi.fn();
const modelsMock = vi.fn();
const resourcesMock = vi.fn();
const routesMock = vi.fn();
const principalsMock = vi.fn();
const policiesMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useBillingRules: () => useBillingRulesMock(),
  useDispatchPolicies: () => policiesMock(),
  useUnifiedModels: () => modelsMock(),
  useProviderResources: () => resourcesMock(),
  useModelRoutes: () => routesMock(),
  usePrincipals: () => principalsMock(),
  QUERY_KEYS: {
    billingRules: ["billing-rules"],
    dispatchPolicies: ["dispatch-policies"],
    unifiedModels: ["unified-models"],
    modelRoutes: (id: string) => ["model-routes", id],
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateMock }),
    useMutation: (options: {
      mutationFn: (value: unknown) => Promise<unknown>;
      onSuccess?: () => void;
    }) => ({
      mutate: async (value: unknown) => {
        await options.mutationFn(value);
        options.onSuccess?.();
      },
      isPending: false,
      error: null,
    }),
  };
});

const BASE = {
  rule_version: "deepseek-v1",
  provider_resource_id: "11111111-1111-4111-8111-111111111111",
  upstream_model: "deepseek-chat",
  effective_from: "2026-07-30T09:00",
  effective_to: "",
  multiplier: "",
  cache_hit_price: "0.000001",
  cache_miss_price: "0.000002",
  output_price: "0.000004",
  priority: 10,
};

function query(data: Record<string, unknown>) {
  return { data, error: null, isLoading: false, refetch: vi.fn() };
}

describe("计价规则 Web 表单", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelsMock.mockReturnValue(query({ models: [] }));
    resourcesMock.mockReturnValue(query({ resources: [] }));
    routesMock.mockReturnValue(query({ routes: [] }));
    policiesMock.mockReturnValue(query({ policies: [] }));
    principalsMock.mockReturnValue(query({ principals: [] }));
    postMock.mockResolvedValue({});
    patchMock.mockResolvedValue({});
    const rule: BillingRule = {
      id: "rule-1",
      rule_type: "API_PRICE",
      rule_version: "deepseek-v1",
      provider_resource_id: null,
      upstream_model: "deepseek-chat",
      effective_from: "2026-07-30T00:00:00.000Z",
      effective_to: null,
      timezone: "Asia/Shanghai",
      days_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: "09:00",
      end_time: "12:00",
      time_windows: [
        {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "09:00",
          end_time: "12:00",
        },
        {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "14:00",
          end_time: "18:00",
        },
      ],
      multiplier: null,
      cache_hit_price: "0.000001",
      cache_miss_price: "0.000002",
      output_price: "0.000004",
      currency: "CNY",
      priority: 10,
      enabled: true,
      source: "test",
      version: 3,
      archived_at: null,
      archived_by_admin_id: null,
      created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
    };
    useBillingRulesMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { rules: [rule] },
      refetch: vi.fn(),
    });
  });

  it("基础 API 价格规则无窗口时发送 null，不发送非法空数组", () => {
    const parsed = BillingRuleSchema.parse({
      ...BASE,
      rule_type: "API_PRICE",
      windows: [],
    });
    expect(buildBillingRulePayload(parsed).windows).toBeNull();
  });

  it("单条 DeepSeek 价格规则提交两个有序时间窗", () => {
    const parsed = BillingRuleSchema.parse({
      ...BASE,
      rule_type: "API_PRICE",
      windows: [
        {
          timezone: "Asia/Shanghai",
          days_of_week: "1,2,3,4,5,6,7",
          start_time: "09:00",
          end_time: "12:00",
        },
        {
          timezone: "Asia/Shanghai",
          days_of_week: "1,2,3,4,5,6,7",
          start_time: "14:00",
          end_time: "18:00",
        },
      ],
    });
    expect(buildBillingRulePayload(parsed).windows).toEqual([
      {
        timezone: "Asia/Shanghai",
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "09:00",
        end_time: "12:00",
      },
      {
        timezone: "Asia/Shanghai",
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "14:00",
        end_time: "18:00",
      },
    ]);
  });

  it("智谱高峰 REJECT 策略序列化为可发布的确定性条件", () => {
    expect(buildDispatchPolicyPayload({
      match_unified_model: "qianliu-glm",
      match_resource_mode: "CODING_PLAN",
      match_provider_resource_id: "11111111-1111-4111-8111-111111111111",
      match_timezone: "Asia/Shanghai",
      match_days_of_week: "1,2,3,4,5,6,7",
      match_start_time: "14:00",
      match_end_time: "18:00",
      match_price_multiplier_min: "",
      match_remaining_quota_ratio_max: "",
      match_forecast_exhaust_risk: false,
      match_principal_scope_mode: "ALL",
      match_principal_scope: [],
      action: "REJECT",
      switch_equivalent_group: "",
      rate_limit_per_minute: "",
      policy_version: "zhipu-peak-v1",
      priority: 10,
      description: "高峰硬拒绝",
    })).toMatchObject({
      match_unified_model: "qianliu-glm",
      match_resource_mode: "CODING_PLAN",
      match_timezone: "Asia/Shanghai",
      match_days_of_week: [1, 2, 3, 4, 5, 6, 7],
      match_start_time: "14:00",
      match_end_time: "18:00",
      action: "REJECT",
      policy_version: "zhipu-peak-v1",
      priority: 10,
    });
  });

  it("规则经济字段不可原地编辑，只允许生命周期启停", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "编辑规则" })).not.toBeInTheDocument();
    expect(screen.getByText(/价格、倍率、时间窗和优先级属于规则版本/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/billing-rules/rule-1",
        expect.objectContaining({
          expected_version: 3,
          enabled: false,
        }),
      );
    });
  });
});

describe("额度规则配置依赖顺序", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBillingRulesMock.mockReturnValue(query({ rules: [] }));
    modelsMock.mockReturnValue(query({ models: [] }));
    resourcesMock.mockReturnValue(query({ resources: [] }));
    routesMock.mockReturnValue(query({ routes: [] }));
    policiesMock.mockReturnValue(query({ policies: [] }));
    principalsMock.mockReturnValue(query({ principals: [] }));
  });

  it("按统一模型、Model Route、计价规则、调度策略的 DOM 顺序编排", () => {
    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    const dependencyHeadings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
      .filter((text) =>
        ["统一模型", "Model Route", "计价规则模板", "调度策略"].includes(text ?? ""),
      );
    expect(dependencyHeadings).toEqual([
      "统一模型",
      "Model Route",
      "计价规则模板",
      "调度策略",
    ]);
  });

  it("空企业禁用依赖型创建并明确下一步", () => {
    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "新建路由" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建规则" })).toBeDisabled();
    expect(screen.getByText(/先在上方创建并启用统一模型/)).toBeInTheDocument();
    expect(screen.getByText(/至少启用一条 Model Route/)).toBeInTheDocument();
  });

  it("模型、资源和启用路由就绪后开放下一步", () => {
    modelsMock.mockReturnValue(query({
      models: [{
        id: "model-1",
        alias: "qianliu-test",
        display_name: "测试模型",
        status: "ACTIVE",
        version: 1,
      }],
    }));
    resourcesMock.mockReturnValue(query({
      resources: [{ id: "resource-1", name: "测试资源" }],
    }));
    routesMock.mockReturnValue(query({
      routes: [{
        id: "route-1",
        unified_model_id: "model-1",
        provider_resource_id: "resource-1",
        upstream_model: "upstream-test",
        priority: 100,
        weight: 1,
        enabled: true,
        version: 1,
      }],
    }));

    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "新建路由" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建规则" })).toBeEnabled();
    expect(screen.getByText(/前置条件已满足/)).toBeInTheDocument();
  });
});

describe("调度策略主体范围", () => {
  const employeeId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
    useBillingRulesMock.mockReturnValue(query({ rules: [] }));
    modelsMock.mockReturnValue(query({ models: [] }));
    resourcesMock.mockReturnValue(query({ resources: [] }));
    routesMock.mockReturnValue(query({ routes: [] }));
    policiesMock.mockReturnValue(query({ policies: [] }));
    principalsMock.mockReturnValue(query({
      principals: [
        {
          id: employeeId,
          enterprise_id: "enterprise-1",
          type: "EMPLOYEE",
          name: "于滔",
          department_label: "研发部",
          status: "ACTIVE",
          archived_at: null,
          version: 1,
          created_at: "2026-08-02T00:00:00.000Z",
          updated_at: "2026-08-02T00:00:00.000Z",
        },
        {
          id: projectId,
          enterprise_id: "enterprise-1",
          type: "PROJECT",
          name: "智算项目",
          department_label: null,
          status: "ACTIVE",
          archived_at: null,
          version: 1,
          created_at: "2026-08-02T00:00:00.000Z",
          updated_at: "2026-08-02T00:00:00.000Z",
        },
      ],
    }));
    postMock.mockResolvedValue({});
    patchMock.mockResolvedValue({});
  });

  it("按名称搜索并提交多个当前企业主体 ID", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "新建调度策略" }));
    await user.click(screen.getByLabelText("指定主体"));
    await user.type(screen.getByLabelText("搜索主体"), "研发部");
    await user.click(screen.getByLabelText(/于滔/));
    await user.clear(screen.getByLabelText("搜索主体"));
    await user.click(screen.getByLabelText(/智算项目/));
    await user.click(screen.getByRole("button", { name: "创建草稿" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/dispatch-policies",
        expect.objectContaining({ match_principal_scope: [employeeId, projectId] }),
      );
    });
  });

  it("全部主体使用 null 语义", () => {
    expect(buildDispatchPolicyPayload(DispatchPolicyFormSchemaForTest({
      match_principal_scope_mode: "ALL",
      match_principal_scope: [employeeId],
    })).match_principal_scope).toBeNull();
  });
});

function DispatchPolicyFormSchemaForTest(overrides: Record<string, unknown>) {
  return {
    match_unified_model: "",
    match_resource_mode: "" as const,
    match_provider_resource_id: "",
    match_timezone: "Asia/Shanghai",
    match_days_of_week: "1,2,3,4,5,6,7",
    match_start_time: "14:00",
    match_end_time: "18:00",
    match_price_multiplier_min: "",
    match_remaining_quota_ratio_max: "",
    match_forecast_exhaust_risk: false,
    match_principal_scope_mode: "ALL" as const,
    match_principal_scope: [],
    action: "REJECT" as const,
    switch_equivalent_group: "",
    rate_limit_per_minute: "",
    policy_version: "v1",
    priority: 100,
    description: "",
    ...overrides,
  };
}
