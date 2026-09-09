import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AlertsPanel } from "./AlertsPanel";
import { fault } from "./__tests__/fixture";
const m = vi.hoisted(() => ({
  alerts: vi.fn(),
  principals: vi.fn(),
  resources: vi.fn(),
  providers: vi.fn(),
  post: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../../api/hooks", () => ({
  QUERY_KEYS: { alerts: ["alerts"] },
  useAlerts: m.alerts,
  usePrincipals: m.principals,
  useProviderResources: m.resources,
  useProviders: m.providers,
}));
vi.mock("../../api/client", () => ({ post: m.post }));
vi.mock("../RequestDrilldown", () => ({
  RequestDrilldown: ({ requestId }: { requestId: string }) => (
    <div>请求 {requestId}</div>
  ),
}));
const first = fault({
  title: "FIRST",
  detail: "DETAIL",
  model: "MODEL",
  aiRequestId: "REQUEST",
  signal: "TECHNICAL_FAILURE",
});
const second = fault({
  id: "second",
  alertKey: "SECOND:key",
  title: "SECOND",
  principalId: null,
  resourceId: null,
  firstSeenAt: "2026-09-02T00:00:00Z",
  signal: "OTHER",
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime("2026-09-08T00:00:00Z");
  m.alerts.mockReturnValue({
    data: { alerts: [first, second], history: [] },
    isLoading: false,
    error: null,
    refetch: m.retry,
  });
  m.principals.mockReturnValue({
    data: { principals: [{ id: "p", name: "PERSON" }] },
    error: null,
    refetch: m.retry,
  });
  m.resources.mockReturnValue({
    data: { resources: [{ id: "r", name: "RESOURCE", provider_id: "v" }] },
    error: null,
    refetch: m.retry,
  });
  m.providers.mockReturnValue({
    data: { providers: [{ id: "v", name: "PROVIDER", code: "VENDOR_CODE" }] },
    error: null,
    refetch: m.retry,
  });
  m.post.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
});
function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (
    <QueryClientProvider client={client}>
      <AlertsPanel />
    </QueryClientProvider>
  );
  return {
    ...render(element),
    refresh: function () {
      this.rerender(element);
    },
    client,
  };
}
it("deduplicates by id, excludes obsolete warnings and sorts by occurrence without hiding unmatched relations", () => {
  m.alerts.mockReturnValue({
    data: {
      alerts: [first, second, fault({ id: "warning", domain: "USAGE_SPIKE" })],
      history: [first],
    },
    isLoading: false,
    error: null,
  });
  page();
  expect(m.alerts).toHaveBeenCalledWith(true);
  expect(m.principals).toHaveBeenCalledWith("all");
  expect(screen.getByText("共 2 条异常")).toBeInTheDocument();
  expect(
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent?.includes("SECOND")),
  ).toEqual([true, false]);
  expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(
    [
      "发生时间",
      "使用主体",
      "厂商 / 资源",
      "异常内容",
      "是否处理",
      "恢复情况",
      "详情",
    ],
  );
});
it.each([
  "first",
  "detail",
  "technical_failure",
  "runtime_assurance",
  "request",
  "model",
  "resource",
  "provider",
  "vendor_code",
  "person",
])("search matches %s with trimming and case normalization", (needle) => {
  page();
  fireEvent.change(screen.getByLabelText("搜索异常"), {
    target: { value: "  " + needle + "  " },
  });
  expect(screen.getByText("FIRST")).toBeInTheDocument();
  expect(screen.queryByText("SECOND")).not.toBeInTheDocument();
});
it.each(["principals", "resources", "providers"] as const)(
  "isolates %s lookup failure without hiding faults",
  (name) => {
    m[name].mockReturnValue({
      data: undefined,
      error: new Error("lookup"),
      refetch: m.retry,
    });
    page();
    expect(screen.getByText("FIRST")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("异常事实仍保留显示");
    if (name === "principals")
      expect(screen.getByLabelText("异常使用主体")).toBeDisabled();
    else expect(screen.getByLabelText("异常使用主体")).toBeEnabled();
    if (name !== "principals")
      expect(screen.getByLabelText("异常厂商")).toBeDisabled();
    else expect(screen.getByLabelText("异常厂商")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试关联信息" }));
    expect(m.retry).toHaveBeenCalledTimes(3);
  },
);
it("selection tracks refreshed objects and closes if the selected event disappears", () => {
  const client = new QueryClient();
  const tree = () => (
    <QueryClientProvider client={client}>
      <AlertsPanel />
    </QueryClientProvider>
  );
  const view = render(tree());
  fireEvent.click(
    within(screen.getByText("FIRST").closest("tr")!).getByRole("button", {
      name: "查看",
    }),
  );
  expect(screen.queryByLabelText("处理说明")).not.toBeInTheDocument();
  m.alerts.mockReturnValue({
    data: { alerts: [], history: [] },
    isLoading: false,
    error: null,
  });
  view.rerender(tree());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("当前筛选条件下没有异常")).toBeInTheDocument();
});
it("submits trimmed explanations for the exact selected event and allows retry after a failure", async () => {
  page();
  fireEvent.change(screen.getByLabelText("FIRST 是否处理"), {
    target: { value: "yes" },
  });
  fireEvent.change(screen.getByLabelText("处理说明"), {
    target: { value: "  已核对  " },
  });
  m.post.mockRejectedValueOnce(new Error("failed"));
  fireEvent.click(screen.getByRole("button", { name: "保存处理说明" }));
  await waitFor(() =>
    expect(screen.getByText("处理状态保存失败，请重试。")).toBeInTheDocument(),
  );
  expect(screen.getByLabelText("处理说明")).toHaveValue("  已核对  ");
  fireEvent.click(screen.getByRole("button", { name: "保存处理说明" }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post).toHaveBeenLastCalledWith("/alerts/disposition", {
    alert_key: first.alertKey,
    alert_id: first.id,
    status: "RESOLVED",
    resolution_note: "已核对",
  });
});
it("supports an empty month, nonmatching principals and providers, and stable empty/error presentation", () => {
  page();
  fireEvent.change(screen.getByLabelText("异常月份"), {
    target: { value: "" },
  });
  expect(screen.getByText("共 2 条异常")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("异常使用主体"), {
    target: { value: "p" },
  });
  expect(screen.queryByText("SECOND")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("异常厂商"), {
    target: { value: "v" },
  });
  expect(screen.getByText("FIRST")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索异常"), {
    target: { value: "absent" },
  });
  expect(screen.getByText("当前筛选条件下没有异常")).toBeInTheDocument();
});
