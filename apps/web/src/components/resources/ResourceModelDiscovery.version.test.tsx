import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { CreateModelDiscoveryPanel, type ModelDiscoveryResponse } from "./ResourceModelDiscovery";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); });
function discovery(version: string | null | undefined): ModelDiscoveryResponse {
  return { source: "PROVIDER_API", source_version: "deepseek-list-models-v2", discovered_at: "2026-09-10T00:00:00Z",
    models: [{ id: "deepseek-v4-flash", displayName: "deepseek-v4-flash", modelType: "CHAT",
      capabilities: ["chat", "stream"], source: "PROVIDER_API", compatible: true, unavailableReason: null,
      facts: { officialVersion: version, fieldEvidence: version ? { official_version: [{
        url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", checkedAt: "2026-09-10T00:00:00Z", extractedValue: version,
      }] } : {} } }] };
}
function view(data: ModelDiscoveryResponse) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const selected = vi.fn(), getCredentials = vi.fn(() => ({ provider_id: "provider", mode: "API" as const, credential_plaintext: "" }));
  render(<QueryClientProvider client={client}><CreateModelDiscoveryPanel discovery={data}
    getCredentials={getCredentials} onDiscovery={vi.fn()} onSelectedModelIdsChange={selected}
    onValidationError={vi.fn()} selectedModelIds={[]} /></QueryClientProvider>);
  return { selected, getCredentials };
}

it("版本展示在调用名称下方，悬停可查官方来源和检查时间", () => {
  view(discovery("DeepSeek-V4-Flash-0731"));
  expect(screen.getByText("deepseek-v4-flash", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("官方模型版本：DeepSeek-V4-Flash-0731")).toHaveAttribute("title",
    expect.stringContaining("https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"));
  expect(screen.getByText("官方模型版本：DeepSeek-V4-Flash-0731").title).toContain("2026");
});

it("勾选或全选依然提交原API模型ID，不提交官方版本字符串", async () => {
  const user = userEvent.setup(), { selected, getCredentials } = view(discovery("DeepSeek-V4-Flash-0731"));
  await user.click(screen.getByRole("checkbox"));
  expect(selected).toHaveBeenLastCalledWith(["deepseek-v4-flash"]);
  await user.click(screen.getByRole("button", { name: "全选兼容模型" }));
  expect(selected).toHaveBeenLastCalledWith(["deepseek-v4-flash"]);
  expect(getCredentials).not.toHaveBeenCalled();
});

it("未获取版本时明确显示未知，不影响原有模型选择", () => {
  view(discovery(null));
  expect(screen.getByText("官方模型版本：未获取")).toBeInTheDocument();
  expect(screen.getByRole("checkbox")).toBeEnabled();
});

it("兼容没有版本字段的历史快照和其他厂商", () => {
  view(discovery(undefined));
  expect(screen.queryByText(/官方模型版本/)).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox")).toBeEnabled();
});
