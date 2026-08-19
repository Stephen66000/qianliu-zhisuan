import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceUtilization } from "../../api/v2-types";
import { ResourceUtilizationPanel } from "./ResourceUtilizationPanel";

const useResourceUtilizationMock = vi.fn();

vi.mock("../../api/v2-hooks", () => ({
  V2_KEYS: { utilization: (month: string) => ["v2", "resource-utilization", month] },
  useResourceUtilization: (month: string) => useResourceUtilizationMock(month),
}));

function resource(overrides: Partial<ResourceUtilization>): ResourceUtilization {
  return {
    resourceId: "resource-default",
    providerId: "provider-default",
    providerName: "测试厂商",
    resourceName: "测试资源",
    mode: "API",
    resourceStatus: "ACTIVE",
    requestCount: 1,
    realTokens: "1000",
    apiCost: "12.50000000",
    deductedQuota: "0",
    purchaseCashAmount: "100.00000000",
    currency: "CNY",
    budgetAmount: null,
    currentBalance: "87.50000000",
    packageCost: null,
    totalQuota: null,
    usedQuota: null,
    remainingQuota: null,
    quotaUnit: null,
    utilizationRate: null,
    idleEntitlementCost: null,
    rate1h: null,
    rate24h: null,
    rate7d: null,
    forecastExhaustAt: null,
    nextRecoverAt: null,
    coverageHours: null,
    forecastStatus: "NOT_AVAILABLE",
    utilizationStatus: "NOT_CONFIGURED",
    forecastConfidence: null,
    forecastNotCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
    forecastDataAt: null,
    lastSettledRequestAt: "2026-08-11T00:00:00.000Z",
    continuousNoCallDays: 2,
    idleStatus: "UNASSESSED",
    utilizationBasis: null,
    notCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
    dataAt: "2026-08-11T00:00:00.000Z",
    quotaWindows: [],
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ResourceUtilizationPanel resources={[]} />
    </QueryClientProvider>,
  );
}

describe("W20-08 资源利用事实 Web", () => {
  beforeEach(() => {
    useResourceUtilizationMock.mockReset();
    useResourceUtilizationMock.mockReturnValue({
      data: {
        month: "2026-08",
        generatedAt: "2026-08-13T00:00:00.000Z",
        resources: [
          resource({ resourceId: "deepseek-api", providerName: "DeepSeek", resourceName: "API 账户" }),
          resource({
            resourceId: "kimi-plan",
            providerId: "kimi",
            providerName: "Kimi",
            resourceName: "Coding Plan",
            mode: "CODING_PLAN",
            requestCount: 0,
            realTokens: "0",
            apiCost: "0",
            purchaseCashAmount: "300.00000000",
            packageCost: "300.00000000",
            totalQuota: "100.00000000",
            usedQuota: "35.00000000",
            remainingQuota: "65.00000000",
            quotaUnit: "POINT",
            servicePeriodStart: "2026-08-01T00:00:00.000+08:00",
            servicePeriodEnd: "2026-09-01T00:00:00.000+08:00",
            utilizationRate: "0.35000000",
            utilizationBasis: "CODING_PLAN_SUBSCRIPTION_PERIOD",
            utilizationStatus: "LOW_UTILIZATION",
            forecastExhaustAt: "2099-08-20T00:00:00.000Z",
            nextRecoverAt: "2099-08-21T00:00:00.000Z",
            coverageHours: "48",
            forecastConfidence: "HIGH",
            forecastNotCalculableReason: "FORECAST_STALE",
            forecastDataAt: new Date(Date.now() - 20 * 60_000).toISOString(),
            lastSettledRequestAt: null,
            continuousNoCallDays: null,
            notCalculableReason: null,
            quotaWindows: [
              {
                type: "FIVE_HOUR",
                limitValue: "100",
                usedValue: "40",
                remainingValue: "60",
                ratio: "0.4",
                unit: "PERCENT",
                resetAt: "2026-08-13T01:00:00.000Z",
                providerDataAt: "2026-08-13T00:00:00.000Z",
                collectedAt: "2026-08-13T00:00:00.000Z",
                syncStatus: "SUCCESS",
                syncErrorCode: null,
              },
              {
                type: "WEEKLY",
                limitValue: "100",
                usedValue: "20",
                remainingValue: "80",
                ratio: "0.2",
                unit: "PERCENT",
                resetAt: "2026-08-17T00:00:00.000Z",
                providerDataAt: "2026-08-13T00:00:00.000Z",
                collectedAt: "2026-08-13T00:00:00.000Z",
                syncStatus: "SUCCESS",
                syncErrorCode: null,
              },
            ],
          }),
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("API 无分母显示未设置，不伪造 0%", () => {
    renderPanel();
    const row = screen.getByText("DeepSeek · API 账户").closest("tr")!;
    expect(within(row).getAllByText("MONTHLY_BUDGET_NOT_CONFIGURED")).toHaveLength(2);
    expect(within(row).queryByText("0.0%")).not.toBeInTheDocument();
    expect(within(row).getByText(/2 天无调用/)).toBeInTheDocument();
    expect(within(row).getByText(/未判定/)).toBeInTheDocument();
  });

  it("Coding Plan 分开展示 5 小时和周窗口，过期预测不展示精确耗尽日期", () => {
    renderPanel();
    const row = screen.getByText("Kimi · Coding Plan").closest("tr")!;
    expect(within(row).getByText("5 小时：40/100 PERCENT · SUCCESS")).toBeInTheDocument();
    expect(within(row).getByText("周：20/100 PERCENT · SUCCESS")).toBeInTheDocument();
    expect(within(row).getByText("35.0%")).toBeInTheDocument();
    expect(within(row).getByText("订阅周期累计")).toBeInTheDocument();
    expect(within(row).getByText("2026-08-01～2026-09-01")).toBeInTheDocument();
    expect(within(row).getByText("STALE · 预测超过 15 分钟")).toBeInTheDocument();
    expect(within(row).queryByText(/2099/)).not.toBeInTheDocument();
    expect(within(row).getByText(/无调用天数未知/)).toBeInTheDocument();
    expect(within(row).getByText(/未判定/)).toBeInTheDocument();
  });
});
