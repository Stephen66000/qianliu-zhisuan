import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import {
  ValueRealizationSection,
  computePlanValueRow,
  computePlanValueSummary,
  subscriptionFeeForMonth,
} from "./ValueRealizationSection";

const useProvidersMock = vi.fn();
const useProviderResourcesMock = vi.fn();
const useProviderSubscriptionPeriodsMock = vi.fn();

vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviders: () => useProvidersMock(),
  useProviderResources: () => useProviderResourcesMock(),
}));

vi.mock("../../api/provider-finance", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviderSubscriptionPeriods: (resourceId: string | null) =>
    useProviderSubscriptionPeriodsMock(resourceId),
}));

function tokenOnlyAnalysis(): OperatingAnalysis {
  return {
    payments: [],
    month: "2026-09",
    currentMonth: "2026-09",
    generatedAt: "2026-09-19T00:00:00Z",
    summary: {
      companyTokens: null,
      ytdAverageTokens: null,
      ytdAverageChange: null,
      perCapitaTokens: null,
      perCapitaChange: null,
      planUtilization: null,
    },
    months: [
      {
        month: "2026-09",
        totalTokens: "606750000",
        inputTokens: null,
        outputTokens: null,
        cacheTokens: null,
        employeeTokens: null,
        projectTokens: null,
        employeeCount: 4,
        activeEmployees: 4,
        perCapitaTokens: null,
      },
    ],
    plans: [
      {
        providerCode: "kimi",
        providerName: "Kimi",
        peakTokens: "0",
        months: [
          { month: "2026-09", totalTokens: "162290000", inputTokens: null, outputTokens: null, utilization: null },
        ],
      },
      {
        providerCode: "zhipu",
        providerName: "智谱",
        peakTokens: "0",
        months: [
          { month: "2026-09", totalTokens: "444620000", inputTokens: null, outputTokens: null, utilization: null },
        ],
      },
    ],
    purchases: [
      {
        providerCode: "kimi",
        providerName: "Kimi",
        mode: "CODING_PLAN",
        monthlyCash: ["199.00"],
        yearCash: "199.00",
      },
      {
        providerCode: "zhipu",
        providerName: "智谱",
        mode: "CODING_PLAN",
        monthlyCash: ["0.00"],
        yearCash: "422.10",
      },
    ],
    cashSummary: { monthlyCash: [], yearCash: null, averageCash: null, highestMonths: [] },
    apiAccounts: [],
  };
}

