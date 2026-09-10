import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccessContext, type Access } from "../permissions";
import type { UnifiedModel } from "../api/types";
import { QuotaRulesPage } from "./QuotaRules";

let models: UnifiedModel[];
let writes: Array<{ path: string; body: unknown }>;
let failure: boolean;
let releaseWrite: (() => void) | undefined;
let deferWrite: boolean;
let client: QueryClient;
const pro = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  writes = []; failure = false; deferWrite = false; releaseWrite = undefined;
  models = ["Flash", "Pro", "Disabled", "Archived", "Pending"].map((name, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, enterprise_id: "enterprise",
    alias: `ql-${name.toLowerCase()}`, display_name: name, version: i + 8,
    status: ["Disabled", "Archived"].includes(name) ? "DISABLED" : name === "Pending" ? "PENDING_CONFIG" : "ACTIVE",
    required_capabilities: null, archived_at: name === "Archived" ? "2026-01-01T00:00:00Z" : null,
    archived_by_admin_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (options?.method === "PATCH") {
      writes.push({ path, body: JSON.parse(String(options.body)) });
      if (deferWrite) await new Promise<void>((resolve) => { releaseWrite = resolve; });
      if (failure) return Response.json({ error: "version_conflict", message: "模型已被其他管理员修改，请刷新后重试" }, { status: 409 });
      const id = path.split("/").pop();
      models = models.map((model) => model.id === id ? { ...model, status: "DISABLED", version: model.version + 1 } : model);
      return Response.json({ model: models.find((model) => model.id === id) });
    }
    if (options?.method === "POST" && /\/unified-models\/[^/]+\/(archive|unarchive)$/.test(path)) {
      writes.push({ path, body: JSON.parse(String(options.body)) });
      if (deferWrite) await new Promise<void>((resolve) => { releaseWrite = resolve; });
      if (failure) return Response.json({ error: "invalid_state", message: "模型状态或版本已变化" }, { status: 409 });
      const id = path.split("/").at(-2), archived = path.endsWith("/archive");
      models = models.map((model) => model.id === id ? { ...model,
        archived_at: archived ? "2026-09-10T00:00:00Z" : null, version: model.version + 1 } : model);
      return Response.json({ model: models.find((model) => model.id === id) });
    }
    const data: Record<string, unknown> = {
      "/api/unified-models": { models }, "/api/reference-data/models": { models },
      "/api/provider-resources": { resources: [] }, "/api/reference-data/resources": { resources: [] },
      "/api/principals": { principals: [] }, "/api/reference-data/principals": { principals: [] },
      "/api/billing-rules": { rules: [] }, "/api/dispatch-policies": { policies: [] },
      "/api/pricing-ready-routes": { routes: [] },
    };
    if (/\/unified-models\/[^/]+\/routes$/.test(path)) return Response.json({ routes: [] });
    if (!(path in data)) throw new Error(`Unexpected boundary: ${path}`);
    return Response.json(data[path]);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});
afterEach(() => { releaseWrite?.(); cleanup(); client.clear(); vi.unstubAllGlobals(); });
async function open(access: Access = { roleCode: "SUPER_ADMIN" }) {
  render(<QueryClientProvider client={client}><AccessContext.Provider value={access}>
    <MemoryRouter><QuotaRulesPage /></MemoryRouter></AccessContext.Provider></QueryClientProvider>);
  await screen.findByRole("option", { name: "Pro（ql-pro）" });
  return userEvent.setup();
}

it("停用入口明确且不恢复旧管理区，未选择/已停用/待配置时不能执行", async () => {
  const user = await open();
  expect(screen.queryByText("已有模型与路由管理")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "新建统一模型" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "新建路由" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "停用模型" })).toBeDisabled();
  expect(screen.queryByRole("option", { name: "Archived（ql-archived）" })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("模型管理"), models[2]!.id);
  expect(screen.getByRole("status")).toHaveTextContent("已停用");
  expect(screen.getByRole("button", { name: "停用模型" })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("模型管理"), models[4]!.id);
  expect(screen.getByRole("status")).toHaveTextContent("待配置");
  expect(screen.getByRole("button", { name: "停用模型" })).toBeDisabled();
  expect(writes).toEqual([]);
});

it("取消零写入；确认只按版本停用选中的Pro，刷新状态和调度目录", async () => {
  const user = await open();
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  await user.click(screen.getByRole("button", { name: "停用模型" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Pro」（ql-pro）");
  expect(screen.getByRole("dialog")).toHaveTextContent("历史用量、账本和价格记录保留");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  expect(writes).toEqual([]);
  const readsBefore = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("pricing-ready-routes")).length;
  await user.click(screen.getByRole("button", { name: "停用模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认停用" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已停用"));
  expect(writes).toEqual([{ path: `/api/unified-models/${pro}`, body: { expected_version: 9, status: "DISABLED" } }]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "停用模型" })).toBeDisabled();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("pricing-ready-routes")).length).toBeGreaterThan(readsBefore));
  await user.selectOptions(screen.getByLabelText("模型管理"), models[0]!.id);
  expect(screen.getByRole("status")).toHaveTextContent("启用中");
  expect(screen.getByRole("button", { name: "停用模型" })).toBeEnabled();
});

