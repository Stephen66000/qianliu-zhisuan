/**
 * 初始化向导交互测试（WP05 任务 5.3、5.4、5.5；PFU-03～PFU-06）。
 *
 * 采用「真钩子 + 假 HTTP」：`api/client` 被替换为可编程的 get/post，
 * 其余（React Query、写操作 retry:0、载荷构造）全部走真实实现，
 * 因此这里能同时验证「请求体不含企业/管理员身份」与「幂等键人工重试不换键」。
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, get } from "../../api/client";
import type * as ApiClient from "../../api/client";
import { ACTIVATION_QUERY_KEY } from "../../api/provider-finance-activation";
import type {
  ActivationCandidateMetadata, ActivationPreviewView, ActivationStateView, QuiescenceView,
} from "../../api/provider-finance-activation-types";
import { ProviderFinanceActivationWizard } from "./ProviderFinanceActivationWizard";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return { ...actual, get: http.get, post: http.post };
});

const CUTOVER = "2026-08-31T16:00:00.000Z";
const ENTERPRISE = "ent-9f3a-4c21-b7d0-111122223333";
const RESOURCE = "11111111-1111-4111-8111-111111111111";
const FUTURE = new Date(Date.now() + 20 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function drainReport(patch: Partial<QuiescenceView["drain"]> = {}): QuiescenceView["drain"] {
  return {
    in_progress_requests: 0, open_attempts: 0, unpaired_usage_lines: 0,
    pending_ledger_transactions: 0, exonerated_usage_lines: 0, drained: true, ...patch,
  };
}

function makeState(patch: Partial<ActivationStateView> = {}): ActivationStateView {
  const quiescence: QuiescenceView = {
    status: "ACTIVE", active: true, started_at: PAST, expires_at: FUTURE, released_at: null,
    release_reason: null, remaining_seconds: 1_200, insufficient_for_activation: false,
    drain: drainReport(),
  };
  return {
    mode: "ACTIVE", cutover_at: CUTOVER, strict_writes_enabled: false, scope_summary: null,
    quiescence, latest_candidate: null, activation_receipt: null, activated_at: null,
    activated_by_admin_user_id: null, ...patch,
  };
}

function makePreview(patch: Partial<ActivationPreviewView> = {}): ActivationPreviewView {
  return {
    candidate_id: "cand-1", candidate_hash: "hash-1", fact_watermark_hash: "wm-1",
    snapshot_at: PAST, preview_committed_at: PAST, expires_at: FUTURE, decision: "GO_CANDIDATE",
    gaps: [], scope_summary: { apiResources: 1, codingPlanResources: 1, requiredAccounts: 2, legacyRecords: 1, months: ["2026-08", "2026-09"] },
    usage_repairs: { eligibleRows: 3, eligibleByField: {}, newRowsAfterPreview: 0, nonTargetHashMismatches: 0 },
    projected: {
      accounts: [{
        resourceId: RESOURCE, currency: "CNY", openingBalance: "0.00000000",
        openingCorrections: "0.00000000", recharges: "100.00000000", usageDebits: "0.00000000",
        balanceReconciliations: "0.00000000", legacyCostAdjustments: "0.00000000",
        reversals: "0.00000000", balance: "100.00000000",
      }],
      monthsChecked: ["2026-08"], tokenConserved: true, codingPlanUsageAttributed: true, operatingBillsComplete: true,
    },
    ...patch,
  };
}

/** 预检结果对应的服务端候选元数据（容器会在预检后重新拉取状态，因此这里保持一致）。 */
function candidateFor(preview: ActivationPreviewView): ActivationCandidateMetadata {
  return {
    candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
    fact_watermark_hash: preview.fact_watermark_hash, decision: preview.decision, status: "PREVIEWED",
    created_at: PAST, expires_at: preview.expires_at, expired: false, created_by_admin_user_id: "admin-1",
    gap_summary: [], activated_at: null, activated_by_admin_user_id: null,
  };
}

function renderWizard(options: { state?: Partial<ActivationStateView>; canOperate?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProviderFinanceActivationWizard
        canOperate={options.canOperate ?? true} enterpriseId={ENTERPRISE} mode="ACTIVE"
        resourceLabel={(resourceId) => (resourceId === RESOURCE ? "Kimi · 主账号" : "未知资源")}
        resourceOptions={[{ id: RESOURCE, mode: "API", label: "Kimi · 主账号" }]}
        state={makeState(options.state)}
      />
    </QueryClientProvider>,
  );
}

