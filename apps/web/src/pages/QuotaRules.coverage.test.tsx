import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { BillingRule, DispatchPolicy } from "../api/types";
import { modelsMock, resourcesMock, routesMock, readyRoutesMock, principalsMock,
  policiesMock, useBillingRulesMock, postMock, patchMock, query } from "./quota-rules-test-fixture";
import { QuotaRulesPage } from "./QuotaRules";
import { BillingRuleSchema } from "./quota-rule-contract";

const view = () => <MemoryRouter><QuotaRulesPage /></MemoryRouter>;
function policy(overrides: Partial<DispatchPolicy> = {}): DispatchPolicy {
  return { id: "retired", status: "RETIRED", version: 7, archivedAt: null,
    matchUnifiedModel: null, matchResourceMode: null, matchProviderResourceId: null,
    matchTimezone: null, matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null,
    matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null,
    matchForecastExhaustRisk: null, matchPrincipalScope: null, action: "ALLOW",
    switchEquivalentGroup: [], rateLimitPerMinute: null, policyVersion: "retired-v1",
    priority: 100, description: null, source: "ADMIN", copiedFromPolicyId: null,
    createdByAdminId: null, validatedAt: null, validatedByAdminId: null,
    publishedAt: null, publishedByAdminId: null, effectiveAt: null, retiredAt: null,
    retiredByAdminId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides };
}
function rule(id: string, overrides: Partial<BillingRule> = {}): BillingRule {
  return { id, rule_type: "API_PRICE", rule_version: id, provider_resource_id: null,
    upstream_model: "test", effective_from: "2000-01-01T00:00:00Z", effective_to: null,
    timezone: null, days_of_week: null, start_time: null, end_time: null, time_windows: null,
    multiplier: null, cache_hit_price: "0", cache_miss_price: "0.000002", output_price: "0.000004",
    currency: "CNY", priority: 100, enabled: true, source: "ADMIN", version: 1,
    archived_at: null, archived_by_admin_id: null,
    created_at: "2000-01-01T00:00:00Z", updated_at: "2000-01-01T00:00:00Z", ...overrides };
}
beforeEach(() => {
  vi.clearAllMocks();
  modelsMock.mockReturnValue(query({ models: [] }));
  resourcesMock.mockReturnValue(query({ resources: [] }));
  routesMock.mockReturnValue(query({ routes: [] }));
  readyRoutesMock.mockReturnValue(query({ routes: [] }));
  principalsMock.mockReturnValue(query({ principals: [] }));
  policiesMock.mockReturnValue(query({ policies: [] }));
  useBillingRulesMock.mockReturnValue(query({ rules: [] }));
  postMock.mockResolvedValue({}); patchMock.mockResolvedValue({});
});

it("调度模型与资源按已就绪路由联动，未就绪和已归档模型不能误选", async () => {
  modelsMock.mockReturnValue(query({ models: [
    { id: "ma", alias: "a", display_name: "模型甲", archived_at: null },
    { id: "mb", alias: "b", display_name: "模型乙", archived_at: null },
    { id: "mc", alias: "c", display_name: "缺价模型", archived_at: null },
    { id: "md", alias: "d", display_name: "归档模型", archived_at: "2026-01-01" },
  ] }));
  resourcesMock.mockReturnValue(query({ resources: [
    { id: "ra", name: "资源甲" }, { id: "rb", name: "资源乙" }, { id: "rc", name: "缺价资源" },
  ] }));
  readyRoutesMock.mockReturnValue(query({ routes: [
    { id: "a", alias: "a", provider_resource_id: "ra", mode: "API", upstream_model: "a" },
    { id: "b", alias: "b", provider_resource_id: "rb", mode: "API", upstream_model: "b" },
  ] }));
  const user = userEvent.setup(); render(view());
  await user.click(screen.getByRole("tab", { name: "调度策略" }));
  await user.click(screen.getByRole("button", { name: "新建调度策略" }));
  const models = screen.getByLabelText("统一模型"), resources = screen.getByLabelText("厂商资源");
  expect(within(models).getByRole("option", { name: /模型甲/ })).toBeEnabled();
  expect(within(models).getByRole("option", { name: /缺价模型/ })).toBeDisabled();
  expect(within(models).queryByRole("option", { name: /归档模型/ })).not.toBeInTheDocument();
  expect(within(resources).getByRole("option", { name: "资源乙" })).toBeEnabled();
  await user.selectOptions(models, "a");
  expect(within(resources).getByRole("option", { name: "资源甲" })).toBeEnabled();
  expect(within(resources).getByRole("option", { name: "资源乙" })).toBeDisabled();
  expect(within(resources).getByRole("option", { name: "缺价资源" })).toBeDisabled();
  await user.selectOptions(models, "b");
  expect(within(resources).getByRole("option", { name: "资源乙" })).toBeEnabled();
  expect(postMock).not.toHaveBeenCalled();
});

