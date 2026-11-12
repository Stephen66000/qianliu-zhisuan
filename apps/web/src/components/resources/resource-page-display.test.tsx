import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderOfficialBalanceState, ProviderResourceItem } from "../../api/types";
import { ResourceFinanceColumn, ResourceFinanceDisplay, ResourceQuotaColumn } from "./resource-page-display";
import { formatResourceNameWithDate } from "./resource-form-contract";

const postMock = vi.fn();
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, post: (...args: unknown[]) => postMock(...args) };
});

it.each(["kimi", "zhipu"])("%s 扣减缺失仍保留周期真实 Token", (providerCode) => {
  const resource: ProviderResourceItem = {
    id: "plan", provider_id: providerCode, name: "Plan", mode: "CODING_PLAN",
    credential_type: "API_KEY", credential_fingerprint: "safe-fingerprint", credential_version: 1,
    status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
    credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
    credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
    version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
    operating_snapshot: null, finance: {
    resourceId: "plan", providerCode, mode: "CODING_PLAN", accounts: [], monthlyPlanCashCny: "199",
    currentPeriod: { id: "period", productName: "Plan", periodStart: "2026-08-18T16:00:00Z",
      periodEndExclusive: "2026-09-18T16:00:00Z", fixedFeeAmount: "199", fixedFeeCurrency: "CNY",
      fixedCashPaidCny: "199", totalQuota: "300000000", quotaUnit: "TOKEN",
      trueTokens: "9000000", deductedQuota: null, deductedQuotaComplete: false, requestCount: "100" },
  } };
  render(<ResourceFinanceDisplay resource={resource} />);
  expect(screen.getByText("周期真实 Token 900 万 Token")).toBeInTheDocument();
  expect(screen.queryByText(/周期已扣减|事实不完整/)).not.toBeInTheDocument();
  expect(screen.getByText("2026-08-19 ～ 2026-09-19")).toBeInTheDocument();
});

function officialBalance(overrides: Partial<ProviderOfficialBalanceState>): ProviderOfficialBalanceState {
  return {
    provider_resource_id: "api-1", supported: true, status: "OK",
    expired: false, last_attempt_failed: false,
    total_balance: null, currency: null, composition: null, available: null,
    last_success_at: null, last_attempt: null, next_refresh_at: null,
    ...overrides,
  };
}

