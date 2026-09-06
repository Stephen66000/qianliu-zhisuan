import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingRule } from "../api/types.js";
import { useBillingRulesMock, modelsMock, resourcesMock, routesMock, principalsMock, policiesMock, postMock, patchMock, query } from "./quota-rules-test-fixture";
import { BillingRuleSchema, QuotaRulesPage, buildBillingRulePayload, buildDispatchPolicyPayload } from "./QuotaRules.js";

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
