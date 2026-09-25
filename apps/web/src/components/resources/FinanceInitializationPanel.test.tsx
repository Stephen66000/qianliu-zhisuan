/**
 * 资金标签页容器测试（WP05 任务 5.1、5.5；PFU-01、PFU-06）。
 *
 * 覆盖切换口径：未激活 ⇒ 初始化向导；已激活 ⇒ 日常资金面板 + 不可变回执；
 * OFF ⇒ 不渲染（保持既有封闭语义）；无 operate 权限 ⇒ 只读。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderResourceItem } from "../../api/types";
import type {
  ActivationStateView, ProviderFinanceActivationMode,
} from "../../api/provider-finance-activation-types";
import { AccessContext } from "../../permissions";
import { ProviderFinanceModeProvider } from "../../feature-flags";
import { FinanceInitializationPanel } from "./FinanceInitializationPanel";

const mocks = vi.hoisted(() => ({
  state: { isLoading: false, data: undefined as ActivationStateView | undefined, error: null as Error | null },
  refetch: vi.fn(),
}));

vi.mock("../../api/provider-finance-activation", () => ({
  useProviderFinanceActivationState: () => ({ ...mocks.state, refetch: mocks.refetch }),
  // 容器只负责切换；向导自身的写入口在 ProviderFinanceActivationWizard.test.tsx 覆盖，
  // 这里给出最小可用替身，避免容器测试被无关的写钩子绑死。
  ACTIVATION_QUERY_KEY: ["provider-finance-activation", "state"],
  useActivationPreview: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useActivateProviderFinance: () => ({ mutate: vi.fn(), isPending: false, error: null, isSuccess: false }),
  useStartQuiescenceLease: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useReleaseQuiescenceLease: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("./ProviderFinancePanel", () => ({
  ProviderFinancePanel: ({ mode }: { mode: string }) => (
    <div data-testid="daily-finance-panel">日常资金面板 · {mode}</div>
  ),
}));

const CUTOVER = "2026-08-31T16:00:00.000Z";

function makeState(patch: Partial<ActivationStateView> = {}): ActivationStateView {
  return {
    mode: "ACTIVE", cutover_at: CUTOVER, strict_writes_enabled: false, scope_summary: null,
    quiescence: {
      status: null, active: false, started_at: null, expires_at: null, released_at: null,
      release_reason: null, remaining_seconds: 0, insufficient_for_activation: false,
      drain: {
        in_progress_requests: 0, open_attempts: 0, unpaired_usage_lines: 0,
        pending_ledger_transactions: 0, exonerated_usage_lines: 0, drained: true,
      },
    },
    latest_candidate: null, activation_receipt: null, activated_at: null,
    activated_by_admin_user_id: null, ...patch,
  };
}

const RECEIPT = {
  candidateId: "cand-1", candidateHash: "hash-1", factWatermarkHash: "wm-1",
  activatedAt: "2026-09-01T00:00:00.000Z", activatedByAdminUserId: "admin-1",
  factCounts: { openings: 2, recharges: 1, purchases: 1, carryovers: 0, legacyResolutions: 1, usageRepairs: 0 },
  monthsChecked: ["2026-08"], conservationPassed: true, conservationFailures: [],
};

const resources = [{ id: "res-1", name: "主账号", provider_id: "p-1", mode: "API" }] as ProviderResourceItem[];
const providers = [] as never[];

function view(options: {
  mode?: ProviderFinanceActivationMode;
  roleCode?: "SUPER_ADMIN" | "CUSTOM";
  permissions?: Record<string, { view: boolean; operate: boolean }>;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccessContext.Provider value={{ roleCode: options.roleCode ?? "SUPER_ADMIN", enterpriseId: "ent-1", permissions: options.permissions }}>
        <ProviderFinanceModeProvider value={options.mode ?? "ACTIVE"}>
          <FinanceInitializationPanel providers={providers} resources={resources} />
        </ProviderFinanceModeProvider>
      </AccessContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.state = { isLoading: false, data: makeState(), error: null };
  mocks.refetch.mockClear();
});

describe("状态切换", () => {
  it("未激活（strict_writes_enabled=false）展示初始化向导", () => {
    mocks.state.data = makeState({ strict_writes_enabled: false });
    view();
    expect(screen.getByTestId("activation-wizard")).toBeInTheDocument();
    expect(screen.queryByTestId("daily-finance-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("activation-quiescence")).toBeInTheDocument();
    expect(screen.getByTestId("activation-draft-editor")).toBeInTheDocument();
  });

  it("已激活展示日常资金面板与不可变激活回执，且不再展示向导", () => {
    mocks.state.data = makeState({
      strict_writes_enabled: true, activation_receipt: RECEIPT, activated_at: RECEIPT.activatedAt,
    });
    view();
    expect(screen.getByTestId("daily-finance-panel")).toBeInTheDocument();
    expect(screen.getByTestId("activation-receipt")).toHaveTextContent("严格资金写激活回执");
    expect(screen.getByTestId("activation-receipt")).toHaveTextContent("守恒通过");
    expect(screen.queryByTestId("activation-wizard")).not.toBeInTheDocument();
  });

  it("OFF 模式不渲染任何资金内容（保持既有封闭语义）", () => {
    mocks.state.data = makeState();
    const { container } = view({ mode: "OFF" });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("activation-wizard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("daily-finance-panel")).not.toBeInTheDocument();
  });

  it("状态读取失败时展示可重试的错误态，不伪装成已激活", () => {
    mocks.state.data = undefined;
    mocks.state.error = new Error("网络不可用");
    view();
    expect(screen.getByRole("alert")).toHaveTextContent("网络不可用");
    expect(screen.queryByTestId("daily-finance-panel")).not.toBeInTheDocument();
    screen.getByRole("button", { name: "重新读取" }).click();
    expect(mocks.refetch).toHaveBeenCalled();
  });
});

describe("权限", () => {
  it("无 resources.operate 权限时向导只读、无写入入口", () => {
    mocks.state.data = makeState({ strict_writes_enabled: false });
    view({ roleCode: "CUSTOM", permissions: { resources: { view: true, operate: false } } });
    expect(screen.getByTestId("activation-wizard")).toHaveTextContent("resources.operate 权限");
    expect(screen.getByRole("button", { name: "执行预检" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "添加期初行" })).not.toBeInTheDocument();
  });

  it("DARK 模式下向导保留但写入口不可用", () => {
    mocks.state.data = makeState({ mode: "DARK", strict_writes_enabled: false });
    view({ mode: "DARK" });
    expect(screen.getByTestId("activation-wizard")).toHaveTextContent("只读验收模式（DARK）");
    expect(screen.getByRole("button", { name: "执行预检" })).toBeDisabled();
  });
});
