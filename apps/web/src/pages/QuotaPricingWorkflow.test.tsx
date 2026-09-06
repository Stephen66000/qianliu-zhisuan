import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BillingRule, ModelRouteItem, ProviderResourceItem, UnifiedModel } from "../api/types";
import { QuotaRulesPage } from "./QuotaRules";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dates = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const models: UnifiedModel[] = [1, 2].map((n) => ({ id: uuid(n), enterprise_id: uuid(99), alias: `model-${n}`,
  display_name: `模型${n}`, status: "PENDING_CONFIG", required_capabilities: null, version: 1,
  archived_at: null, archived_by_admin_id: null, ...dates }));
const resources: ProviderResourceItem[] = [10, 11, 12].map((n) => ({ id: uuid(n), provider_id: uuid(n === 12 ? 91 : 90),
  name: n === 12 ? "Kimi套餐" : `DeepSeek资源${n}`, mode: n === 12 ? "CODING_PLAN" : "API", credential_type: "API_KEY",
  credential_fingerprint: null, credential_version: 1, status: "ACTIVE", consecutive_failures: 0,
  cooldown_until: null, last_probe_at: null, credential_refresh_status: "NONE", refresh_error_classification: null,
  credential_expires_at: null, resource_pool_id: null, upstream_models: ["upstream"], concurrency_limit: 1,
  version: 1, operating_snapshot: null, ...dates }));
const routes: ModelRouteItem[] = [10, 11, 12].map((n) => ({ id: uuid(n + 10), enterprise_id: uuid(99),
  unified_model_id: models[0]!.id, provider_resource_id: uuid(n), upstream_model: "upstream", priority: 100, weight: 1,
  enabled: false, version: 1, archived_at: null, archived_by_admin_id: null, ...dates }));
function rule(n: number, extra: Partial<BillingRule> = {}): BillingRule {
  return { id: uuid(n), rule_type: "API_PRICE", rule_version: `price-${n}`, provider_resource_id: uuid(10), upstream_model: "upstream",
    effective_from: "2026-01-01T00:00:00Z", effective_to: null, timezone: null, days_of_week: null,
    start_time: null, end_time: null, time_windows: null, multiplier: null, pricing_mode: "ABSOLUTE",
    cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004", currency: "CNY",
    priority: 100, enabled: true, source: "TEST", version: 1, archived_at: null, archived_by_admin_id: null, ...dates, ...extra };
}
type Submission = { submission_id: string; route_id: string; expected_route_version: number; expected_model_version: number;
  priority: number; weight: number; source_rule_ids: string[]; replace_existing: boolean;
  rules: Array<{ rule_version: string; provider_resource_id: string; upstream_model: string; currency: string;
    multiplier: string | null; cache_hit_price: string | null; cache_miss_price: string | null; output_price: string | null;
    windows: unknown[] | null; pricing_mode: string }> };
let saved: Submission[];
let existing: BillingRule[];
let rejectSave: boolean;
let client: QueryClient;
beforeEach(() => {
  saved = []; existing = []; rejectSave = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.split("?")[0];
    if (path === "/api/pricing-configurations") {
      saved.push(JSON.parse(String(options?.body)) as Submission);
      return Response.json(rejectSave ? { error: "conflict", message: "配置版本已变化，请刷新" } : { ruleIds: [uuid(40)] }, { status: rejectSave ? 409 : 201 });
    }
    const data: Record<string, unknown> = {
      "/api/billing-rules": { rules: existing }, "/api/dispatch-policies": { policies: [] },
      "/api/pricing-ready-routes": { routes: [] }, "/api/unified-models": { models },
      "/api/provider-resources": { resources }, "/api/principals": { principals: [] },
      [`/api/unified-models/${uuid(1)}/routes`]: { routes }, [`/api/unified-models/${uuid(2)}/routes`]: { routes: [] },
    };
    if (!(path! in data)) throw new Error(`Unexpected boundary request: ${url}`);
    return Response.json(data[path!]);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
async function open(target = uuid(21)) {
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><MemoryRouter><QuotaRulesPage /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: "新建规则" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "新建规则" }));
  await screen.findByRole("option", { name: /DeepSeek资源11.*upstream/ });
  await user.selectOptions(screen.getByLabelText("厂商资源", { exact: true }), target);
  return user;
}
async function fillPrices(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("缓存命中输入单价（币种/Token）"), "0.000001");
  await user.type(screen.getByLabelText("未命中输入单价（币种/Token）"), "0.000002");
  await user.type(screen.getByLabelText("输出单价（币种/Token）"), "0.000004");
}

