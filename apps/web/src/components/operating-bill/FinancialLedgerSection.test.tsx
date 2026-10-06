import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import {
  buildFinancialLedgerModel,
  financialLedgerCsv,
  FinancialLedgerSection,
} from "./FinancialLedgerSection";

const monthNames = Array.from({ length: 12 }, (_, index) =>
  `2026-${String(index + 1).padStart(2, "0")}`,
);

function analysisFixture(): OperatingAnalysis {
  const usageMonths = monthNames.map((month, index) => ({
    month, totalTokens: index === 8 ? "500000000" : "0",
    inputTokens: index === 8 ? "300000000" : "0",
    outputTokens: index === 8 ? "200000000" : "0",
    cacheTokens: "0", employeeTokens: index === 8 ? "500000000" : "0",
    projectTokens: "0", employeeCount: index === 8 ? 5 : 0,
    activeEmployees: index === 8 ? 5 : 0,
    perCapitaTokens: index === 8 ? "100000000" : null,
  }));
  const emptyAccountMonth = (month: string) => ({ month, openingBalance: null,
    recharge: null, paidCny: null, apiSpend: null, apiSpendComplete: false,
    endingBalance: null });
  return {
    month: "2026-09", currentMonth: "2026-09", generatedAt: "2026-09-27T12:00:00.000Z",
    months: usageMonths,
    payments: [],
    cashSummary: {
      monthlyCash: monthNames.map((_, index) => index === 8 ? "1221.10" : "0.00"),
      yearCash: "1221.10", averageCash: "1221.10", highestMonths: ["2026-09"],
    },
    summary: { companyTokens: "500000000", ytdAverageTokens: "500000000",
      ytdAverageChange: null, perCapitaTokens: "100000000", perCapitaChange: null,
      planUtilization: null },
    plans: [],
    purchases: [{ providerCode: "zhipu", providerName: "智谱", mode: "CODING_PLAN",
      monthlyCash: monthNames.map((_, index) => index === 8 ? "621.10" : "0.00"),
      yearCash: "621.10" }],
    apiAccounts: [{ providerCode: "deepseek", providerName: "DeepSeek", currency: "CNY",
      totals: { openingBalance: "0.00", recharge: "600.00", paidCny: "600.00",
        apiSpend: "104.55405484", apiSpendComplete: true, endingBalance: "495.44594516" },
      months: monthNames.map((month, index) => index === 8 ? {
        month, openingBalance: "0.00", recharge: "600.00", paidCny: "600.00",
        apiSpend: "104.55405484", apiSpendComplete: true, endingBalance: "495.44594516",
      } : emptyAccountMonth(month)) }],
    officialApiBalances: [{ providerCode: "deepseek", providerName: "DeepSeek",
      providerResourceId: "deepseek-resource", resourceName: "DeepSeek", currency: "CNY",
      balance: "356.61", asOf: "2026-09-27T00:00:22.667+08:00",
      syncedAt: "2026-09-27T00:00:22.667+08:00" }],
  };
}

