import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBillingRulesMock, modelsMock, resourcesMock, routesMock, principalsMock, policiesMock, postMock, patchMock, query } from "./quota-rules-test-fixture";
import { QuotaRulesPage, buildDispatchPolicyPayload } from "./QuotaRules.js";

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

    await user.click(screen.getByRole("tab", { name: "调度策略" }));
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
