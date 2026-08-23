import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResourceBreakdownItem, ResourceUsageOverview } from "../../api/types";
import { ResourceUsageOverviewPanel } from "./ResourceUsageOverviewPanel";

const useResourceUsageOverviewMock = vi.fn();

vi.mock("../../api/hooks", () => ({
  useResourceUsageOverview: () => useResourceUsageOverviewMock(),
}));

function providerSummary(): ResourceBreakdownItem {
  return {
    providerCode: "deepseek", providerName: "DeepSeek", mode: "API", accountCount: 1,
    totalQuota: null, usedQuota: null, remainingQuota: null, quotaUnit: null,
    allocatedQuota: null, currency: "CNY", rechargeAmount: "100", currentBalance: "87.9",
    currentPeriodCost: "12.1", packageCost: null, subscriptionPeriodStart: null,
    subscriptionPeriodEnd: null, snapshotAt: "2026-08-23T00:00:00.000Z",
    monthlyCost: "12.1", monthlyCostReason: null, monthlyInputTokens: "80",
    monthlyOutputTokens: "20", monthlyCacheTokens: "10", monthlyReasoningTokens: "2",
    monthlyTotalTokens: "100", monthlyUsageQuality: "EXACT", modelTokenBreakdown: [],
    tokenRate24h: "4.17", costRate24h: "0.5", estimatedBalanceTokens: null,
    balanceTokenEstimateConfidence: null, balanceTokenEstimateReason: null,
    balanceTokenEstimateBasis: null, currentRate24h: null, currentRateUnit: null,
    forecastConfidence: "MEDIUM", forecastNotCalculableReason: null, forecastDataPoints: 8,
    forecastExhaustAt: "2026-09-03T05:22:00.000Z", status: "HEALTHY",
    statusCounts: { ACTIVE: 1 }, abnormalResources: [],
  };
}

function overview(): ResourceUsageOverview {
  return {
    generatedAt: "2026-08-23T00:00:00.000Z",
    providerSummaries: [providerSummary()],
    modelDetails: [
      {
        resourceId: "api-1", resourceName: "DeepSeek 主账号", providerCode: "deepseek",
        providerName: "DeepSeek", mode: "API", unifiedModelId: "model-api",
        modelAlias: "ql-deepseek-v4", usedQuota: null, remainingQuota: null, quotaUnit: null,
        currency: "CNY", monthlyCost: "12.1", monthlyCostReason: null,
        monthlyTotalTokens: "100", usageQuality: "EXACT", consumptionRate24h: "4.17",
        consumptionRateUnit: "TOKEN_PER_HOUR", consumptionRateReason: null,
        forecastExhaustAt: "2026-09-03T05:22:00.000Z", forecastNotCalculableReason: null,
        forecastConfidence: "MEDIUM", status: "ACTIVE",
      },
      {
        resourceId: "plan-1", resourceName: "Kimi 套餐", providerCode: "kimi",
        providerName: "Kimi", mode: "CODING_PLAN", unifiedModelId: "model-plan",
        modelAlias: "ql-kimi-k3", usedQuota: "35", remainingQuota: "65", quotaUnit: "POINT",
        currency: "CNY", monthlyCost: null, monthlyCostReason: "套餐固定费，不按模型拆分",
        monthlyTotalTokens: "120", usageQuality: "ESTIMATED", consumptionRate24h: "2.5",
        consumptionRateUnit: "QUOTA_PER_HOUR", consumptionRateReason: null,
        forecastExhaustAt: null, forecastNotCalculableReason: "暂无预测快照",
        forecastConfidence: null, status: "DEGRADED",
      },
    ],
  };
}

describe("厂商资源用量总览", () => {
  beforeEach(() => {
    useResourceUsageOverviewMock.mockReturnValue({
      data: overview(), isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it("上方显示厂商总体，下方固定显示模型 + 具体资源明细", () => {
    render(<MemoryRouter><ResourceUsageOverviewPanel /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "厂商总体使用情况" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "模型使用明细" })).toBeInTheDocument();
    expect(screen.queryByText("按模型查看")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "余额可承载 Token" })).not.toBeInTheDocument();

    const apiRow = screen.getByText("ql-deepseek-v4").closest("tr")!;
    expect(within(apiRow).getByText("CNY 12.10")).toBeInTheDocument();
    expect(within(apiRow).getByText("4.17 Token/小时")).toBeInTheDocument();
    const planRow = screen.getByText("ql-kimi-k3").closest("tr")!;
    expect(within(planRow).getByText("套餐固定费，不按模型拆分")).toBeInTheDocument();
    expect(within(planRow).getByText("65 POINT")).toBeInTheDocument();
    expect(within(planRow).getByText("2.5 POINT/小时")).toBeInTheDocument();
  });
});