async function runPreview(preview: ActivationPreviewView, state: Partial<ActivationStateView> = {}) {
  http.post.mockResolvedValueOnce(preview);
  renderWizard({ state: { latest_candidate: candidateFor(preview), ...state } });
  await userEvent.setup().click(screen.getByRole("button", { name: "执行预检" }));
  await waitFor(() => expect(screen.getByTestId("activation-preview-result")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockResolvedValue(makeState());
});

describe("预检与结构化缺口", () => {
  it("NO_GO：按类别分组展示缺口，激活入口不可用，并提示需补齐后重新预检", async () => {
    await runPreview(makePreview({
      decision: "NO_GO",
      gaps: [
        { code: "MISSING_OPENING_BALANCE", category: "OPENING_BALANCE", message: "缺少期初",
          resourceId: RESOURCE, accountCurrency: "CNY", legacyRecordId: null, ledgerLineId: null,
          month: null, detail: null },
        { code: "UNKNOWN_COST", category: "USAGE", message: "费用状态未明确", resourceId: null,
          accountCurrency: null, legacyRecordId: null, ledgerLineId: "aaaa-bbbb", month: "2026-08", detail: null },
      ],
    }));

    expect(screen.getByTestId("activation-gap-MISSING_OPENING_BALANCE")).toHaveTextContent("必要币种账户缺少原始期初余额");
    expect(screen.getByTestId("activation-gap-MISSING_OPENING_BALANCE")).toHaveTextContent("Kimi · 主账号 · CNY");
    expect(screen.getByTestId("activation-gap-UNKNOWN_COST")).toHaveTextContent("不能用旧记录关闭绕过");
    expect(screen.getByTestId("activation-hold-reason")).toHaveTextContent("NO_GO");
    expect(screen.getByRole("button", { name: "进入不可逆激活确认" })).toBeDisabled();
  });

  it("预检请求体只含业务草稿与 schema 版本，不含 enterprise_id / admin_id", async () => {
    await runPreview(makePreview());
    const [path, payload] = http.post.mock.calls[0]!;
    expect(path).toBe("/provider-finance/activation-preview");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("enterprise_id");
    expect(serialized).not.toContain("admin_id");
    expect(payload).toMatchObject({ schema_version: "1", api_opening_balances: [] });
  });
});

describe("不可逆激活确认", () => {
  it("GO_CANDIDATE：需逐字输入企业 ID 才能提交，且只发送 confirm_enterprise_id", async () => {
    const user = userEvent.setup();
    await runPreview(makePreview());
    const activate = screen.getByRole("button", { name: "进入不可逆激活确认" });
    expect(activate).toBeEnabled();
    await user.click(activate);

    expect(screen.getByTestId("activation-confirm")).toHaveTextContent("不可逆激活");
    expect(screen.getByTestId("activation-confirm")).toHaveTextContent(ENTERPRISE);
    expect(screen.getByTestId("activation-confirm")).toHaveTextContent("2026-08、2026-09");
    const submit = screen.getByRole("button", { name: "确认不可逆激活" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("再次输入目标企业 ID"), "ent-wrong");
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText("再次输入目标企业 ID"));
    await user.type(screen.getByLabelText("再次输入目标企业 ID"), ENTERPRISE);
    expect(submit).toBeEnabled();

    http.post.mockResolvedValueOnce({ replayed: false, candidate_id: "cand-1", receipt: {} });
    await user.click(submit);
    await waitFor(() => expect(http.post).toHaveBeenCalledTimes(2));
    const [path, payload] = http.post.mock.calls[1]!;
    expect(path).toBe("/provider-finance/activate");
    expect(payload).toEqual({
      candidate_id: "cand-1", candidate_hash: "hash-1",
      idempotency_key: expect.any(String), confirm_enterprise_id: ENTERPRISE,
    });
    expect(Object.keys(payload)).not.toContain("enterprise_id");
    expect(Object.keys(payload)).not.toContain("admin_id");
  });

  it("ACTIVATION_RETRY_REQUIRED：不自动重试，弹窗保留，人工重试复用同一幂等键", async () => {
    const user = userEvent.setup();
    await runPreview(makePreview());
    await user.click(screen.getByRole("button", { name: "进入不可逆激活确认" }));
    await user.type(screen.getByLabelText("再次输入目标企业 ID"), ENTERPRISE);

    http.post.mockRejectedValueOnce(new ApiError(409, {
      error: "activation_retry_required", message: "事务已回滚，可人工重试",
    }, "失败"));
    await user.click(screen.getByRole("button", { name: "确认不可逆激活" }));
    await waitFor(() => expect(screen.getByTestId("activation-error")).toBeInTheDocument());
    expect(screen.getByTestId("activation-error")).toHaveTextContent("人工重试");
    // 失败关闭：没有任何自动重试。
    expect(http.post).toHaveBeenCalledTimes(2);
    // 候选未被清除：弹窗仍在，可人工重试。
    expect(screen.getByTestId("activation-confirm")).toBeInTheDocument();

    http.post.mockRejectedValueOnce(new ApiError(409, {
      error: "activation_retry_required", message: "事务已回滚，可人工重试",
    }, "失败"));
    await user.click(screen.getByRole("button", { name: "确认不可逆激活" }));
    await waitFor(() => expect(http.post).toHaveBeenCalledTimes(3));
    const firstKey = http.post.mock.calls[1]![1].idempotency_key;
    const secondKey = http.post.mock.calls[2]![1].idempotency_key;
    expect(secondKey).toBe(firstKey);
  });

  it("CANDIDATE_STALE：立即清除可激活状态，必须重新预检", async () => {
    const user = userEvent.setup();
    await runPreview(makePreview());
    await user.click(screen.getByRole("button", { name: "进入不可逆激活确认" }));
    await user.type(screen.getByLabelText("再次输入目标企业 ID"), ENTERPRISE);

    http.post.mockRejectedValueOnce(new ApiError(409, {
      error: "activation_candidate_stale", message: "事实水位已变化",
    }, "失败"));
    await user.click(screen.getByRole("button", { name: "确认不可逆激活" }));
    await waitFor(() => expect(screen.queryByTestId("activation-preview-result")).not.toBeInTheDocument());
    expect(screen.queryByTestId("activation-confirm")).not.toBeInTheDocument();
  });

  it("候选过期后不可激活（PFU-03 即时失效）", async () => {
    await runPreview(makePreview({ expires_at: PAST }));
    expect(screen.getByRole("button", { name: "进入不可逆激活确认" })).toBeDisabled();
  });

  it("事实水位漂移后不可激活（PFU-03 即时失效）", async () => {
    const preview = makePreview();
    await runPreview(preview, {
      latest_candidate: { ...candidateFor(preview), fact_watermark_hash: "wm-drifted" },
    });
    expect(screen.getByRole("button", { name: "进入不可逆激活确认" })).toBeDisabled();
  });
});

describe("失败关闭", () => {
  it("静默门禁未满足时不可预检", async () => {
    http.post.mockResolvedValue(makePreview());
    renderWizard({ state: { quiescence: {
      status: "ACTIVE", active: true, started_at: PAST, expires_at: FUTURE, released_at: null,
      release_reason: null, remaining_seconds: 1_200, insufficient_for_activation: false,
      drain: drainReport({ open_attempts: 2 }),
    } } });
    expect(screen.getByRole("button", { name: "执行预检" })).toBeDisabled();
    expect(screen.getByTestId("quiescence-blockers")).toHaveTextContent("未结束上游尝试");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("未配对用量行只作提示，不阻断预检（服务端在投影后按候选修复集重算）", async () => {
    http.post.mockResolvedValue(makePreview());
    renderWizard({ state: { quiescence: {
      status: "ACTIVE", active: true, started_at: PAST, expires_at: FUTURE, released_at: null,
      release_reason: null, remaining_seconds: 1_200, insufficient_for_activation: false,
      drain: drainReport({ unpaired_usage_lines: 5, drained: false }),
    } } });
    expect(screen.getByRole("button", { name: "执行预检" })).toBeEnabled();
    expect(screen.getByTestId("quiescence-drain-notes")).toHaveTextContent("5 条未配对用量行");
  });

  it("DARK 模式与只读权限下不提供写入口，草稿只读", async () => {
    http.post.mockResolvedValue(makePreview());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProviderFinanceActivationWizard
          canOperate={false} enterpriseId={ENTERPRISE} mode="DARK" resourceLabel={(id) => id}
          resourceOptions={[]} state={makeState()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "执行预检" })).toBeDisabled();
    const wizard = screen.getByTestId("activation-wizard");
    expect(wizard).toHaveTextContent("resources.operate 权限");
    expect(wizard).toHaveTextContent("只读验收模式（DARK）");
    // 草稿只读：无法新增任何草稿行，也不可能绕过服务端权威身份。
    expect(screen.queryByRole("button", { name: "添加期初行" })).not.toBeInTheDocument();
    expect(http.post).not.toHaveBeenCalled();
  });
});

// ===== F-P1-1 回归：容器真实取数链路（不预对齐 latest_candidate） =====

/**
 * 复刻 `FinanceInitializationPanel` 的真实取数链路：状态来自查询读模型，
 * 并把 `dataUpdatedAt` 传给向导。预检成功后 `useActivationPreview` 会失效该查询，
 * 刷新返回前读模型仍是预检前的旧值——这里用可控的挂起 Promise 精确复现这个窗口。
 */
function ContainerHarness() {
  const query = useQuery({
    queryKey: ACTIVATION_QUERY_KEY,
    queryFn: () => get<ActivationStateView>("/provider-finance/activation-state"),
    initialData: makeState({ latest_candidate: null }),
    // 让初始读模型的时间戳明确早于本次预检，避免依赖真实毫秒差。
    initialDataUpdatedAt: Date.now() - 60_000,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return (
    <ProviderFinanceActivationWizard
      canOperate enterpriseId={ENTERPRISE} mode="ACTIVE"
      resourceLabel={(resourceId) => (resourceId === RESOURCE ? "Kimi · 主账号" : "未知资源")}
      resourceOptions={[{ id: RESOURCE, mode: "API", label: "Kimi · 主账号" }]}
      state={query.data}
      stateUpdatedAt={query.dataUpdatedAt}
    />
  );
}

describe("容器真实取数链路（F-P1-1 回归）", () => {
  it("预检 GO 后状态读模型异步刷新，不得清空可激活状态（激活入口可达）", async () => {
    const preview = makePreview();
    const fresh = makeState({ latest_candidate: candidateFor(preview) });
    let resolveRefetch: ((value: ActivationStateView) => void) | undefined;
    const pending = new Promise<ActivationStateView>((resolve) => { resolveRefetch = resolve; });
    http.get.mockImplementation(() => pending);
    http.post.mockResolvedValueOnce(preview);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(<QueryClientProvider client={client}><ContainerHarness /></QueryClientProvider>);

    await userEvent.setup().click(screen.getByRole("button", { name: "执行预检" }));
    await waitFor(() => expect(screen.getByTestId("activation-preview-result")).toBeInTheDocument());

    // 刷新返回前：读模型尚未反映本次预检 → 判「未知」，不得报失效、不得禁用激活入口。
    expect(screen.queryByTestId("activation-hold-reason")).toBeNull();
    expect(screen.getByRole("button", { name: "进入不可逆激活确认" })).toBeEnabled();

    // 刷新返回权威读模型（含本次候选）后仍然可激活。
    resolveRefetch!(fresh);
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "进入不可逆激活确认" })).toBeEnabled());
    expect(screen.queryByTestId("activation-hold-reason")).toBeNull();
  });

  it("刷新后的权威读模型确认候选已被取代时，仍然失败关闭（不放宽真实漂移）", async () => {
    const preview = makePreview();
    const superseded = makeState({
      latest_candidate: { ...candidateFor(preview), candidate_id: "cand-other" },
    });
    http.get.mockResolvedValue(superseded);
    http.post.mockResolvedValueOnce(preview);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(<QueryClientProvider client={client}><ContainerHarness /></QueryClientProvider>);

    await userEvent.setup().click(screen.getByRole("button", { name: "执行预检" }));
    await waitFor(() => expect(screen.getByTestId("activation-preview-result")).toBeInTheDocument());
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("activation-hold-reason")).toHaveTextContent("重新预检"));
    expect(screen.getByRole("button", { name: "进入不可逆激活确认" })).toBeDisabled();
  });
});
