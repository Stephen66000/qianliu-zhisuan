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
  const currentMonthTokens = overrides.realTokens ?? "9000000";
  return {
    resourceId: "resource-default",
    providerId: "provider-default",
    providerName: "测试厂商",
    resourceName: "测试资源",
    mode: "API",
    resourceStatus: "ACTIVE",
    requestCount: 1,
    realTokens: currentMonthTokens,
    tokenUtilization: {
      currentMonthTokens, trailingThreeMonthAverageTokens: "10000000",
      baselineMonths: ["2026-05", "2026-06", "2026-07"], baselineMonthCount: 3,
      rate: String(Number(currentMonthTokens) / 10000000), basis: "CURRENT_MONTH_VS_UP_TO_3_COMPLETE_MONTHS", unavailableReason: null,
    },
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

  it("API 显示 Token 利用率，无预算仍可计算，费用保留且不混入余额", () => {
    renderPanel();
    const row = screen.getByText("DeepSeek · API 账户").closest("tr")!;
    expect(within(row).getByText("CNY 12.50")).toBeInTheDocument();
    expect(within(row).queryByText(/余额/)).not.toBeInTheDocument();
    expect(within(row).queryByText("0.0%")).not.toBeInTheDocument();
    expect(within(row).getByText("90.0%")).toHaveAttribute("title", expect.stringContaining("近 3 个完整月月均 Token 10,000,000"));
    expect(within(row).getByText("1 / 9,000,000")).toBeInTheDocument();
    expect(within(row).getByText("90.0%")).toHaveAttribute("title", expect.stringContaining("本月真实 Token 9,000,000"));
    expect(within(row).getByText(/距最近使用 2 天/)).toBeInTheDocument();
  });

  it("Coding Plan 使用同一 Token 基线，订阅周期及额度独立展示", () => {
    renderPanel();
    const row = screen.getByText("Kimi · Coding Plan").closest("tr")!;
    expect(within(row).queryByText(/5 小时：/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/周：/)).not.toBeInTheDocument();
    expect(within(row).getByText("0.0%")).toBeInTheDocument();
    expect(within(row).getByText("0 / 0")).toBeInTheDocument();
    expect(within(row).getByText("0.0%")).toHaveAttribute("title", expect.stringContaining("本月真实 Token 0"));
    expect(within(row).queryByText("订阅周期累计")).not.toBeInTheDocument();
    expect(within(row).getByText("订阅额度 100 POINT")).toBeInTheDocument();
    expect(within(row).getByText("2026-08-01～2026-09-01")).toBeInTheDocument();
    expect(within(row).queryByText(/2099/)).not.toBeInTheDocument();
    expect(within(row).getByText("暂无结算用量")).toBeInTheDocument();
  });

  it("扣减事实不完整不会阻止 Token 利用率展示", () => {
    useResourceUtilizationMock.mockReturnValue({
      data: {
        month: "2026-09",
        generatedAt: "2026-09-04T11:00:00.000Z",
        resources: [resource({
          resourceId: "kimi-incomplete-deduction",
          providerName: "Kimi",
          resourceName: "Coding Plan",
          mode: "CODING_PLAN",
          packageCost: "199",
          totalQuota: "300000000",
          usedQuota: null,
          remainingQuota: null,
          quotaUnit: "TOKEN",
          servicePeriodStart: "2026-08-19",
          servicePeriodEnd: "2026-09-19",
          utilizationRate: null,
          utilizationBasis: null,
          utilizationStatus: "UNKNOWN",
          notCalculableReason: "SUBSCRIPTION_DEDUCTION_FACT_INCOMPLETE",
        })],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderPanel();
    const row = screen.getByText("Kimi · Coding Plan").closest("tr")!;
    expect(within(row).getByText("订阅额度 300,000,000 TOKEN")).toBeInTheDocument();
    expect(within(row).getByText("90.0%")).toBeInTheDocument();
    expect(within(row).queryByText("部分调用缺少扣减额度，利用率暂不可算")).not.toBeInTheDocument();
    expect(within(row).queryByText("缺少订阅额度事实")).not.toBeInTheDocument();
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
    expect(within(row).getByText("90.0%")).toBeInTheDocument();
    expect(within(row).getByText("2026-08-01～未知")).toBeInTheDocument();
  });

  it.each(["INSUFFICIENT_HISTORY", "ZERO_BASELINE"] as const)("%s 显示占位及悬停原因，不回退旧额度利用率", (reason) => {
    const row = resource({ utilizationRate: "0.7" });
    row.tokenUtilization = { ...row.tokenUtilization!, rate: null, unavailableReason: reason,
      baselineMonths: reason === "ZERO_BASELINE" ? ["2026-08"] : [],
      baselineMonthCount: reason === "ZERO_BASELINE" ? 1 : 0,
      trailingThreeMonthAverageTokens: reason === "ZERO_BASELINE" ? "0" : null };
    useResourceUtilizationMock.mockReturnValue({ data: { resources: [row] }, isLoading: false, error: null, refetch: vi.fn() });
    renderPanel();
    expect(screen.getByTitle(new RegExp(reason === "ZERO_BASELINE" ? "历史月均为 0" : "暂无完整历史自然月"))).toHaveTextContent("—");
    expect(screen.queryByText("70.0%")).not.toBeInTheDocument();
  });

  it.each([
    [1, ["2026-08"], "近 1 个完整月月均 Token"],
    [2, ["2026-07", "2026-08"], "近 2 个完整月月均 Token"],
    [3, ["2026-06", "2026-07", "2026-08"], "近 3 个完整月月均 Token"],
  ])("使用 %s 个完整历史月时悬停说明实际分母", (count, months, label) => {
    const row = resource({});
    row.tokenUtilization = { ...row.tokenUtilization!, baselineMonthCount: count,
      baselineMonths: months, trailingThreeMonthAverageTokens: "10000000" };
    useResourceUtilizationMock.mockReturnValue({ data: { resources: [row] }, isLoading: false, error: null, refetch: vi.fn() });
    renderPanel();
    expect(screen.getByText("90.0%")).toHaveAttribute("title", expect.stringContaining(label));
  });

  it("月均 Token 小数在悬停中最多保留两位", () => {
    const row = resource({ realTokens: "1" });
    row.tokenUtilization = { ...row.tokenUtilization!, currentMonthTokens: "1",
      trailingThreeMonthAverageTokens: "0.33333333", rate: "3" };
    useResourceUtilizationMock.mockReturnValue({ data: { resources: [row] }, isLoading: false, error: null, refetch: vi.fn() });
    renderPanel();
    expect(screen.getByText("300.0%")).toHaveAttribute("title", expect.stringContaining("近 3 个完整月月均 Token 0.33"));
  });

  it.each([
    ["1150000", "0.01150000", "1.2%"],
    ["2550000", "0.02550000", "2.6%"],
    ["1149999", "0.01149999", "1.1%"],
    ["50000", "0.00050000", "0.1%"],
    ["99950000", "0.99950000", "100.0%"],
    ["199950000", "1.99950000", "200.0%"],
    ["0", "0.00000000", "0.0%"],
  ])("P3：%s Token 的比例 %s 按十进制舍入为 %s", (tokens, rate, expected) => {
    const row = resource({ realTokens: tokens });
    row.tokenUtilization = { ...row.tokenUtilization!, trailingThreeMonthAverageTokens: "100000000", rate };
    useResourceUtilizationMock.mockReturnValue({ data: { resources: [row] }, isLoading: false, error: null, refetch: vi.fn() });
    renderPanel();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("P3：超安全整数 Token 在主表和悬停中保持相同原值", () => {
    const tokens = "9007199254740993";
    const row = resource({ realTokens: tokens });
    row.tokenUtilization = { ...row.tokenUtilization!, rate: "900719925.47409930" };
    useResourceUtilizationMock.mockReturnValue({ data: { resources: [row] }, isLoading: false, error: null, refetch: vi.fn() });
    renderPanel();
    expect(screen.getByText("1 / 9,007,199,254,740,993")).toBeInTheDocument();
    expect(screen.getByTitle(/本月真实 Token 9,007,199,254,740,993/)).toBeInTheDocument();
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
    expect(within(row).getByText("CNY 12.50")).toBeInTheDocument();
    expect(within(row).queryByText(/余额/)).not.toBeInTheDocument();
    expect(within(row).queryByText("未设置")).not.toBeInTheDocument();
  });

  it("当天有结算用量时不显示连续零天无调用", () => {
    useResourceUtilizationMock.mockReturnValue({
      data: { month: "2026-08", generatedAt: "2026-08-13T00:00:00.000Z",
        resources: [resource({ continuousNoCallDays: 0 })] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    renderPanel();
    expect(screen.getByText("今日有使用")).toBeInTheDocument();
    expect(screen.queryByText(/连续 0 天无调用/)).not.toBeInTheDocument();
  });
});