describe("FinancialLedgerSection 财务账", () => {
  it("只展示真实分析数据，并区分官方余额与内部账本余额", () => {
    const analysis = analysisFixture();
    const model = buildFinancialLedgerModel(analysis);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ month: "2026-09", planPaid: "621.10000000",
      apiRecharge: "600.00000000", apiSpend: "104.55405484",
      usageSpendTotal: "725.65405484", endingBalance: "495.44594516" });
    expect(model.totals.cashOutTotal).toBe("1221.10");

    render(<FinancialLedgerSection analysis={analysis} />);
    expect(screen.getByText("官方账户可用余额")).toBeInTheDocument();
    expect(screen.getByText("CNY 356.61")).toBeInTheDocument();
    expect(screen.getByText("实际可用资金以厂商官方余额为准")).toBeInTheDocument();
    expect(screen.getByText("仟流内部账本余额")).toBeInTheDocument();
    expect(screen.getAllByText("¥ 725.65").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥ 104.55").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥ 621.10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥ 1,221.10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥ 495.45").length).toBeGreaterThan(0);
    expect(screen.getByText("2026-09")).toBeInTheDocument();
    expect(screen.queryByText("2026-08")).toBeNull();
    for (const stale of ["¥ 120.49", "¥ 200.00", "¥ 47.41", "¥ 32.10"]) {
      expect(screen.queryByText(stale)).toBeNull();
    }
  });

  it("CSV 与页面共用同一真实模型", () => {
    const csv = financialLedgerCsv(buildFinancialLedgerModel(analysisFixture()));
    expect(csv).toContain("2026-09,621.10000000,600.00000000,1221.10,104.55405484");
    expect(csv).toContain("725.65405484");
    expect(csv).toContain("495.44594516,CNY");
    expect(csv).not.toContain("120.49");
  });

  it("多币种余额不混加", () => {
    const analysis = analysisFixture();
    analysis.apiAccounts.push({ ...analysis.apiAccounts[0]!, currency: "USD",
      totals: { ...analysis.apiAccounts[0]!.totals, endingBalance: "9.00" },
      months: analysis.apiAccounts[0]!.months.map((month) => month.month === "2026-09"
        ? { ...month, recharge: "10.00", paidCny: "70.00", apiSpend: "1.00",
          endingBalance: "9.00" } : month) });
    const model = buildFinancialLedgerModel(analysis);
    expect(model.rows[0]).toMatchObject({ multiCurrency: true, apiSpend: null,
      endingBalance: null });
    render(<FinancialLedgerSection analysis={analysis} />);
    expect(screen.getAllByText("多币种（不合并）").length).toBeGreaterThan(0);
  });

  it("F-020：原币 USD 的 API 消耗不与人民币套餐费合并为用量总花费", () => {
    const analysis = analysisFixture();
    const usdAccount = analysis.apiAccounts[0]!;
    analysis.apiAccounts = [{ ...usdAccount, currency: "USD",
      totals: { ...usdAccount.totals, apiSpend: "14.70000000", endingBalance: "80.00" },
      months: usdAccount.months.map((month) => month.month === "2026-09"
        ? { ...month, apiSpend: "14.70000000", apiSpendComplete: true, endingBalance: "80.00" }
        : month) }];
    const model = buildFinancialLedgerModel(analysis);
    expect(model.rows[0]).toMatchObject({ apiCurrency: "USD", apiSpend: "14.70000000",
      usageSpendTotal: null, costPerMillion: null });
    expect(model.totals.usageSpendTotal).toBeNull();

    render(<FinancialLedgerSection analysis={analysis} />);
    expect(screen.getAllByText("USD 14.70").length).toBeGreaterThan(0);
    expect(screen.queryByText("¥ 635.80")).toBeNull();

    const csv = financialLedgerCsv(model);
    expect(csv).toContain("14.70000000");
    expect(csv).not.toContain("635.80");
  });

  it("F-020 补遗：美元账户的人民币充值恒按 ¥ 展示并计入现金合计", () => {
    const analysis = analysisFixture();
    const account = analysis.apiAccounts[0]!;
    analysis.apiAccounts = [{ ...account, currency: "USD" }];
    const model = buildFinancialLedgerModel(analysis);
    // paidCny=600 为人民币实付：不随账户币种（USD）标记，也不被多币种门禁清空。
    expect(model.rows[0]).toMatchObject({ apiCurrency: "USD", apiSpend: "104.55405484",
      apiRecharge: "600.00000000" });
    render(<FinancialLedgerSection analysis={analysis} />);
    expect(screen.getAllByText("¥ 600.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("USD 600.00")).toBeNull();
    const csv = financialLedgerCsv(model);
    expect(csv).toContain("API现金充值(¥)");
  });

  it("F-020 补遗：跨月不同币种的年度 API 消耗不合并（一月人民币二月美元）", () => {
    const analysis = analysisFixture();
    const cnyAccount = analysis.apiAccounts[0]!;
    analysis.apiAccounts = [
      { ...cnyAccount, months: cnyAccount.months.map((month) => month.month === "2026-09"
        ? month : { ...month }) },
      { ...cnyAccount, currency: "USD", months: cnyAccount.months.map((month) => month.month === "2026-08"
        ? { month: "2026-08", openingBalance: "0.00", recharge: "50.00", paidCny: "50.00",
          apiSpend: "12.00000000", apiSpendComplete: true, endingBalance: "38.00" }
        : month.month === "2026-09"
          ? { ...month, apiSpend: null, apiSpendComplete: false, openingBalance: null,
            recharge: null, paidCny: null, endingBalance: null }
          : month) },
    ];
    const model = buildFinancialLedgerModel(analysis);
    expect(model.rows).toHaveLength(2);
    const august = model.rows.find((row) => row.month === "2026-08")!;
    const september = model.rows.find((row) => row.month === "2026-09")!;
    expect(august).toMatchObject({ apiCurrency: "USD", apiSpend: "12.00000000" });
    expect(september).toMatchObject({ apiCurrency: "CNY", apiSpend: "104.55405484" });
    // 年度合计：币种集合 {USD, CNY} → 不可比，API 消耗与用量总花费不合并。
    expect(model.totals.apiCurrency).toBeNull();
    expect(model.totals.apiSpend).toBeNull();
    expect(model.totals.usageSpendTotal).toBeNull();
    // 人民币现金充值仍可合计。
    expect(model.totals.apiRecharge).toBe("650.00000000");

    render(<FinancialLedgerSection analysis={analysis} />);
    expect(screen.getByText("USD 12.00")).toBeInTheDocument();
    expect(screen.queryByText("CNY 116.55")).toBeNull();
    const csv = financialLedgerCsv(model);
    // 年度累计行的 API 消耗列为空（不静默相加）。
    const totalRow = csv.split("\n").find((line) => line.startsWith("年度累计"))!;
    const columns = totalRow.split(",");
    expect(columns[4]).toBe("");
  });
});