describe("ValueRealizationSection 价值体现", () => {
  beforeEach(() => {
    useProvidersMock.mockReturnValue({ data: { providers: [] } });
    useProviderResourcesMock.mockReturnValue({ data: { resources: [] } });
    useProviderSubscriptionPeriodsMock.mockReturnValue({ data: { periods: [] } });
  });

  it("正确渲染四大价值指标卡、账号复用核算表和套餐摊薄表", () => {
    render(<ValueRealizationSection month="2026-09" />);

    expect(screen.getByText("当月账号等效少购节约")).toBeInTheDocument();
    expect(screen.getByText("账号平均复用倍比")).toBeInTheDocument();
    expect(screen.getByText("Coding Plan 实际摊薄单价")).toBeInTheDocument();
    expect(screen.getByText("Coding Plan 等效采购降本")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "1. 账号复用核算表" })).toBeInTheDocument();
    expect(screen.getAllByText("Kimi Coding Plan")).toHaveLength(2);
    expect(screen.getAllByText("智谱 Coding Plan")).toHaveLength(2);
    expect(screen.getByText("DeepSeek (API 集中托管)")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "2. Coding Plan 额度摊薄单价与超值对比" })).toBeInTheDocument();
    expect(screen.getByText("官方同级 API 市价")).toBeInTheDocument();
    expect(screen.getByText("等效折扣率")).toBeInTheDocument();
  });

  it("汇总口径复算：Kimi 162.26M/¥199/¥12 + 智谱 444.49M/¥422.10/¥15 → 0.7 折 / -92.8%", () => {
    const kimi = computePlanValueRow(199.0, 162.26, 12.0);
    const zhipu = computePlanValueRow(422.1, 444.49, 15.0);
    const summary = computePlanValueSummary(kimi, zhipu);

    expect(summary.totalPlanPrice).toBeCloseTo(621.1, 2);
    expect(summary.totalOfficialCost).toBeCloseTo(1947.12 + 6667.35, 2);
    expect(summary.totalPlanTokensM).toBeCloseTo(606.75, 2);
    expect(summary.blendedOfficialRate).toBeCloseTo(14.2, 2);
    expect(summary.weightedDiscount.toFixed(1)).toBe("0.7");
    expect((100 - summary.weightedDiscount * 10).toFixed(1)).toBe("92.8");
    expect(summary.weightedDiscount).toBeCloseTo(
      (10 * summary.totalPlanPrice) / summary.totalOfficialCost,
      10,
    );
  });

  it("数据缺失时显示「数据不足」，不输出兜底的伪造数字", () => {
    render(<ValueRealizationSection month="2026-09" />);
    expect(screen.getAllByText("数据不足").length).toBeGreaterThan(0);
    expect(screen.queryByText(/50\.00 M/)).not.toBeInTheDocument();
    expect(screen.queryByText(/92\.50 M/)).not.toBeInTheDocument();
  });

  it("月费缺失时 Token 列与等效成本仍显示，不再整行隐藏", () => {
    render(<ValueRealizationSection analysis={tokenOnlyAnalysis()} month="2026-09" />);
    // 智谱 9 月无付款流水（monthlyCash=0.00）：Token 与等效 API 成本仍按真实数据展示
    expect(screen.getByText(/444\.62 M/)).toBeInTheDocument();
    expect(screen.getByText("¥ 6,669.30")).toBeInTheDocument();
    // 价格相关单元格（摊薄单价/降本/折扣）显示数据不足
    expect(screen.getAllByText("数据不足").length).toBeGreaterThan(0);
  });

  it("当月无付款流水时取覆盖当月的生效订阅固定费，并标注口径", () => {
    useProvidersMock.mockReturnValue({
      data: { providers: [{ id: "prov-z", code: "zhipu", name: "智谱" }] },
    });
    useProviderResourcesMock.mockReturnValue({
      data: { resources: [{ id: "res-z", provider_id: "prov-z", mode: "CODING_PLAN" }] },
    });
    useProviderSubscriptionPeriodsMock.mockImplementation((resourceId: string | null) =>
      resourceId === "res-z"
        ? {
            data: {
              periods: [
                {
                  id: "p1",
                  provider_resource_id: "res-z",
                  product_name: "智谱 Coding Plan",
                  period_start: "2026-08-19T00:00:00+08:00",
                  period_end_exclusive: "2026-10-19T00:00:00+08:00",
                  source: "ADMIN",
                  current_status: "ACTIVE",
                  fixed_fee_amount: "422.10",
                  fixed_fee_currency: "CNY",
                  fixed_cash_paid_cny: null,
                  token_usage: {
                    request_count: "0",
                    input_tokens: "0",
                    output_tokens: "0",
                    cache_tokens: "0",
                    reasoning_tokens: "0",
                    true_tokens: "0",
                  },
                },
              ],
            },
          }
        : { data: { periods: [] } },
    );

    render(<ValueRealizationSection analysis={tokenOnlyAnalysis()} month="2026-09" />);
    // 智谱行月费取订阅固定费并带 * 标注（账号复用表与摊薄表各一处）
    expect(screen.getAllByText("¥ 422.10*")).toHaveLength(2);
    // 汇总恢复可算：0.7 折
    expect(screen.getAllByText(/0\.7 折/).length).toBeGreaterThan(0);
    // 页脚标注订阅口径
    expect(screen.getByText(/生效订阅固定费/)).toBeInTheDocument();
  });

  it("subscriptionFeeForMonth：仅取覆盖当月且未冲销的订阅", () => {
    expect(subscriptionFeeForMonth(undefined, "2026-09")).toBeNull();
    expect(subscriptionFeeForMonth([], "2026-09")).toBeNull();
    const base = {
      id: "p",
      provider_resource_id: "r",
      product_name: "x",
      source: "ADMIN",
      fixed_fee_currency: "CNY" as const,
      fixed_cash_paid_cny: null,
      token_usage: {
        request_count: "0",
        input_tokens: "0",
        output_tokens: "0",
        cache_tokens: "0",
        reasoning_tokens: "0",
        true_tokens: "0",
      },
    };
    // 不覆盖 9 月
    expect(
      subscriptionFeeForMonth(
        [{ ...base, period_start: "2026-07-01T00:00:00+08:00", period_end_exclusive: "2026-08-01T00:00:00+08:00", current_status: "EXPIRED", fixed_fee_amount: "100" }],
        "2026-09",
      ),
    ).toBeNull();
    // 覆盖 9 月但已冲销
    expect(
      subscriptionFeeForMonth(
        [{ ...base, period_start: "2026-09-01T00:00:00+08:00", period_end_exclusive: "2026-10-01T00:00:00+08:00", current_status: "REVERSED", fixed_fee_amount: "100" }],
        "2026-09",
      ),
    ).toBeNull();
    // 覆盖 9 月的生效订阅
    expect(
      subscriptionFeeForMonth(
        [{ ...base, period_start: "2026-08-19T00:00:00+08:00", period_end_exclusive: "2026-09-19T00:00:00+08:00", current_status: "ACTIVE", fixed_fee_amount: "199" }],
        "2026-09",
      ),
    ).toBe(199);
  });
});