it("saves pending model/route and explicit multiplier prices in one request", async () => {
  const user = await open();
  await user.selectOptions(screen.getByLabelText("计价方式"), "MULTIPLIER");
  await user.type(screen.getByLabelText("有效倍率（API 倍率模式 / 套餐扣减）"), "3");
  await user.selectOptions(screen.getByLabelText("币种"), "USD");
  await fillPrices(user);
  expect(screen.getByLabelText("有效单价预览")).toHaveTextContent("输出 12");
  await user.clear(screen.getByLabelText("路由优先级")); await user.type(screen.getByLabelText("路由优先级"), "80");
  await user.clear(screen.getByLabelText("路由权重")); await user.type(screen.getByLabelText("路由权重"), "2");
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({ route_id: uuid(21), expected_route_version: 1, expected_model_version: 1,
    priority: 80, weight: 2, source_rule_ids: [], rules: [{ pricing_mode: "MULTIPLIER", multiplier: "3", currency: "USD",
      cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004", provider_resource_id: uuid(11) }] });
  await waitFor(() => expect(screen.queryByRole("button", { name: "保存并启用" })).not.toBeInTheDocument());
});

it("refuses missing prices and retains the draft and idempotency key after a conflict", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  expect(saved).toHaveLength(0);
  expect(await screen.findAllByText("请填写单价，免费项目请明确填 0")).toHaveLength(2);
  expect(screen.getByText("至少填写一个单价")).toBeInTheDocument();
  await fillPrices(user); rejectSave = true;
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await screen.findByText("配置版本已变化，请刷新");
  expect(screen.getByLabelText("输出单价（币种/Token）")).toHaveValue("0.000004");
  rejectSave = false;
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await waitFor(() => expect(saved).toHaveLength(2));
  expect(saved[1]).toEqual(saved[0]);
});

it("copies the full same-provider set with different effective dates and allows queue editing", async () => {
  existing = [rule(30), rule(31, { effective_from: "2026-02-01T00:00:00Z", time_windows: [{ timezone: "Asia/Shanghai",
    days_of_week: [1, 2], start_time: "14:00", end_time: "18:00" }] }), rule(32, { provider_resource_id: uuid(12) })];
  const user = await open();
  const copy = screen.getByLabelText("沿用同厂商整套价格");
  expect(copy).not.toHaveTextContent("price-32");
  await user.selectOptions(copy, uuid(30));
  expect(screen.getByText(/已沿用 2 条规则/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect((screen.getByLabelText("规则版本") as HTMLInputElement).value).toMatch(/^price-30-/);
  await user.click(screen.getByLabelText(/从新生效时间起替换/));
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]!.source_rule_ids.sort()).toEqual([uuid(30), uuid(31)]);
  expect(saved[0]!.rules).toHaveLength(2);
  expect(saved[0]!.rules.every((r) => r.provider_resource_id === uuid(11))).toBe(true);
  expect(saved[0]!.rules.find((r) => r.windows)?.windows).toEqual([{ timezone: "Asia/Shanghai", days_of_week: [1, 2], start_time: "14:00", end_time: "18:00" }]);
  expect(saved[0]!.replace_existing).toBe(true);
});

it("clears copied prices and queued rules when switching resource or model", async () => {
  existing = [rule(30)]; const user = await open();
  await user.selectOptions(screen.getByLabelText("沿用同厂商整套价格"), uuid(30));
  await user.click(screen.getByRole("button", { name: "加入规则集并配置下一时段" }));
  await user.selectOptions(screen.getByLabelText("厂商资源", { exact: true }), uuid(22));
  expect(screen.getByLabelText("规则类型")).toHaveValue("MODEL_TIER");
  expect(screen.getByLabelText("输出单价（币种/Token）")).toHaveValue("");
  expect(screen.queryByText(/已沿用/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("模型", { exact: true }), uuid(2));
  expect(screen.getByLabelText("厂商资源", { exact: true })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  expect(saved).toHaveLength(0);
});

it("adds/removes windows and queued rules before saving the reviewed set", async () => {
  const user = await open(); await fillPrices(user);
  await user.click(screen.getByRole("button", { name: "加入规则集并配置下一时段" }));
  await user.click(screen.getByRole("button", { name: "添加窗口" }));
  expect(screen.getByLabelText("开始（含）")).toHaveValue("09:00");
  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(screen.queryByLabelText("开始（含）")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "移除" }));
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]!.rules).toHaveLength(1);
  expect(saved[0]!.rules[0]!.windows).toBeNull();
});

it("clearing the resource resets route defaults and prevents a stale-resource submission", async () => {
  const user = await open(); await fillPrices(user);
  await user.selectOptions(screen.getByLabelText("厂商资源", { exact: true }), "");
  expect(screen.getByLabelText("路由优先级")).toHaveValue(100);
  expect(screen.getByLabelText("路由权重")).toHaveValue(1);
  expect(screen.getByLabelText("输出单价（币种/Token）")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await screen.findByText("请选择资源", { selector: "[role=alert]" });
  expect(saved).toHaveLength(0);
});

it("取消新建规则丢弃整套草稿、沿用来源及错误，重新打开可正常新建", async () => {
  existing = [rule(30), rule(31, { time_windows: [{ timezone: "Asia/Shanghai",
    days_of_week: [1, 2, 3, 4, 5], start_time: "14:00", end_time: "18:00" }] })];
  const user = await open();
  expect(screen.queryByText("已有模型与路由管理")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("沿用同厂商整套价格"), uuid(30));
  await user.click(screen.getByLabelText(/从新生效时间起替换/));
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(saved).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "保存并启用" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "新建规则" }));
  expect(screen.getByLabelText("厂商资源", { exact: true })).toHaveValue("");
  expect(screen.getByLabelText("规则版本")).toHaveValue("v1");
  expect(screen.getByLabelText("输出单价（币种/Token）")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
  expect(screen.queryByText(/已沿用/)).not.toBeInTheDocument();
  expect(screen.getByLabelText(/从新生效时间起替换/)).not.toBeChecked();
  await user.selectOptions(screen.getByLabelText("厂商资源", { exact: true }), uuid(21));
  await fillPrices(user); rejectSave = true;
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await screen.findByText("配置版本已变化，请刷新");
  const firstId = saved[0]!.submission_id;
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "新建规则" }));
  await user.selectOptions(screen.getByLabelText("厂商资源", { exact: true }), uuid(21));
  await fillPrices(user); rejectSave = false;
  await user.click(screen.getByRole("button", { name: "保存并启用" }));
  await waitFor(() => expect(saved).toHaveLength(2));
  expect(saved[1]).toMatchObject({ source_rule_ids: [], replace_existing: false });
  expect(saved[1]!.rules).toHaveLength(1);
  expect(saved[1]!.submission_id).not.toBe(firstId);
});

it("取消新建调度策略不发送写请求，重新打开恢复空白草稿", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("tab", { name: "调度策略" }));
  await user.click(screen.getByRole("button", { name: "新建调度策略" }));
  await user.clear(screen.getByLabelText("策略版本"));
  await user.type(screen.getByLabelText("策略版本"), "discard-me");
  await user.type(screen.getByLabelText("说明"), "未保存的策略");
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("button", { name: "创建草稿" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "新建调度策略" }));
  expect(screen.getByLabelText("策略版本")).toHaveValue("v1");
  expect(screen.getByLabelText("说明")).toHaveValue("");
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});
