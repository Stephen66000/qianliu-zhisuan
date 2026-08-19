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
    metrics: { activeSubjects: 1, requestCount: "3", inputTokens: "8000", outputTokens: "2000", cacheTokens: "1000", reasoningTokens: "300", realTokens: "10000", apiCost: "2", deductedQuota: "10000" },
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
    monthlyApiCost: "0",
    monthlyTotalSpend: null,
    monthlyRechargeAmount: null,
    earliestExhaustion: null,
    monthlyDispatchSaving: "0",
    dispatchSavingBreakdown: {
      realizedAmount: "0", realizedSwitchCount: 0, realizedReason: "本月无可计算的实际切换",
      potentialPeakSavingAmount: null, potentialReason: "缺少同一任务的峰值/低谷等价执行关联，暂不估算金额",
      avoidedPeakDeduction: "0", avoidedDeductionCount: 0,
      avoidedReason: "本月无具备双端倍率快照的已执行切换", rejectedRequestCount: 0,
    },
    resourceBreakdown: [],
    overageList: [],
    monthlyTokenUsage: {
      totalInputTokens: "0", totalOutputTokens: "0", totalCacheTokens: "0",
      totalReasoningTokens: "0", totalTokens: "0", employeeRanking: [],
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
    monthlyApiCost: "12.50000000",
    monthlyTotalSpend: "311.50000000",
    monthlyRechargeAmount: "100",
    monthlyDispatchSaving: "1.50000000",
    dispatchSavingBreakdown: {
      realizedAmount: "1.50000000", realizedSwitchCount: 1, realizedReason: null,
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
    resourceBreakdown: [
      {
        providerCode: "zhipu",
        providerName: "智谱",
        mode: "CODING_PLAN",
        accountCount: 2,
        totalQuota: "100000",
        usedQuota: "50000",
        remainingQuota: "50000",
        quotaUnit: "TOKEN",
        allocatedQuota: "120000",
        currency: "CNY",
        rechargeAmount: null,
        currentBalance: null,
        currentPeriodCost: null,
        packageCost: "299",
        subscriptionPeriodStart: "2026-06-26",
        subscriptionPeriodEnd: "2026-09-26",
        snapshotAt: "2026-07-29T12:00:00.000Z",
        monthlyCost: "299.00000000",
        monthlyInputTokens: "80000",
        monthlyOutputTokens: "20000",
        monthlyCacheTokens: "10000",
        monthlyReasoningTokens: "5000",
        monthlyTotalTokens: "100000",
        monthlyUsageQuality: "EXACT",
        modelTokenBreakdown: [],
        tokenRate24h: "1000",
        costRate24h: null,
        estimatedBalanceTokens: null,
        balanceTokenEstimateConfidence: null,
        balanceTokenEstimateReason: "NOT_API_RESOURCE",
        balanceTokenEstimateBasis: null,
        currentRate24h: "2400.5",
        currentRateUnit: "QUOTA_PER_HOUR",
        forecastConfidence: "MEDIUM",
        forecastNotCalculableReason: null,
        forecastDataPoints: 20,
        forecastExhaustAt: "2026-07-30T12:00:00.000Z",
        status: "HEALTHY",
        statusCounts: { ACTIVE: 2 },
        abnormalResources: [],
      },
    ],
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

  it("数据源 gap：套餐支付/充值为 null → 空状态文案，不伪造数字", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: emptySummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    const gaps = screen.getAllByText("数据源待接入");
    expect(gaps).toHaveLength(3);
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

    expect(screen.getByText("311.50")).toBeInTheDocument();
    expect(screen.getByText("当前正在使用 3 人")).toBeInTheDocument();
    expect(screen.getAllByText("12.50").length).toBeGreaterThan(0);
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
    // 资源摘要
    expect(screen.getByText("智谱")).toBeInTheDocument();
    expect(screen.getAllByText("100,000").length).toBeGreaterThan(0);
    const planRow = screen.getByText("智谱").closest("tr")!;
    expect(within(planRow).getByText("CNY 299.00")).toBeInTheDocument();
    expect(within(planRow).getByText("订阅周期 2026-06-26～2026-09-26")).toBeInTheDocument();
    expect(within(planRow).getByText("299.00")).toBeInTheDocument();
    expect(screen.getByText("员工消耗 Token")).toBeInTheDocument();
    expect(screen.getAllByText("9,007,199,254,740,995,000")).toHaveLength(2);
    expect(screen.getByText("25.00%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看完整用量账本" })).toHaveAttribute("href", "/usage");
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
    data.resourceBreakdown[0]!.status = "DEGRADED";
    data.resourceBreakdown[0]!.statusCounts = { ACTIVE: 1, DEGRADED: 1 };
    data.resourceBreakdown[0]!.abnormalResources = [{
      resourceId: "r2", resourceName: "智谱备用账号", status: "DEGRADED",
    }];
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, data, refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByTestId("dashboard-resource-status")).toHaveTextContent("1 项需关注 · 降级");
    expect(screen.getByText("降级")).toBeInTheDocument();
    expect(screen.getByText("智谱备用账号")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-resource-status")).not.toHaveTextContent("全部正常");
  });

  it("POOL-042：API 资源显示 Token 分项、模型下钻、速度和余额估算说明", () => {
    const data = seededSummary();
    data.resourceBreakdown.push({
      ...data.resourceBreakdown[0]!,
      providerCode: "deepseek", providerName: "DeepSeek", mode: "API",
      accountCount: 1, totalQuota: null, usedQuota: null, remainingQuota: null,
      quotaUnit: null, allocatedQuota: null, currency: "CNY",
      currentBalance: "68", currentPeriodCost: "47.41", monthlyCost: "6.32",
      monthlyInputTokens: "800000", monthlyOutputTokens: "200000",
      monthlyCacheTokens: "100000", monthlyReasoningTokens: "50000",
      monthlyTotalTokens: "1000000", monthlyUsageQuality: "EXACT",
      modelTokenBreakdown: [{
        unifiedModelId: "model-flash", modelAlias: "ql-deepseek-v4-flash",
        inputTokens: "800000", outputTokens: "200000", cacheTokens: "100000",
        reasoningTokens: "50000", totalTokens: "1000000",
        usageQuality: "EXACT",
      }],
      tokenRate24h: "41666.67", costRate24h: "0.25",
      estimatedBalanceTokens: "12500000", balanceTokenEstimateConfidence: "HIGH",
      balanceTokenEstimateReason: null,
      balanceTokenEstimateBasis: "最近24小时 24 条账本；按当前有效价格估算",
    });
    useDashboardMock.mockReturnValue({
      isLoading: false, error: null, data, refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    const apiRow = screen.getByText("DeepSeek").closest("tr")!;
    expect(within(apiRow).getByText("CNY 68.00")).toBeInTheDocument();
    expect(within(apiRow).getByText("API 花费 6.32")).toBeInTheDocument();
    expect(screen.getAllByText("1,000,000")).toHaveLength(2);
    expect(screen.getByText("ql-deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.getByText("41,666.67 Token/小时")).toBeInTheDocument();
    expect(screen.getByText("约 12,500,000")).toBeInTheDocument();
    expect(screen.getByText("估算 · HIGH")).toBeInTheDocument();
  });
});
