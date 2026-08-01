import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeAssurancePage } from "./RuntimeAssurance";

const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();

vi.mock("../api/client", () => ({
  get: (...args: unknown[]) => getMock(...args),
  post: (...args: unknown[]) => postMock(...args),
  patch: (...args: unknown[]) => patchMock(...args),
}));
vi.mock("../api/hooks", () => ({
  useAlerts: () => ({ data: { alerts: [], history: [] }, isLoading: false, error: null, refetch: vi.fn() }),
  usePrincipals: () => ({ data: { principals: [] }, isLoading: false, error: null, refetch: vi.fn() }),
}));

function renderPage(entry = "/runtime-assurance") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><RuntimeAssurancePage /></MemoryRouter></QueryClientProvider>);
}

describe("RA-W07 运行保障一级模块", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation(async (path: string) => {
      if (path === "/runtime-assurance/overview") return { resources: { ACTIVE: 2 }, open_event_count: 0, blocked_resource_count: 0, affected_request_count: 0, next_recover_at: null };
      if (path.startsWith("/availability-rules")) return { rules: [] };
      if (path.startsWith("/availability-events")) return { events: [] };
      if (path === "/notification-endpoints/wecom-app") return { endpoint: null };
      if (path === "/people") return { people: [] };
      if (path.startsWith("/notification-deliveries")) return { deliveries: [] };
      return {};
    });
    postMock.mockResolvedValue({});
    patchMock.mockResolvedValue({});
  });

  it("展示五个功能区并默认加载运行态势", async () => {
    renderPage();
    for (const label of ["运行态势", "可用性规则", "熔断事件", "异常中心", "通知与人员"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByText("活跃熔断")).toBeInTheDocument();
  });

  it("规则页可新建草稿，参数不包含租户字段", async () => {
    const user = userEvent.setup();
    renderPage("/runtime-assurance?tab=rules");
    await screen.findByText("新建草稿");
    await user.type(screen.getByLabelText("规则名称"), "智谱额度熔断");
    await user.click(screen.getByRole("button", { name: "新建草稿" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/availability-rules", expect.objectContaining({ name: "智谱额度熔断" })));
    const payload = postMock.mock.calls[0]![1];
    expect(payload).not.toHaveProperty("tenant_id");
    expect(payload).not.toHaveProperty("enterprise_id");
  });

  it("通知区只配置企微自建应用和内部 userid", async () => {
    renderPage("/runtime-assurance?tab=notifications");
    expect(await screen.findByText("企业微信自建应用")).toBeInTheDocument();
    expect(screen.getByLabelText("企微 userid")).toBeInTheDocument();
    expect(screen.queryByText(/机器人|Webhook|通知群/)).not.toBeInTheDocument();
  });
});
