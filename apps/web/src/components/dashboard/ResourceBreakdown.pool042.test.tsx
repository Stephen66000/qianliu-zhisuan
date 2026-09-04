import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ResourceBreakdownItem } from "../../api/types";
import { ResourceBreakdown } from "./ResourceBreakdown";

function item(overrides: Partial<ResourceBreakdownItem>): ResourceBreakdownItem {
  return {
    providerCode: "base", providerName: "基础厂商", mode: "API", accountCount: 1,
    totalQuota: null, usedQuota: null, remainingQuota: null, quotaUnit: null,
    allocatedQuota: null, currency: "CNY", rechargeAmount: null,
    currentBalance: "10", currentPeriodCost: null, snapshotAt: null, monthlyCost: "1",
    monthlyInputTokens: "10", monthlyOutputTokens: "2", monthlyCacheTokens: "1",
    monthlyReasoningTokens: "0", monthlyTotalTokens: "12", monthlyUsageQuality: "EXACT",
    modelTokenBreakdown: [], tokenRate24h: "0.5", costRate24h: "0.1",
    estimatedBalanceTokens: "1000", balanceTokenEstimateConfidence: "HIGH",
    balanceTokenEstimateReason: null, balanceTokenEstimateBasis: "测试估算依据",
    currentRate24h: null, currentRateUnit: null, forecastConfidence: null,
    forecastNotCalculableReason: null, forecastDataPoints: null, forecastExhaustAt: null,
    status: "HEALTHY", statusCounts: { ACTIVE: 1 }, abnormalResources: [],
    ...overrides,
    packageCost: overrides.packageCost ?? null,
    subscriptionPeriodStart: overrides.subscriptionPeriodStart ?? null,
    subscriptionPeriodEnd: overrides.subscriptionPeriodEnd ?? null,
    monthlyCostReason: overrides.monthlyCostReason ?? null,
  };
}

describe("POOL-042 ResourceBreakdown 边界展示", () => {
  it("总体表明确展示估算、未知、速度与既有预测的不可计算原因", () => {
    render(<ResourceBreakdown items={[
      item({
        providerCode: "estimated", providerName: "估算厂商", monthlyUsageQuality: "ESTIMATED",
        currency: null, tokenRate24h: null, costRate24h: "0.25",
        estimatedBalanceTokens: null, balanceTokenEstimateReason: "CURRENT_PRICE_RULE_MISSING",
        modelTokenBreakdown: [{
          unifiedModelId: null, modelAlias: "ql-unknown-model", inputTokens: null,
          outputTokens: null, cacheTokens: null, reasoningTokens: null,
          totalTokens: null, usageQuality: "UNKNOWN",
        }], status: "CUSTOM", abnormalResources: [{
          resourceId: "r-custom", resourceName: "自定义异常资源", status: "CUSTOM",
        }],
      }),
      item({
        providerCode: "unknown", providerName: "未知厂商", currentBalance: null,
        monthlyInputTokens: null, monthlyOutputTokens: null, monthlyCacheTokens: null,
        monthlyReasoningTokens: null, monthlyTotalTokens: null, monthlyUsageQuality: "UNKNOWN",
        tokenRate24h: null, costRate24h: null, estimatedBalanceTokens: null,
        balanceTokenEstimateReason: null, status: "RATE_LIMITED",
      }),
      item({
        providerCode: "invalid-rate", providerName: "异常速率厂商", tokenRate24h: "not-a-number",
        costRate24h: null, estimatedBalanceTokens: "10",
        balanceTokenEstimateConfidence: null, balanceTokenEstimateBasis: null,
      }),
      item({
        providerCode: "plan-currency", providerName: "套餐金额速度", mode: "CODING_PLAN",
        totalQuota: "100", usedQuota: "20", remainingQuota: "80", allocatedQuota: "50",
        currentBalance: null, monthlyUsageQuality: "ESTIMATED", currency: null,
        currentRate24h: "2", currentRateUnit: "CURRENCY_PER_HOUR", forecastConfidence: "LOW",
        forecastNotCalculableReason: "remaining_quota_unknown", estimatedBalanceTokens: null,
      }),
      item({
        providerCode: "plan-quota", providerName: "套餐额度速度", mode: "CODING_PLAN",
        currentBalance: null, currentRate24h: "2", currentRateUnit: "QUOTA_PER_HOUR",
        quotaUnit: null, forecastConfidence: "LOW", forecastNotCalculableReason: null,
        estimatedBalanceTokens: null,
      }),
      item({
        providerCode: "plan-zero", providerName: "套餐零速度", mode: "CODING_PLAN",
        currentBalance: null, currentRate24h: null, forecastConfidence: "LOW",
        forecastNotCalculableReason: "no_consumption_rate", forecastDataPoints: 0,
        estimatedBalanceTokens: null,
      }),
      item({
        providerCode: "plan-insufficient", providerName: "套餐数据不足", mode: "CODING_PLAN",
        currentBalance: null, currentRate24h: null, forecastConfidence: "LOW",
        forecastNotCalculableReason: "no_consumption_rate", forecastDataPoints: 1,
        estimatedBalanceTokens: null,
      }),
      item({
        providerCode: "plan-other", providerName: "套餐其他原因", mode: "CODING_PLAN",
        currentBalance: null, currentRate24h: null, forecastConfidence: "LOW",
        forecastNotCalculableReason: "other", estimatedBalanceTokens: null,
        status: "DEGRADED",
      }),
    ]} />);

    expect(screen.getAllByText("估算计量").length).toBeGreaterThan(0);
    expect(screen.queryByText("ql-unknown-model")).not.toBeInTheDocument();
    expect(screen.queryByText("按模型查看")).not.toBeInTheDocument();
    expect(screen.getByText("不可计算（计量未知）")).toBeInTheDocument();
    expect(screen.getByText("最近24小时无可用数据")).toBeInTheDocument();
    expect(screen.getByText("not-a-number Token/小时")).toBeInTheDocument();
    expect(screen.getByText("金额 2/h")).toBeInTheDocument();
    expect(screen.getByText("2/h 额度")).toBeInTheDocument();
    expect(screen.getByText("余额未知")).toBeInTheDocument();
    expect(screen.getByText("暂无用量数据")).toBeInTheDocument();
    expect(screen.getByText("当前速度为零/数据不足")).toBeInTheDocument();
    expect(screen.getAllByText("数据不足/不可计算").length).toBeGreaterThan(0);
    expect(screen.getAllByText("按当前数据不可计算")).toHaveLength(2);
    expect(screen.getByText("自定义异常资源")).toBeInTheDocument();
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
    expect(screen.getByText("限流冷却")).toBeInTheDocument();
    expect(screen.getByText("可用（降权）")).toBeInTheDocument();
  });
});
