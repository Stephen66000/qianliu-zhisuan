import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceUtilization } from "../../api/v2-types";
import { ResourceUtilizationPanel } from "./ResourceUtilizationPanel";

const useResourceUtilizationMock = vi.fn();
const useResourceMonthlyBudgetMock = vi.fn();
const saveBudgetMutate = vi.fn();

vi.mock("../../api/v2-hooks", () => ({
  V2_KEYS: { utilization: (month: string) => ["v2", "resource-utilization", month] },
  useResourceUtilization: (month: string) => useResourceUtilizationMock(month),
  useResourceMonthlyBudget: (resourceId: string | null, month: string) =>
    useResourceMonthlyBudgetMock(resourceId, month),
  useSaveResourceMonthlyBudget: () => ({
    mutate: saveBudgetMutate,
    isPending: false,
    error: null,
  }),
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
    budgetCurrency: null,
    budgetVersion: 0,
    budgetStatus: "NOT_CONFIGURED",
    budgetUpdatedAt: null,
    budgetDifference: null,
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
    useResourceMonthlyBudgetMock.mockReset();
    saveBudgetMutate.mockReset();
    useResourceMonthlyBudgetMock.mockReturnValue({
      data: {
        resource: { id: "deepseek-api", name: "API 账户", mode: "API" },
        month: "2026-08",
        current: null,
        history: [],
      },
      isLoading: false,
      error: null,
    });
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

  it("API 利用率显示不适用，费用与已有余额保留", () => {
    renderPanel();
    const row = screen.getByText("DeepSeek · API 账户").closest("tr")!;
    expect(within(row).getByText("¥12.50")).toBeInTheDocument();
    expect(within(row).getByText("余额 ¥87.50")).toBeInTheDocument();
    expect(within(row).queryByText("0.0%")).not.toBeInTheDocument();
    expect(within(row).getByText(/2 天无调用/)).toBeInTheDocument();
    expect(within(row).getByText(/未判定/)).toBeInTheDocument();
  });

  it("Coding Plan 只保留周期利用率和订阅周期，不展示窗口与预测", () => {
    renderPanel();
    const row = screen.getByText("Kimi · Coding Plan").closest("tr")!;
    expect(within(row).queryByText(/5 小时：/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/周：/)).not.toBeInTheDocument();
    expect(within(row).getByText("35.0%")).toBeInTheDocument();
    expect(within(row).getByText("订阅周期累计")).toBeInTheDocument();
    expect(within(row).getByText("2026-08-01～2026-09-01")).toBeInTheDocument();
    expect(within(row).queryByText(/2099/)).not.toBeInTheDocument();
    expect(within(row).getByText(/无调用天数未知/)).toBeInTheDocument();
    expect(within(row).getByText(/未判定/)).toBeInTheDocument();
  });

  it("POOL20-041：缺订阅结束日期时不把额度比例包装为周期累计", () => {
    useResourceUtilizationMock.mockReturnValue({
      data: {
        month: "2026-08",
        generatedAt: "2026-08-13T00:00:00.000Z",
        resources: [resource({
          resourceId: "kimi-incomplete-period",
          providerName: "Kimi",
          resourceName: "周期待补套餐",
          mode: "CODING_PLAN",
          packageCost: "300",
          totalQuota: "100",
          usedQuota: "35",
          remainingQuota: "65",
          quotaUnit: "POINT",
          servicePeriodStart: "2026-08-01",
          servicePeriodEnd: null,
          utilizationRate: null,
          utilizationBasis: null,
          utilizationStatus: "UNDERUSED",
          notCalculableReason: "SUBSCRIPTION_PERIOD_END_NOT_AVAILABLE",
        })],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderPanel();
    const row = screen.getByText("Kimi · 周期待补套餐").closest("tr")!;
    expect(within(row).queryByText("订阅周期累计")).not.toBeInTheDocument();
    expect(within(row).getByText("缺少订阅结束日期")).toBeInTheDocument();
    expect(within(row).getByText("2026-08-01～未知")).toBeInTheDocument();
  });

  it("POOL20-047：API 资源按当前选择月份设置预算，Coding Plan 不出现入口", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getAllByRole("button", { name: "设置月预算" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "设置月预算" }));
    const budgetRegion = screen.getByRole("region", { name: "API 资源月预算设置" });
    expect(budgetRegion).toBeInTheDocument();
    const expectedMonth = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
    }).format(new Date()).slice(0, 7);
    expect(within(budgetRegion).getByDisplayValue(expectedMonth)).toBeDisabled();
    await user.type(screen.getByLabelText("月预算金额"), "200");
    await user.selectOptions(screen.getByLabelText("月预算币种"), "USD");
    await user.click(screen.getByRole("button", { name: "保存月预算" }));
    expect(saveBudgetMutate).toHaveBeenCalledWith({
      amount: "200",
      currency: "USD",
      expected_version: 0,
    }, expect.any(Object));
  });

  it("POOL20-047：预算列使用实际币种，不再重复展示判断依据", () => {
    useResourceUtilizationMock.mockReturnValue({
      data: {
        month: "2026-08",
        generatedAt: "2026-08-13T00:00:00.000Z",
        resources: [resource({
          budgetAmount: "200",
          budgetCurrency: "USD",
          budgetVersion: 1,
          budgetStatus: "ACTIVE",
          budgetDifference: "187.5",
          utilizationRate: "0.0625",
          utilizationBasis: "API_MONTHLY_BUDGET",
          utilizationStatus: "NORMAL",
          notCalculableReason: null,
        })],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderPanel();
    expect(screen.getByText("USD 200.00")).toBeInTheDocument();
    expect(screen.queryByText("预算 USD 200.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/预算 ¥/)).not.toBeInTheDocument();
  });

  it("余额未设置时只显示费用，不显示余额占位", () => {
    useResourceUtilizationMock.mockReturnValue({
      data: {
        month: "2026-08", generatedAt: "2026-08-13T00:00:00.000Z",
        resources: [resource({ currentBalance: null })],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderPanel();
    const row = screen.getByText("测试厂商 · 测试资源").closest("tr")!;
    expect(within(row).getByText("¥12.50")).toBeInTheDocument();
    expect(within(row).queryByText(/余额/)).not.toBeInTheDocument();
    expect(within(row).queryByText("未设置")).not.toBeInTheDocument();
  });
});
