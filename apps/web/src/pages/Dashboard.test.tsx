/**
 * 首页看板单测 —— 2.0 六项主概览 / 1.0 稳定迁位 / 三态 / 空企业。
 *
 * 只 mock useDashboard hook；组件渲染断言。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardSummary } from "../api/types";
import type { UsageOverview } from "../api/v2-types";
import { DashboardPage } from "./Dashboard";

const useDashboardMock = vi.fn();
const useUsageOverviewMock = vi.fn();
const usePrincipalOptionsMock = vi.fn();
const usePrincipalOptionMock = vi.fn();
const resolvePrincipalExactMatchMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useDashboard: () => useDashboardMock(),
}));
vi.mock("../api/v2-hooks", () => ({
  useUsageOverview: (query: string) => useUsageOverviewMock(query),
  usePrincipalOptions: (type: string, search: string, offset: number, limit: number) => usePrincipalOptionsMock(type, search, offset, limit),
  usePrincipalOption: (id: string | null) => usePrincipalOptionMock(id),
  resolvePrincipalExactMatch: (type: string, name: string) => resolvePrincipalExactMatchMock(type, name),
}));

const overviewEmployeeId = "10000000-0000-4000-8000-000000000001";
function employeeOverview(): UsageOverview {
  return {
    subjectType: "EMPLOYEE", subjectId: null, period: "MONTH", anchor: "2026-08-12T04:00:00.000Z", timezone: "Asia/Shanghai",
    range: { from: "2026-07-31T16:00:00.000Z", to: "2026-08-31T16:00:00.000Z" },
    metrics: { activeSubjects: 1, requestCount: "3", inputTokens: "8000", outputTokens: "2000", cacheTokens: "1000", reasoningTokens: "300", realTokens: "10000", apiCost: "2", deductedQuota: "10000", usageQuality: "PROVIDER_REPORTED", providerReportedCount: 3, estimatedCount: 0, accountAggregatedCount: 0, mixedCount: 0, unknownCount: 0 },
    trend: [{ bucketStart: "2026-07-31T16:00:00.000Z", bucketEnd: "2026-08-01T16:00:00.000Z", label: "08-01", requestCount: "3", inputTokens: "8000", outputTokens: "2000", cacheTokens: "1000", reasoningTokens: "300", realTokens: "10000", apiCost: "2", deductedQuota: "10000" }],
    ranking: [{ subjectId: overviewEmployeeId, subjectName: "李雷", departmentLabel: "研发", requestCount: "3", inputTokens: "8000", outputTokens: "2000", cacheTokens: "1000", reasoningTokens: "300", realTokens: "10000", apiCost: "2", deductedQuota: "10000", share: "1" }],
    factWatermark: "2026-08-10T00:00:00.000Z", generatedAt: "2026-08-12T04:00:00.000Z",
    detailQuery: { principalId: null, projectId: null, subjectType: "EMPLOYEE", settledOnly: true, from: "2026-07-31T16:00:00.000Z", toExclusive: "2026-08-31T16:00:00.000Z" },
    stale: false, source: "LIVE_LEDGER",
  };
}

function emptySummary(): DashboardSummary {
  return {
    resourceAccountCount: 0,
    activeEmployeeCount: 0,
    currentInUseCount: 0,
    monthlyPackagePayment: null,
    monthlyPackagePayments: [],
    monthlyApiCost: "0",
    monthlyApiCosts: [],
    monthlyApiSpendReason: null,
    monthlyTotalSpend: null,
    monthlyTotalSpends: [],
    monthlyRechargeAmount: null,
    monthlyRechargeAmounts: [],
    earliestExhaustion: null,
    monthlyDispatchSaving: "0",
    dispatchSavingBreakdown: {
      realizedAmount: "0", realizedSwitchCount: 0, actualSwitchCount: 0, realizedReason: "本月无可计算的实际切换",
      potentialPeakSavingAmount: null, potentialReason: "缺少同一任务的峰值/低谷等价执行关联，暂不估算金额",
      avoidedPeakDeduction: "0", avoidedDeductionCount: 0,
      avoidedReason: "本月无具备双端倍率快照的已执行切换", rejectedRequestCount: 0,
    },
    resourceStatus: { total: 0, status: "EMPTY", statusCounts: {}, abnormalResources: [] },
    overageList: [],
    monthlyTokenUsage: {
      totalInputTokens: "0", totalOutputTokens: "0", totalCacheTokens: "0",
      totalReasoningTokens: "0", totalTokens: "0", usageQuality: "NO_DATA",
      settledTransactionCount: 0, providerReportedTransactionCount: 0,
      estimatedTransactionCount: 0, accountAggregatedTransactionCount: 0,
      mixedTransactionCount: 0, unknownTransactionCount: 0,
      attributionBasis: "LEDGER_TRANSACTION_SETTLED_AT",
      rangeStart: "2026-07-31T16:00:00.000Z", rangeEndExclusive: "2026-08-31T16:00:00.000Z",
      employeeRanking: [],
    },
  };
}

function seededSummary(): DashboardSummary {
  return {
    ...emptySummary(),
    resourceAccountCount: 2,
    activeEmployeeCount: 5,
    currentInUseCount: 3,
    monthlyPackagePayment: "299",
    monthlyPackagePayments: [{ currency: "CNY", amount: "299" }],
    monthlyApiCost: "12.50000000",
    monthlyApiCosts: [{ currency: "CNY", amount: "12.50000000" }],
    monthlyTotalSpend: "311.50000000",
    monthlyTotalSpends: [{ currency: "CNY", amount: "311.50000000" }],
    monthlyRechargeAmount: "100",
    monthlyRechargeAmounts: [{ currency: "CNY", amount: "100" }],
    monthlyDispatchSaving: "1.50000000",
    dispatchSavingBreakdown: {
      realizedAmount: "1.50000000", realizedSwitchCount: 1, actualSwitchCount: 1, realizedReason: null,
      potentialPeakSavingAmount: null, potentialReason: "缺少同一任务的峰值/低谷等价执行关联，暂不估算金额",
      avoidedPeakDeduction: "1200", avoidedDeductionCount: 1,
      avoidedReason: null, rejectedRequestCount: 2,
    },
    earliestExhaustion: {
      resourceId: "r1",
      resourceName: "智谱 GLM 套餐",
      providerCode: "zhipu",
      forecastExhaustAt: "2026-07-30T12:00:00.000Z",
      nextRecoverAt: "2026-08-01T00:00:00.000Z",
      confidence: "MEDIUM",
      notCalculableReason: null,
    },
    resourceStatus: { total: 2, status: "HEALTHY", statusCounts: { ACTIVE: 2 }, abnormalResources: [] },
    overageList: [
      {
        principalId: "p1",
        principalName: "张三",
        principalType: "EMPLOYEE",
        provider: "zhipu",
        modelAlias: "glm-4.6",
        quotaValue: "100000",
        usedValue: "105000",
        overageValue: "5000",
        overageRatio: "0.0500",
      },
    ],
    monthlyTokenUsage: {
      totalInputTokens: "9007199254740993000",
      totalOutputTokens: "2000",
      totalCacheTokens: "3000",
      totalReasoningTokens: "400",
      totalTokens: "9007199254740995000",
      usageQuality: "PROVIDER_REPORTED", settledTransactionCount: 1,
      providerReportedTransactionCount: 1, estimatedTransactionCount: 0,
      accountAggregatedTransactionCount: 0, mixedTransactionCount: 0,
      unknownTransactionCount: 0,
      attributionBasis: "LEDGER_TRANSACTION_SETTLED_AT",
      rangeStart: "2026-07-31T16:00:00.000Z", rangeEndExclusive: "2026-08-31T16:00:00.000Z",
      employeeRanking: [{
        principalId: "p1", principalName: "张三", inputTokens: "6000",
        outputTokens: "4000", cacheTokens: "3000", reasoningTokens: "400",
        totalTokens: "10000", share: "0.25",
      }],
    },
  };
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("W18 首页看板", () => {
  beforeEach(() => {
    useDashboardMock.mockReset();
    useUsageOverviewMock.mockReset();
    usePrincipalOptionsMock.mockReset();
    usePrincipalOptionMock.mockReset();
    useUsageOverviewMock.mockReturnValue({ isLoading: false, error: null, data: employeeOverview(), refetch: vi.fn() });
    usePrincipalOptionsMock.mockReturnValue({ isLoading: false, error: null, data: { principals: [{ id: overviewEmployeeId, type: "EMPLOYEE", name: "李雷" }], total: 1, limit: 20, offset: 0 } });
    usePrincipalOptionMock.mockReturnValue({ data: undefined });
  });

  it("加载中渲染骨架屏", () => {
    useDashboardMock.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch: vi.fn(),
    });
    const { container } = renderDashboard();
    expect(container.querySelectorAll(".ql-skeleton").length).toBeGreaterThan(0);
  });

  it("错误态展示原因与重试", () => {
    const refetch = vi.fn();
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: new Error("无法连接到服务，请检查网络后重试"),
      data: undefined,
      refetch,
    });
    renderDashboard();
    expect(screen.getByRole("alert")).toHaveTextContent("无法连接到服务");
    screen.getByRole("button", { name: /重试/ }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("空企业：计数为 0、费用 0.00、无资源空状态（PRD §10.4）", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: emptySummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByText("厂商接入账号")).toBeInTheDocument();
    expect(screen.getByText("尚未登记厂商资源")).toBeInTheDocument();
    expect(screen.getByText("暂无员工消耗")).toBeInTheDocument();
    expect(screen.getByText(/无法产生模型和路由候选/)).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-earliest-exhaustion")).toHaveTextContent("暂无预测快照");
    expect(screen.getByTestId("dashboard-resource-status")).toHaveTextContent("资源状态：无资源");
    expect(screen.queryByText("需要处理")).not.toBeInTheDocument();
    // 调度节省为 "0" → 展示 0.00，不伪造（API 费用同为 0.00，允许出现多处）
    expect(screen.getByText("本月调度节省")).toBeInTheDocument();
    expect(screen.getAllByText("0.00").length).toBeGreaterThan(0);
    expect(screen.getByText("本月无可计算的实际切换")).toBeInTheDocument();
    expect(screen.queryByText(/潜在峰值：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/避免高峰扣减：/)).not.toBeInTheDocument();
  });

  it("数据源 gap：已知项保留，缺失项展示同源具体原因", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: emptySummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getAllByText("待补套餐费用")).toHaveLength(2);
    expect(screen.getByText("本月充值待补")).toBeInTheDocument();
    expect(screen.queryByText("数据源待接入")).not.toBeInTheDocument();
  });

  it("有数据：八项本月概览合并展示，调度节省三层口径可见", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: seededSummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    const monthSummary = screen.getByRole("heading", { name: "本月概览" }).closest("section")!;
    const resourceSummary = screen.getByRole("heading", { name: "资源摘要" }).closest("section")!;
    const employeeUsage = screen.getByRole("heading", { name: "员工消耗 Token" }).closest("section")!;
    for (const label of ["真实 Token 消耗", "本月总支出", "套餐支出", "API 花费", "活跃人数", "厂商接入账号", "本月充值", "本月调度节省"]) {
      expect(within(monthSummary).getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "1.0 经营补充" })).not.toBeInTheDocument();
    expect(monthSummary.compareDocumentPosition(resourceSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(resourceSummary.compareDocumentPosition(employeeUsage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByText("¥311.50")).toBeInTheDocument();
    expect(screen.getByText("当前正在使用 3 人")).toBeInTheDocument();
    expect(screen.getAllByText("¥12.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.50").length).toBeGreaterThan(0);
    expect(screen.getByText("潜在峰值：缺少同一任务的峰值/低谷等价执行关联，暂不估算金额")).toBeInTheDocument();
    expect(screen.getByText("避免高峰扣减：1,200 额度点")).toBeInTheDocument();
    expect(screen.getByText("拒绝 2 次，不计入已实现节省")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-earliest-exhaustion")).toHaveTextContent("最早耗尽资源：智谱 GLM 套餐");
    expect(screen.getByTestId("dashboard-resource-status")).toHaveTextContent("资源状态：全部正常");
    // “需要处理”保留在资源摘要内，不再抢在本月概览之前。
    expect(screen.getByText("需要处理")).toBeInTheDocument();
    expect(resourceSummary).toContainElement(screen.getByRole("heading", { name: "需要处理" }));
    expect(screen.getByText(/正常主体不会出现在这里/)).toBeInTheDocument();
    expect(screen.getAllByText("智谱 GLM 套餐").length).toBeGreaterThan(0);
    expect(screen.getByText(/预计 .* 耗尽/)).toBeInTheDocument();
    expect(screen.getAllByText(/可信度中/).length).toBeGreaterThan(0);
    // 超额列表：比例 "0.0500" → "5.00%"
    expect(screen.getAllByText("张三").length).toBe(2);
    expect(screen.getByText("5.00%")).toBeInTheDocument();
    expect(screen.getByText(/完整厂商与模型用量请前往/)).toBeInTheDocument();
    expect(screen.queryByText("按模型查看")).not.toBeInTheDocument();
    expect(screen.getByText("员工消耗 Token")).toBeInTheDocument();
    expect(screen.getAllByText("9,007,199,254,740,995,000")).toHaveLength(2);
    expect(screen.getByText("25.00%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看完整用量账本" })).toHaveAttribute("href", "/usage");
    expect(screen.queryByRole("button", { name: "保存并重算" })).not.toBeInTheDocument();
  });

  it("POOL20-039/047：Dashboard 单 USD 与多币种按代码展示，不伪装元或待补", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, refetch: vi.fn(),
      data: {
        ...seededSummary(),
        monthlyApiCost: null,
        monthlyApiCosts: [
          { currency: "CNY", amount: "12.5" },
          { currency: "USD", amount: "3.25" },
        ],
        monthlyApiSpendReason: "币种不一致：按币种独立展示",
        monthlyPackagePayment: "8",
        monthlyPackagePayments: [{ currency: "USD", amount: "8" }],
        monthlyTotalSpend: null,
        monthlyTotalSpends: [
          { currency: "CNY", amount: "12.5" },
          { currency: "USD", amount: "11.25" },
        ],
        monthlyRechargeAmount: "5",
        monthlyRechargeAmounts: [{ currency: "USD", amount: "5" }],
      },
    });
    renderDashboard();
    expect(screen.getByText("¥12.50 / USD 3.25")).toBeInTheDocument();
    expect(screen.getByText("USD 8.00")).toBeInTheDocument();
    expect(screen.getByText("¥12.50 / USD 11.25")).toBeInTheDocument();
    expect(screen.getByText("USD 5.00")).toBeInTheDocument();
    expect(screen.queryByText("待补套餐费用")).not.toBeInTheDocument();
  });

  it("实际切换存在但节省为零时不误报为无实际切换", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, refetch: vi.fn(),
      data: {
        ...emptySummary(),
        dispatchSavingBreakdown: {
          ...emptySummary().dispatchSavingBreakdown,
          actualSwitchCount: 1,
          realizedSwitchCount: 0,
          realizedReason: "实际切换缺少双端不可变价格快照",
        },
      },
    });
    renderDashboard();
    expect(screen.getByText("实际切换缺少双端不可变价格快照")).toBeInTheDocument();
    expect(screen.queryByText("本月无可计算的实际切换")).not.toBeInTheDocument();
  });

  it("真实 Token 明示未知计量笔数且缓存推理不重复累计", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, refetch: vi.fn(),
      data: {
        ...emptySummary(),
        monthlyTokenUsage: {
          ...emptySummary().monthlyTokenUsage,
          totalInputTokens: "100", totalOutputTokens: "20", totalCacheTokens: "40",
          totalReasoningTokens: "5", totalTokens: "120", usageQuality: "UNKNOWN",
          settledTransactionCount: 2, unknownTransactionCount: 1,
        },
      },
    });
    renderDashboard();
    expect(screen.getAllByText("120").length).toBeGreaterThan(0);
    expect(screen.getByText(/含 1 笔计量未知，数值只代表已记录 Token/)).toBeInTheDocument();
  });

  it.each([
    ["NO_DATA", { settledTransactionCount: 0 }, "本周期暂无已结算计量"],
    ["ACCOUNT_AGGREGATED", { settledTransactionCount: 2, accountAggregatedTransactionCount: 2 }, "2 笔账户聚合计量"],
    ["MIXED", { settledTransactionCount: 2, providerReportedTransactionCount: 1, mixedTransactionCount: 1 }, "混合计量"],
  ] as const)("POOL20-045：首页解释 %s 质量而不冒充精确", (quality, counts, expected) => {
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, refetch: vi.fn(),
      data: {
        ...emptySummary(),
        monthlyTokenUsage: {
          ...emptySummary().monthlyTokenUsage,
          usageQuality: quality,
          ...counts,
        },
      },
    });
    renderDashboard();
    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
  });

  it("员工区保留 1.0 月度总量，周期与单员工趋势由后端聚合切换", async () => {
    const user = userEvent.setup();
    const data = seededSummary();
    data.employeeUsageOverview = employeeOverview();
    useDashboardMock.mockReturnValue({ isLoading: false, error: null, data, refetch: vi.fn() });
    renderDashboard();

    expect(screen.getByText("本月消耗 Token 总数")).toBeInTheDocument();
    expect(screen.getByLabelText("首页员工用量趋势图")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "首页员工用量周期" }), "WEEK");
    await waitFor(() => {
      const query = new URLSearchParams(useUsageOverviewMock.mock.calls.at(-1)?.[0]);
      expect(query.get("period")).toBe("WEEK");
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "首页指定员工" }), overviewEmployeeId);
    await waitFor(() => {
      const query = new URLSearchParams(useUsageOverviewMock.mock.calls.at(-1)?.[0]);
      expect(query.get("subject_id")).toBe(overviewEmployeeId);
      expect(query.get("subject_type")).toBe("EMPLOYEE");
    });
  });

  it("POOL-023：降级资源不再显示全部正常", () => {
    const data = seededSummary();
    data.resourceStatus = {
      total: 2,
      status: "DEGRADED",
      statusCounts: { ACTIVE: 1, DEGRADED: 1 },
      abnormalResources: [{
        resourceId: "r2", resourceName: "智谱备用账号", providerName: "智谱",
        mode: "CODING_PLAN", status: "DEGRADED",
      }],
    };
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, data, refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByTestId("dashboard-resource-status")).toHaveTextContent("1 个资源需关注 · 降级");
    expect(screen.getAllByText("降级").length).toBeGreaterThan(0);
    expect(screen.getAllByText("智谱备用账号").length).toBeGreaterThan(0);
    expect(screen.getByTestId("dashboard-resource-status")).not.toHaveTextContent("全部正常");
  });

  it("首页不再承载厂商与模型用量大表", () => {
    useDashboardMock.mockReturnValue({ isLoading: false, error: null, data: seededSummary(), refetch: vi.fn() });
    renderDashboard();
    expect(screen.queryByRole("columnheader", { name: "厂商总额度" })).not.toBeInTheDocument();
    expect(screen.queryByText("按模型查看")).not.toBeInTheDocument();
    expect(screen.getByText(/厂商资源 → 用量总览/)).toBeInTheDocument();
  });
});
