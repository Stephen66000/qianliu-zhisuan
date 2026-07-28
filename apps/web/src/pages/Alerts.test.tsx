/**
 * W20 异常告警单测 —— 看板渲染 / 标记已处理 / 运行正常空态。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertItem } from "../api/types";
import { AlertsPage } from "./Alerts";

const useAlertsMock = vi.fn();
const postMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useAlerts: (history: boolean) => useAlertsMock(history),
  QUERY_KEYS: { alerts: ["alerts"] },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    post: (...args: unknown[]) => postMock(...args),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateMock }),
    useMutation: (options: {
      mutationFn: (v: unknown) => Promise<unknown>;
      onSuccess?: () => void;
    }) => ({
      mutate: async (vars: unknown) => {
        await options.mutationFn(vars);
        options.onSuccess?.();
      },
      isPending: false,
      error: null,
    }),
  };
});

// 下钻组件重，mock 掉避免嵌套 query
vi.mock("./RequestDrilldown", () => ({
  RequestDrilldown: ({ requestId }: { requestId: string }) => (
    <div data-testid="drilldown">{requestId}</div>
  ),
}));

function alert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: "a1",
    alertKey: "CREDENTIAL_INVALID:credential_invalid:r1",
    domain: "CREDENTIAL_INVALID",
    signal: "credential_invalid",
    severity: "HIGH",
    title: "凭证失效：Kimi 账号",
    detail: "资源状态 CREDENTIAL_INVALID，需重新授权",
    resourceId: "r1",
    principalId: null,
    aiRequestId: null,
    status: "OPEN",
    firstSeenAt: "2026-07-28T00:00:00.000Z",
    lastSeenAt: "2026-07-28T00:00:00.000Z",
    resolvedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AlertsPage />
    </MemoryRouter>,
  );
}

describe("W20 异常告警", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ ok: true });
  });

  it("无告警：显示运行正常（PRD §10.4）", () => {
    useAlertsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { alerts: [] },
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("运行正常")).toBeInTheDocument();
    expect(screen.getByText(/当前没有未处理告警/)).toBeInTheDocument();
  });

  it("渲染未处理告警与域标签", () => {
    useAlertsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { alerts: [alert()] },
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("凭证失效：Kimi 账号")).toBeInTheDocument();
    expect(screen.getByText("凭证失效")).toBeInTheDocument();
    expect(screen.getByText("未处理")).toBeInTheDocument();
    expect(screen.getByText("HIGH")).toBeInTheDocument();
  });

  it("标记已处理：调用 disposition 并刷新", async () => {
    useAlertsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { alerts: [alert()] },
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "标记已处理" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/alerts/disposition",
        expect.objectContaining({
          alert_key: "CREDENTIAL_INVALID:credential_invalid:r1",
          status: "RESOLVED",
        }),
      );
    });
    await waitFor(() => {
      expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ["alerts"] });
    });
  });

  it("已处理告警默认隐藏，勾选后显示", async () => {
    useAlertsMock.mockImplementation((history: boolean) => ({
      isLoading: false,
      error: null,
      data: history
        ? { alerts: [], history: [alert({ status: "RESOLVED" })] }
        : { alerts: [] },
      refetch: vi.fn(),
    }));
    const user = userEvent.setup();
    renderPage();
    // 默认只显示未处理 → 空态
    expect(screen.getByText("运行正常")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/显示已处理历史/));
    expect(screen.getByText("凭证失效：Kimi 账号")).toBeInTheDocument();
    expect(screen.getByText("已处理")).toBeInTheDocument();
  });

  it("有 aiRequestId 的告警可追踪请求", async () => {
    useAlertsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { alerts: [alert({ aiRequestId: "req-123" })] },
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "追踪请求" }));
    expect(screen.getByTestId("drilldown")).toHaveTextContent("req-123");
  });
});
