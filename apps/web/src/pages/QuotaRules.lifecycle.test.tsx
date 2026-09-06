import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingRule, DispatchPolicy } from "../api/types.js";
import { useBillingRulesMock, modelsMock, resourcesMock, routesMock, principalsMock, policiesMock, postMock, patchMock, query } from "./quota-rules-test-fixture";
import { QuotaRulesPage } from "./QuotaRules.js";

import { useQuotaRulesPageModel } from "./quota-rules-page-model";
import { QuotaModelSection } from "../components/quota/QuotaModelSection";
import { QuotaRouteSection } from "../components/quota/QuotaRouteSection";
import { QuotaBillingSection } from "../components/quota/QuotaBillingSection";
import { QuotaDialogs } from "../components/quota/QuotaDialogs";

// Removed from the normal page; preserve isolated regression coverage for existing lifecycle components.
function LegacyConfigurationComponents() {
  const model = useQuotaRulesPageModel();
  return <><QuotaModelSection model={model} /><QuotaRouteSection model={model} /><QuotaBillingSection model={model} /><QuotaDialogs model={model} /></>;
}
function retiredPolicy(): DispatchPolicy {
  return {
    id: "policy-retired", status: "RETIRED", matchUnifiedModel: null,
    matchResourceMode: null, matchProviderResourceId: null, matchTimezone: null,
    matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null,
    matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null,
    matchForecastExhaustRisk: null, matchPrincipalScope: null, action: "ALLOW",
    switchEquivalentGroup: [], rateLimitPerMinute: null, policyVersion: "v2",
    priority: 100, description: null, source: "ADMIN", copiedFromPolicyId: null,
    createdByAdminId: "admin-1", validatedAt: "2026-08-01T00:00:00Z",
    validatedByAdminId: "admin-1", publishedAt: "2026-08-01T00:01:00Z",
    publishedByAdminId: "admin-1", effectiveAt: "2026-08-01T00:01:00Z",
    retiredAt: "2026-08-02T00:00:00Z", retiredByAdminId: "admin-1",
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z",
  };
}

describe("POOL20-036～037 配置归档与调度恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBillingRulesMock.mockReturnValue(query({ rules: [] }));
    modelsMock.mockReturnValue(query({ models: [] }));
    resourcesMock.mockReturnValue(query({ resources: [] }));
    routesMock.mockReturnValue(query({ routes: [] }));
    principalsMock.mockReturnValue(query({ principals: [] }));
    policiesMock.mockReturnValue(query({ policies: [] }));
    postMock.mockResolvedValue({});
  });

  it("POOL20-049：新接入的待配置模型可正式启用", async () => {
    modelsMock.mockReturnValue(query({ models: [{
      id: "model-vision", enterprise_id: "enterprise-1",
      alias: "ql-deepseek-v4-flash-vision-exp",
      display_name: "deepseek-v4-flash-vision-exp",
      required_capabilities: ["chat", "stream", "vision"],
      status: "PENDING_CONFIG", version: 1,
      archived_at: null, archived_by_admin_id: null,
      created_at: "2026-08-23T00:00:00Z", updated_at: "2026-08-23T00:00:00Z",
    }] }));
    const user = userEvent.setup();
    render(<MemoryRouter><LegacyConfigurationComponents /></MemoryRouter>);
    const row = screen.getAllByText("deepseek-v4-flash-vision-exp")
      .find((node) => node.tagName === "TD")!.closest("tr")!;
    expect(within(row).getByText("待配置")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "启用" }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith(
      "/unified-models/model-vision",
      { expected_version: 1, status: "ACTIVE" },
    ));
  });

  it("统一模型归档先显示冻结文案，取消零写入，确认才调用 API", async () => {
    modelsMock.mockReturnValue(query({ models: [{
      id: "model-disabled", enterprise_id: "enterprise-1", alias: "ql-disabled",
      display_name: "待归档模型", required_capabilities: null, status: "DISABLED",
      version: 3, archived_at: null, archived_by_admin_id: null,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    }] }));
    const user = userEvent.setup();
    render(<MemoryRouter><LegacyConfigurationComponents /></MemoryRouter>);
    const row = screen.getAllByText("待归档模型").find((node) => node.tagName === "TD")!.closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "归档" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("确认归档统一模型？");
    expect(screen.getByRole("dialog")).toHaveTextContent("归档后，该模型将从默认列表和新配置入口中隐藏。可通过‘查看已归档配置’恢复。是否继续？");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(postMock).not.toHaveBeenCalled();
    await user.click(within(row).getByRole("button", { name: "归档" }));
    await user.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/unified-models/model-disabled/archive", { expected_version: 3 },
    ));
  });

  it("RETIRED 策略拆分恢复原配置与复制草稿，恢复需确认", async () => {
    policiesMock.mockReturnValue(query({ policies: [retiredPolicy()] }));
    const user = userEvent.setup();
    render(<MemoryRouter><QuotaRulesPage /></MemoryRouter>);
    expect(screen.queryByText("重新启用 / 复制为新版本")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "调度策略" }));
    await user.click(screen.getByRole("button", { name: "复制为新版本" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/dispatch-policies/policy-retired/copy",
    ));
    postMock.mockClear();
    await user.click(screen.getByRole("button", { name: "恢复原配置" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("历史版本继续保持 RETIRED");
    expect(postMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认恢复并发布" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/dispatch-policies/policy-retired/restore",
    ));
  });

  it("Model Route 与计价规则复用同一归档确认合同", async () => {
    modelsMock.mockReturnValue(query({ models: [{
      id: "model-route", enterprise_id: "enterprise-1", alias: "ql-route",
      display_name: "路由模型", required_capabilities: null, status: "DISABLED",
      version: 1, archived_at: null, archived_by_admin_id: null,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    }] }));
    routesMock.mockReturnValue(query({ routes: [{
      id: "route-disabled", enterprise_id: "enterprise-1", unified_model_id: "model-route",
      provider_resource_id: "resource-1", upstream_model: "route-upstream",
      priority: 100, weight: 1, enabled: false, version: 2,
      archived_at: null, archived_by_admin_id: null,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    }] }));
    useBillingRulesMock.mockReturnValue(query({ rules: [{
      id: "rule-disabled", rule_type: "API_PRICE", rule_version: "archive-rule-v1",
      provider_resource_id: null, upstream_model: "rule-upstream",
      effective_from: "2026-08-01T00:00:00Z", effective_to: null,
      timezone: null, days_of_week: null, start_time: null, end_time: null,
      time_windows: null, multiplier: null, cache_hit_price: "0.1",
      cache_miss_price: "0.2", output_price: "0.3", currency: "CNY",
      priority: 100, enabled: false, source: "ADMIN", version: 4,
      archived_at: null, archived_by_admin_id: null,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    } satisfies BillingRule] }));
    const user = userEvent.setup();
    render(<MemoryRouter><QuotaRulesPage /></MemoryRouter>);

    const ruleRow = screen.getByText("archive-rule-v1").closest("tr")!;
    await user.click(within(ruleRow).getByRole("button", { name: "归档" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("确认归档计价规则？");
    await user.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/billing-rules/rule-disabled/archive", { expected_version: 4 },
    ));
  });
});