describe("ResourceFinanceColumn & ResourceQuotaColumn 列拆分测试", () => {
  it("套餐资源拆分为资金列（订阅金额与实付）与额度列（订阅额度、真实 Token、服务周期）", () => {
    const resource: ProviderResourceItem = {
      id: "plan-1", provider_id: "kimi", name: "Kimi 套餐", mode: "CODING_PLAN",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
      operating_snapshot: null, finance: {
        resourceId: "plan-1", providerCode: "kimi", mode: "CODING_PLAN", accounts: [], monthlyPlanCashCny: "0",
        currentPeriod: {
          id: "p-1", productName: "Kimi", periodStart: "2026-08-18T16:00:00Z",
          periodEndExclusive: "2026-09-18T16:00:00Z", fixedFeeAmount: "199", fixedFeeCurrency: "CNY",
          fixedCashPaidCny: "0", totalQuota: "3000000000", quotaUnit: "TOKEN",
          trueTokens: "223157358", deductedQuota: null, deductedQuotaComplete: false, requestCount: "100",
        },
      },
    };

    const { unmount: unmountFinance } = render(<ResourceFinanceColumn resource={resource} />);
    expect(screen.getByText("当前订阅金额 CNY 199.00")).toBeInTheDocument();
    expect(screen.getByText("本月订阅实付 ¥0.00")).toBeInTheDocument();
    expect(screen.queryByText(/分配额度/)).not.toBeInTheDocument();
    expect(screen.queryByText(/订阅额度/)).not.toBeInTheDocument();
    unmountFinance();

    const { unmount: unmountQuota } = render(<ResourceQuotaColumn resource={resource} />);
    expect(screen.getByText("分配额度 30 亿 Token")).toBeInTheDocument();
    expect(screen.queryByText(/订阅额度/)).not.toBeInTheDocument();
    expect(screen.getByText("周期真实 Token 2.23 亿 Token")).toBeInTheDocument();
    expect(screen.getByText("2026-08-19 ～ 2026-09-19")).toBeInTheDocument();
    expect(screen.queryByText(/当前订阅金额/)).not.toBeInTheDocument();
    unmountQuota();

    // 优先显示主体分配额度（跟随接受主体调整实时变化）
    render(<ResourceQuotaColumn resource={{ ...resource, allocated_quota: "3530100000" }} />);
    expect(screen.getByText("分配额度 35.3 亿 Token")).toBeInTheDocument();
  });

  // 断言迁移（WP4-S2 合同 2 / D5＋AFR-07）：API 资源内部资金三行（本月充值/余额/本月
  // API 成本）退役，资金列改消费 C2 official_balance；"资金账本未启用"提示不再出现。
  it("API 资源资金列展示官方余额与同步状态，内部资金三行退出，额度列展示破折号", () => {
    const resource: ProviderResourceItem = {
      id: "api-1", provider_id: "deepseek", name: "DeepSeek API", mode: "API",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
      operating_snapshot: null,
      official_balance: officialBalance({ status: "OK", total_balance: "110.00000000", currency: "CNY" }),
      finance: {
        resourceId: "api-1", providerCode: "deepseek", mode: "API", accounts: [{
          currency: "CNY", balanceState: "NORMAL", balance: "435.50",
          monthOpeningState: "NORMAL", monthOpeningBalance: "10.00",
          monthlyRecharge: "600.00", monthlyApiCost: "171.33",
        }], monthlyPlanCashCny: "0", currentPeriod: null,
      },
    };

    const { unmount: unmountFinance } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ResourceFinanceColumn resource={resource} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("官方余额 ¥110.00")).toBeInTheDocument();
    expect(screen.queryByText(/本月充值/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本月 API 成本/)).not.toBeInTheDocument();
    expect(screen.queryByText("资金账本未启用")).not.toBeInTheDocument();
    unmountFinance();

    render(<ResourceQuotaColumn resource={resource} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  // G24/AFR-14（WP5 S3a-2）：同一渲染输出中的组合断言——API 资源不再显示内部资金
  // 栏目（期初/充值/内部余额字样），CP（Coding Plan）资源保留套餐费用与额度栏目；
  // 即"内部资金栏目退出"是 API 模式专属处理，不存在一刀切隐藏所有"余额/额度"。
  it("API 资源无内部资金栏目而 CP 资源保留套餐费用/额度栏目（同渲染输出组合断言）", () => {
    const apiResource: ProviderResourceItem = {
      id: "api-combo", provider_id: "deepseek", name: "DeepSeek API 组合", mode: "API",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z",
      operating_snapshot: null,
      official_balance: officialBalance({ total_balance: "110.00000000", currency: "CNY" }),
    };
    const planResource: ProviderResourceItem = {
      id: "plan-combo", provider_id: "kimi", name: "Kimi 套餐组合", mode: "CODING_PLAN",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z",
      operating_snapshot: null,
      finance: {
        resourceId: "plan-combo", providerCode: "kimi", mode: "CODING_PLAN", accounts: [],
        monthlyPlanCashCny: "199",
        currentPeriod: {
          id: "period-combo", productName: "Kimi", periodStart: "2026-10-18T16:00:00Z",
          periodEndExclusive: "2026-11-18T16:00:00Z", fixedFeeAmount: "199",
          fixedFeeCurrency: "CNY", fixedCashPaidCny: "199", totalQuota: "3000000000",
          quotaUnit: "TOKEN", trueTokens: "223157358", deductedQuota: null,
          deductedQuotaComplete: false, requestCount: "100",
        },
      },
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div>
          <ResourceFinanceColumn resource={apiResource} />
          <ResourceQuotaColumn resource={apiResource} />
          <ResourceFinanceColumn resource={planResource} />
          <ResourceQuotaColumn resource={planResource} />
        </div>
      </QueryClientProvider>,
    );
    // API 资源：官方余额列照常展示（"余额"未被一刀切隐藏），内部资金栏目整体退出。
    expect(screen.getByText("官方余额 ¥110.00")).toBeInTheDocument();
    expect(screen.queryByText(/本月充值/)).not.toBeInTheDocument();
    expect(screen.queryByText(/期初余额/)).not.toBeInTheDocument();
    expect(screen.queryByText(/内部余额/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本月 API 成本/)).not.toBeInTheDocument();
    expect(screen.queryByText("资金账本未启用")).not.toBeInTheDocument();
    // CP 资源：套餐费用与额度栏目保留（W5/W6 域不受 API 资金退役影响）。
    expect(screen.getByText("当前订阅金额 CNY 199.00")).toBeInTheDocument();
    expect(screen.getByText("本月订阅实付 ¥199.00")).toBeInTheDocument();
    expect(screen.getByText("分配额度 30 亿 Token")).toBeInTheDocument();
    expect(screen.getByText("周期真实 Token 2.23 亿 Token")).toBeInTheDocument();
    expect(screen.getByText("2026-10-19 ～ 2026-11-19")).toBeInTheDocument();
  });
});

describe("官方余额列状态渲染（WP3 C2 / OAB-01..04）", () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ state: "ACCEPTED", result: { outcome: "SUCCEEDED" } });
  });

  function renderColumn(balance: ProviderOfficialBalanceState | null) {
    const resource: ProviderResourceItem = {
      id: "api-1", provider_id: "deepseek", name: "DeepSeek API", mode: "API",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
      operating_snapshot: null, official_balance: balance,
    };
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ResourceFinanceColumn resource={resource} />
      </QueryClientProvider>,
    );
  }

  it("OK：展示余额＋币种，无状态标记，刷新按钮可用", () => {
    renderColumn(officialBalance({
      total_balance: "110.00000000", currency: "CNY",
      last_success_at: "2026-11-03T04:00:00.000Z",
    }));
    expect(screen.getByText("官方余额 ¥110.00")).toBeInTheDocument();
    expect(screen.queryByText(/同步失败|数据过期|未同步|同步中/)).not.toBeInTheDocument();
    expect(screen.getByText(/最近成功/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "刷新余额" });
    expect(button).toBeEnabled();
  });

  it("FAILED 保鲜值：保留上次成功金额与时间，标注同步失败，不显示 0（AT-OAB-07/08）", () => {
    renderColumn(officialBalance({
      status: "FAILED", last_attempt_failed: true,
      total_balance: "50.00000000", currency: "CNY",
      last_success_at: "2026-11-03T03:30:00.000Z",
      last_attempt: { at: "2026-11-03T04:00:00.000Z", outcome: "FAILED", reason: "上游鉴权失败" },
    }));
    expect(screen.getByText("官方余额 ¥50.00")).toBeInTheDocument();
    expect(screen.getByText("同步失败")).toBeInTheDocument();
    expect(screen.queryByText(/¥0\.00/)).not.toBeInTheDocument();
  });

  it("EXPIRED 主状态叠加 expired=true 只标一次数据过期", () => {
    renderColumn(officialBalance({
      status: "EXPIRED", expired: true,
      total_balance: "50.00000000", currency: "CNY",
      last_success_at: "2026-11-03T01:00:00.000Z",
    }));
    expect(screen.getByText("数据过期")).toBeInTheDocument();
    expect(screen.getByText("官方余额 ¥50.00")).toBeInTheDocument();
  });

  it("FAILED＋expired=true 布尔叠加同时表达数据过期与同步失败（AT-OAB-07）", () => {
    renderColumn(officialBalance({
      status: "FAILED", last_attempt_failed: true, expired: true,
      total_balance: "50.00000000", currency: "CNY",
    }));
    expect(screen.getByText("同步失败 · 数据过期")).toBeInTheDocument();
  });

  it("NEVER_SYNCED：余额 null 显示暂无官方数据，绝不显示为 0（AT-OAB-08）", () => {
    renderColumn(officialBalance({ status: "NEVER_SYNCED" }));
    expect(screen.getByText("暂无官方数据")).toBeInTheDocument();
    expect(screen.queryByText(/¥0\.00/)).not.toBeInTheDocument();
    expect(screen.getByText("未同步")).toBeInTheDocument();
  });

  it("UNSUPPORTED：整区显示暂不支持官方余额同步，无余额与刷新入口（OAB-02）", () => {
    renderColumn(officialBalance({ status: "UNSUPPORTED", supported: false }));
    expect(screen.getByText("暂不支持官方余额同步")).toBeInTheDocument();
    expect(screen.queryByText(/^官方余额/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新余额" })).not.toBeInTheDocument();
  });

  it("SYNCING 主状态叠加 last_attempt_failed 同时表达同步中与上次失败", () => {
    renderColumn(officialBalance({ status: "SYNCING", last_attempt_failed: true, total_balance: "80", currency: "CNY" }));
    expect(screen.getByText("同步中 · 同步失败")).toBeInTheDocument();
    expect(screen.getByText("官方余额 ¥80.00")).toBeInTheDocument();
  });

  it("冷却期消费后端 next_refresh_at 禁用按钮并显示秒数，不前端硬编码 P3", () => {
    const future = new Date(Date.now() + 20_000).toISOString();
    renderColumn(officialBalance({ total_balance: "110.00000000", currency: "CNY", next_refresh_at: future }));
    const button = screen.getByRole("button", { name: "刷新余额" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/冷却 \d+s/)).toBeInTheDocument();
  });

  it("next_refresh_at 为空立即可刷，点击调用刷新端点", async () => {
    renderColumn(officialBalance({ total_balance: "110.00000000", currency: "CNY" }));
    const button = screen.getByRole("button", { name: "刷新余额" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/provider-resources/api-1/official-balance/refresh"),
    );
  });

  it("official_balance 缺省（旧后端）降级为暂无官方数据且无刷新按钮", () => {
    renderColumn(null);
    expect(screen.getByText("暂无官方数据")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新余额" })).not.toBeInTheDocument();
    expect(screen.queryByText("资金账本未启用")).not.toBeInTheDocument();
  });

  // D-2（走查裁定 2026-11-04 / OAB-01）：组成升到浏览器层——composition 存在时
  // 金额下方逐项展示"赠送/充值"，两侧各自格式化、绝不相加（页面显示官方账户余额
  // 110 元，可查看两项组成，不把三个金额再次相加）。
  it("OK＋composition：金额下方渲染赠送/充值两侧行，各自格式化（OAB-01）", () => {
    renderColumn(officialBalance({
      total_balance: "110.00000000", currency: "CNY",
      composition: { granted: "10.00000000", topped: "100.00000000" },
    }));
    expect(screen.getByText("官方余额 ¥110.00")).toBeInTheDocument();
    expect(screen.getByText("赠送 ¥10.00 · 充值 ¥100.00")).toBeInTheDocument();
    // 绝不相加：110+10+100 的 220 不出现；¥110.00 只出现总额行一次（无二次合计）。
    expect(screen.queryByText(/220/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/¥110\.00/)).toHaveLength(1);
  });

  it("组成任一侧为 null 只显示存在的一侧，null 侧不渲染", () => {
    renderColumn(officialBalance({
      total_balance: "100.00000000", currency: "CNY",
      composition: { granted: null, topped: "100.00000000" },
    }));
    expect(screen.getByText("充值 ¥100.00")).toBeInTheDocument();
    expect(screen.queryByText(/赠送/)).not.toBeInTheDocument();
  });

  it("composition 整体为 null 不渲染组成行", () => {
    renderColumn(officialBalance({
      total_balance: "110.00000000", currency: "CNY",
      composition: null,
    }));
    expect(screen.getByText("官方余额 ¥110.00")).toBeInTheDocument();
    expect(screen.queryByText(/赠送|充值/)).not.toBeInTheDocument();
  });

  it("composition 两侧均 null 不渲染空组成行", () => {
    renderColumn(officialBalance({
      total_balance: "110.00000000", currency: "CNY",
      composition: { granted: null, topped: null },
    }));
    expect(screen.getByText("官方余额 ¥110.00")).toBeInTheDocument();
    expect(screen.queryByText(/赠送|充值/)).not.toBeInTheDocument();
  });
});

describe("formatResourceNameWithDate", () => {
  it("无日期后缀时自动追加 YYMMDD 格式数字", () => {
    const fixedDate = new Date(2026, 8, 13); // 2026-09-13
    expect(formatResourceNameWithDate("Kimi", fixedDate)).toBe("Kimi-260913");
    expect(formatResourceNameWithDate("智谱主账号", fixedDate)).toBe("智谱主账号-260913");
  });

  it("已含有 6 位或 8 位日期后缀时，不重复拼接", () => {
    const fixedDate = new Date(2026, 8, 13);
    expect(formatResourceNameWithDate("Kimi-260913", fixedDate)).toBe("Kimi-260913");
    expect(formatResourceNameWithDate("Kimi-20260913", fixedDate)).toBe("Kimi-20260913");
    expect(formatResourceNameWithDate("Kimi-260913-01", fixedDate)).toBe("Kimi-260913-01");
  });

  it("空文本原样返回空字符串", () => {
    expect(formatResourceNameWithDate("")).toBe("");
    expect(formatResourceNameWithDate("   ")).toBe("");
  });
});