it("版本冲突不伪装成功、不影响其他模型；可取消退出", async () => {
  failure = true;
  const user = await open();
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  await user.click(screen.getByRole("button", { name: "停用模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认停用" }));
  await screen.findByText("模型已被其他管理员修改，请刷新后重试");
  expect(screen.getByRole("status")).toHaveTextContent("启用中");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  expect(writes).toHaveLength(1);
  expect(models[0]!.status).toBe("ACTIVE"); expect(models[1]!.status).toBe("ACTIVE");
});

it("提交期间不可重复确认或切换目标，Escape不伪装为取消请求", async () => {
  deferWrite = true;
  const user = await open();
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  await user.click(screen.getByRole("button", { name: "停用模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认停用" }));
  await screen.findByRole("button", { name: "处理中…" });
  expect(screen.getByLabelText("模型管理")).toBeDisabled();
  expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(writes).toHaveLength(1);
  releaseWrite!();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("仅查看或缺少厂商操作权限时不能停用模型", async () => {
  const user = await open({ roleCode: "CUSTOM", permissions: { quota: { view: true, operate: true }, resources: { view: true, operate: false } } });
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  expect(screen.getByRole("button", { name: "停用模型" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "停用模型" })).toHaveAttribute("title", "需要额度规则和厂商资源的操作权限");
  expect(writes).toEqual([]);
});

it("停用后可存档：取消不写入；存档默认隐藏；取消存档仍保持停用", async () => {
  const user = await open();
  const resourceReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/provider-resources").length;
  const readsBefore = resourceReads();
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  expect(screen.getByRole("button", { name: "存档模型" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "停用模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认停用" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "存档模型" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "存档模型" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("存档模型「Pro」（ql-pro）");
  expect(screen.getByRole("dialog")).toHaveTextContent("取消存档不会自动启用");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  expect(writes).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "存档模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认归档" }));
  await waitFor(() => expect(screen.queryByRole("option", { name: "Pro（ql-pro）" })).not.toBeInTheDocument());
  expect(screen.getByLabelText("模型管理")).toHaveValue("");
  await user.click(screen.getByLabelText("查看存档"));
  await screen.findByRole("option", { name: "Pro（ql-pro）" });
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  expect(screen.getByRole("status")).toHaveTextContent("已存档");
  expect(screen.queryByRole("button", { name: "停用模型" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "取消存档" }));
  await waitFor(() => expect(screen.queryByRole("option", { name: "Pro（ql-pro）" })).not.toBeInTheDocument());
  await user.click(screen.getByLabelText("查看存档"));
  await user.selectOptions(screen.getByLabelText("模型管理"), pro);
  expect(screen.getByRole("status")).toHaveTextContent("已停用");
  expect(screen.getByRole("button", { name: "停用模型" })).toBeDisabled();
  expect(writes).toEqual([
    { path: `/api/unified-models/${pro}`, body: { expected_version: 9, status: "DISABLED" } },
    { path: `/api/unified-models/${pro}/archive`, body: { expected_version: 10 } },
    { path: `/api/unified-models/${pro}/unarchive`, body: { expected_version: 11 } },
  ]);
  expect(models[0]!.status).toBe("ACTIVE"); expect(models[0]!.archived_at).toBeNull();
  await waitFor(() => expect(resourceReads()).toBeGreaterThanOrEqual(readsBefore + 2));
});

it("存档失败保留模型和对话框，不伪装为已隐藏", async () => {
  failure = true;
  const user = await open();
  await user.selectOptions(screen.getByLabelText("模型管理"), models[2]!.id);
  await user.click(screen.getByRole("button", { name: "存档模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认归档" }));
  await screen.findByText("模型状态或版本已变化");
  expect(screen.getByRole("status")).toHaveTextContent("已停用");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(models[2]!.archived_at).toBeNull(); expect(writes).toHaveLength(1);
});

it("存档提交中禁用重复操作，Escape不能将已发出的请求当作取消", async () => {
  deferWrite = true;
  const user = await open();
  await user.selectOptions(screen.getByLabelText("模型管理"), models[2]!.id);
  await user.click(screen.getByRole("button", { name: "存档模型" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认归档" }));
  await screen.findByRole("button", { name: "处理中…" });
  expect(screen.getByRole("button", { name: "存档模型" })).toBeDisabled();
  expect(screen.getByLabelText("模型管理")).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(writes).toHaveLength(1);
  releaseWrite!();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("无操作权限不能存档或取消存档", async () => {
  const user = await open({ roleCode: "CUSTOM", permissions: { quota: { view: true, operate: false }, resources: { view: true, operate: false } } });
  await user.selectOptions(screen.getByLabelText("模型管理"), models[2]!.id);
  expect(screen.getByRole("button", { name: "存档模型" })).toBeDisabled();
  await user.click(screen.getByLabelText("查看存档"));
  await user.selectOptions(screen.getByLabelText("模型管理"), models[3]!.id);
  expect(screen.getByRole("button", { name: "取消存档" })).toBeDisabled();
  expect(writes).toEqual([]);
});
