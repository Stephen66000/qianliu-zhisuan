/**
 * W18 首页看板单测 —— 八项指标 / 三态 / 数据源 gap（null 不伪造）/ 空企业。
 *
 * 只 mock useDashboard hook；组件渲染断言。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardSummary } from "../api/types";
import { DashboardPage } from "./Dashboard";

const useDashboardMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useDashboard: () => useDashboardMock(),
}));

function emptySummary(): DashboardSummary {
  return {
    resourceAccountCount: 0,
    activeEmployeeCount: 0,
    currentInUseCount: 0,
    monthlyPackagePayment: null,
    monthlyApiCost: "0",
    monthlyRechargeAmount: null,
    earliestExhaustion: null,
    monthlyDispatchSaving: "0",
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
    monthlyApiCost: "12.50000000",
    monthlyDispatchSaving: "1.50000000",
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
        snapshotAt: "2026-07-29T12:00:00.000Z",
        monthlyCost: "12.50000000",
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
    expect(screen.getByText("厂商资源账号")).toBeInTheDocument();
    expect(screen.getByText("尚未登记厂商资源")).toBeInTheDocument();
    expect(screen.getByText("暂无员工消耗")).toBeInTheDocument();
    expect(screen.getByText(/无法产生模型和路由候选/)).toBeInTheDocument();
    // 调度节省为 "0" → 展示 0.00，不伪造（API 费用同为 0.00，允许出现多处）
    expect(screen.getByText("本月调度节省（元）")).toBeInTheDocument();
    expect(screen.getAllByText("0.00").length).toBeGreaterThan(0);
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
    expect(gaps).toHaveLength(2);
  });

  it("有数据：八项指标 + 资源摘要 + 超额 + 最早耗尽核心区", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: seededSummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    // 指标（费用在指标卡与资源摘要中都会出现，用 getAllByText）
    expect(screen.getByText("本账期活跃人数")).toBeInTheDocument();
    expect(screen.getByText("当前正在使用 3 人")).toBeInTheDocument();
    expect(screen.getAllByText("12.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.50").length).toBeGreaterThan(0);
    // 核心区：最早耗尽（字体三级：资源名 15px 600）；资源名同时出现在指标卡与核心区，允许多处
    expect(screen.getByText("需要处理")).toBeInTheDocument();
    expect(screen.getByText(/正常使用中的主体不会出现在这里/)).toBeInTheDocument();
    expect(screen.getAllByText("智谱 GLM 套餐").length).toBeGreaterThan(0);
    expect(screen.getByText(/预计 .* 耗尽/)).toBeInTheDocument();
    expect(screen.getByText(/可信度中/)).toBeInTheDocument();
    // 超额列表：比例 "0.0500" → "5.00%"
    expect(screen.getAllByText("张三").length).toBe(2);
    expect(screen.getByText("5.00%")).toBeInTheDocument();
    // 资源摘要
    expect(screen.getByText("智谱")).toBeInTheDocument();
    expect(screen.getAllByText("100,000").length).toBeGreaterThan(0);
    expect(screen.getByText("员工 Token 消耗")).toBeInTheDocument();
    expect(screen.getByText("9,007,199,254,740,995,000")).toBeInTheDocument();
    expect(screen.getByText("25.00%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看完整用量账本" })).toHaveAttribute("href", "/usage");
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
    expect(screen.getByText("1 项需关注 · 降级")).toBeInTheDocument();
    expect(screen.getByText("降级")).toBeInTheDocument();
    expect(screen.getByText("智谱备用账号")).toBeInTheDocument();
    expect(screen.queryByText("全部正常")).not.toBeInTheDocument();
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
    expect(screen.getAllByText("1,000,000")).toHaveLength(2);
    expect(screen.getByText("ql-deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.getByText("41,666.67 Token/小时")).toBeInTheDocument();
    expect(screen.getByText("约 12,500,000")).toBeInTheDocument();
    expect(screen.getByText("估算 · HIGH")).toBeInTheDocument();
  });
});