it("存档先确认且携带版本；默认隐藏，查看存档可找回历史策略", async () => {
  policiesMock.mockReturnValue(query({ policies: [policy()] }));
  const user = userEvent.setup(), rendered = render(view());
  await user.click(screen.getByRole("tab", { name: "调度策略" }));
  await user.click(screen.getByRole("button", { name: "存档" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("历史决策与审计继续保留");
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(postMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "存档" }));
  await user.click(screen.getByRole("button", { name: "确认存档" }));
  await waitFor(() => expect(postMock).toHaveBeenCalledWith("/dispatch-policies/retired/archive", { expected_version: 7 }));
  policiesMock.mockReturnValue(query({ policies: [policy({ archivedAt: "2026-09-06T00:00:00Z" })] }));
  rendered.rerender(view());
  expect(screen.queryByText("retired-v1")).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("查看存档"));
  expect(screen.getByText("retired-v1")).toBeInTheDocument();
  expect(screen.getByText("已存档")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "存档" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "计价" }));
  expect(screen.getByRole("heading", { name: "计价" })).toBeInTheDocument();
});

it("表格区分待生效、已过期、停用、套餐和缺价，不把缺价当免费", async () => {
  useBillingRulesMock.mockReturnValue(query({ rules: [
    rule("future", { effective_from: "2099-01-01T00:00:00Z" }),
    rule("expired", { effective_to: "2001-01-01T00:00:00Z" }),
    rule("disabled", { enabled: false }),
    rule("absolute", { currency: "USD", cache_hit_price: null, cache_miss_price: null, output_price: null }),
    rule("multiplier", { pricing_mode: "MULTIPLIER", multiplier: "3" }),
    rule("plan", { rule_type: "MODEL_TIER", multiplier: "2" }),
    rule("archived", { enabled: false, archived_at: "2026-01-01T00:00:00Z" }),
  ] }));
  const user = userEvent.setup(); render(view());
  await user.click(screen.getByRole("button", { name: "明细表格视图" }));
  const row = (id: string) => screen.getByText(id).closest("tr")!;
  expect(row("future")).toHaveTextContent("待生效");
  expect(row("expired")).toHaveTextContent("已到期");
  expect(row("disabled")).toHaveTextContent("停用");
  expect(row("absolute")).toHaveTextContent("USD/百万 Token：命中 — / 未命中 — / 输出 —（绝对价）");
  expect(row("multiplier")).toHaveTextContent("× 3");
  expect(row("plan")).toHaveTextContent("×2");
  expect(screen.queryByText("archived")).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("查看存档"));
  expect(row("archived")).toHaveTextContent("已归档");
});

it.each(["", "0", "0.000"])("API 倍率 %s 不会通过表单校验", (multiplier) => {
  const parsed = BillingRuleSchema.safeParse({ rule_type: "API_PRICE", pricing_mode: "MULTIPLIER",
    rule_version: "invalid-multiplier", provider_resource_id: "11111111-1111-4111-8111-111111111111",
    upstream_model: "test", effective_from: "2026-09-01T00:00", effective_to: "", windows: [],
    cache_hit_price: "0", cache_miss_price: "0.1", output_price: "0.2", multiplier, currency: "CNY", priority: 1 });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ["multiplier"], message: "填写正倍率与三项基础单价，零价请明确填 0" }),
  ]));
});
