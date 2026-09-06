import { useQuery } from "@tanstack/react-query";
import { get } from "./client";

export interface AnalysisUsageMonth {
  month: string;
  totalTokens: string | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheTokens: string | null;
  employeeTokens: string | null;
  projectTokens: string | null;
  employeeCount: number | null;
  activeEmployees: number | null;
  perCapitaTokens: string | null;
}
export interface AnalysisPayment {
  id: string;
  providerResourceId: string;
  providerName: string;
  resourceName: string;
  eventType: string;
  cashPaidCny: string;
  occurredAt: string;
  externalReference: string | null;
  description: string | null;
}
export interface OperatingAnalysis {
  payments: AnalysisPayment[];
  cashSummary: {
    monthlyCash: Array<string | null>;
    yearCash: string;
    averageCash: string | null;
    highestMonths: string[];
  };
  month: string;
  currentMonth: string;
  generatedAt: string;
  months: AnalysisUsageMonth[];
  summary: {
    companyTokens: string | null;
    ytdAverageTokens: string | null;
    ytdAverageChange: string | null;
    perCapitaTokens: string | null;
    perCapitaChange: string | null;
    planUtilization: string | null;
  };
  plans: Array<{
    providerCode: string;
    providerName: string;
    peakTokens: string;
    months: Array<{
      month: string;
      totalTokens: string | null;
      inputTokens: string | null;
      outputTokens: string | null;
      utilization: string | null;
    }>;
  }>;
  purchases: Array<{
    providerCode: string;
    providerName: string;
    mode: "API" | "CODING_PLAN";
    monthlyCash: Array<string | null>;
    yearCash: string;
  }>;
  apiAccounts: Array<{
    providerCode: string;
    providerName: string;
    currency: string;
    totals: {
      openingBalance: string | null;
      recharge: string | null;
      paidCny: string | null;
      apiSpend: string | null;
      endingBalance: string | null;
    };
    months: Array<{
      month: string;
      openingBalance: string | null;
      recharge: string | null;
      paidCny: string | null;
      apiSpend: string | null;
      endingBalance: string | null;
    }>;
  }>;
}
export const OPERATING_REFRESH_MS = 30_000;
export function useOperatingAnalysis(month: string, enabled = true) {
  return useQuery({
    queryKey: ["operating-analysis", month],
    queryFn: ({ signal }) =>
      get<OperatingAnalysis>(`/operating-bills/${month}/analysis`, signal),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: OPERATING_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
