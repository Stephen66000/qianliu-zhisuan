import type { OperatingAnalysis } from "../api/operating-analysis";
export const analysisFixture: OperatingAnalysis = {
  payments: [],
  month: "2026-08",
  currentMonth: "2026-08",
  generatedAt: "2026-08-31T12:00:00Z",
  summary: {
    companyTokens: "100000000",
    ytdAverageTokens: "22500000",
    ytdAverageChange: "96.88",
    perCapitaTokens: "50000000",
    perCapitaChange: "25",
    planUtilization: "75",
  },
  months: Array.from({ length: 12 }, (_, i) => {
    const total = i === 6 ? 80000000 : i === 7 ? 100000000 : 0;
    return {
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      totalTokens: i > 7 ? null : String(total),
      inputTokens: String(total),
      outputTokens: "0",
      cacheTokens: "0",
      employeeTokens: String(total * 0.8),
      projectTokens: String(total * 0.2),
      employeeCount: i > 7 ? null : 2,
      activeEmployees: i > 7 ? null : total ? 2 : 0,
      perCapitaTokens: i > 7 ? null : String(total / 2),
    };
  }),
  plans: ["kimi", "zhipu"].map((code) => ({
    providerCode: code,
    providerName: code === "kimi" ? "Kimi" : "智谱",
    peakTokens: code === "kimi" ? "1000" : "2000",
    months: Array.from({ length: 12 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      totalTokens:
        i > 7
          ? null
          : i === 7
            ? "1000"
            : i === 6
              ? code === "kimi"
                ? "500"
                : "2000"
              : "0",
      inputTokens: i === 7 ? "900" : "0",
      outputTokens: i === 7 ? "100" : "0",
      utilization:
        i > 7 ? null : i === 7 ? (code === "kimi" ? "100" : "50") : "0",
    })),
  })),
  purchases: [
    ["deepseek", "DeepSeek", "API", "15"],
    ["kimi", "Kimi", "CODING_PLAN", "199"],
    ["zhipu", "智谱", "CODING_PLAN", "99"],
  ].map(([code, name, mode, value]) => ({
    providerCode: code!,
    providerName: name!,
    mode: mode as "API" | "CODING_PLAN",
    monthlyCash: Array.from({ length: 12 }, (_, i) =>
      i > 7 ? null : i === 7 ? value! : "0",
    ),
    yearCash: value!,
  })),
  cashSummary: {
    monthlyCash: Array.from({ length: 12 }, (_, i) =>
      i > 7 ? null : i === 7 ? "313" : "0",
    ),
    yearCash: "313",
    averageCash: "39.13",
    highestMonths: ["2026-08"],
  },
  apiAccounts: [
    {
      providerCode: "deepseek",
      providerName: "DeepSeek",
      currency: "CNY",
      totals: {
        openingBalance: null,
        recharge: null,
        paidCny: "15",
        apiSpend: null,
        endingBalance: "25",
      },
      months: Array.from({ length: 12 }, (_, i) => ({
        month: `2026-${String(i + 1).padStart(2, "0")}`,
        openingBalance: i === 7 ? "10" : null,
        recharge: i === 7 ? "20" : null,
        paidCny: i === 7 ? "15" : null,
        apiSpend: i === 7 ? "5" : null,
        endingBalance: i === 7 ? "25" : null,
      })),
    },
  ],
};
