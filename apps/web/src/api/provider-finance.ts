import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post } from "./client";
import type {
  FinanceCurrency,
  ProviderFinanceBalance,
  ProviderFinanceEvent,
  ProviderFinanceSummary,
  ProviderSubscriptionPeriod,
} from "./types";

export const FINANCE_QUERY_KEYS = {
  summary: (month: string) => ["provider-finance", "summary", month] as const,
  balance: (resourceId: string, currency: FinanceCurrency) =>
    ["provider-finance", "balance", resourceId, currency] as const,
  events: (resourceId: string, month: string) =>
    ["provider-finance", "events", resourceId, month] as const,
  periods: (resourceId: string) => ["provider-finance", "periods", resourceId] as const,
};

export function currentShanghaiMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
}

export function shanghaiMonthBounds(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year!, monthNumber! - 1, 1) - 8 * 3600_000).toISOString(),
    to: new Date(Date.UTC(year!, monthNumber!, 1) - 8 * 3600_000).toISOString(),
  };
}

export function useProviderFinanceSummary(month: string, enabled = true) {
  return useQuery({ queryKey: FINANCE_QUERY_KEYS.summary(month),
    queryFn: ({ signal }) => get<ProviderFinanceSummary>(`/provider-finance/summary?month=${month}`, signal),
    enabled, staleTime: 15_000, retry: 1 });
}

export function useProviderFinanceBalance(
  resourceId: string | null, currency: FinanceCurrency, enabled = true,
) {
  return useQuery({ queryKey: FINANCE_QUERY_KEYS.balance(resourceId ?? "", currency),
    queryFn: ({ signal }) => get<ProviderFinanceBalance>(
      `/provider-resources/${resourceId}/finance/balance?currency=${currency}`, signal,
    ), enabled: enabled && resourceId !== null, staleTime: 15_000, retry: 1 });
}

export function useProviderFinanceEvents(resourceId: string | null, month: string, enabled = true) {
  const bounds = shanghaiMonthBounds(month);
  const query = new URLSearchParams({ from: bounds.from, to: bounds.to, limit: "100" });
  return useQuery({ queryKey: FINANCE_QUERY_KEYS.events(resourceId ?? "", month),
    queryFn: ({ signal }) => get<{ items: ProviderFinanceEvent[]; total: number }>(
      `/provider-resources/${resourceId}/finance/events?${query}`, signal,
    ), enabled: enabled && resourceId !== null, staleTime: 15_000, retry: 1 });
}

export function useProviderSubscriptionPeriods(resourceId: string | null, enabled = true) {
  return useQuery({ queryKey: FINANCE_QUERY_KEYS.periods(resourceId ?? ""),
    queryFn: ({ signal }) => get<{ periods: ProviderSubscriptionPeriod[] }>(
      `/provider-resources/${resourceId}/subscription-periods`, signal,
    ), enabled: enabled && resourceId !== null, staleTime: 15_000, retry: 1 });
}

export function useRecordProviderFinance(resourceId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: "API" | "CODING_PLAN"; payload: Record<string, unknown> }) => {
      if (!resourceId) throw new Error("请选择厂商资源");
      return input.kind === "API"
        ? post(`/provider-resources/${resourceId}/finance/recharges`, input.payload)
        : post(`/provider-resources/${resourceId}/finance/subscriptions`, input.payload);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["provider-finance"] });
      void client.invalidateQueries({ queryKey: ["operating-bill"] });
      void client.invalidateQueries({ queryKey: ["operating-analysis"] });
      void client.invalidateQueries({
        predicate: (query) =>
          String(query.queryKey[0]).startsWith("operating-bill-"),
      });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["provider-resources"] });
    },
  });
}

export function useConfirmProviderFinanceDuplicate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidateId: string; confirmationToken: string;
      requestHash: string; idempotencyKey: string }) => post(
      `/provider-finance-duplicate-candidates/${input.candidateId}/confirm`, {
        confirmation_token: input.confirmationToken,
        request_hash: input.requestHash,
        idempotency_key: input.idempotencyKey,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["provider-finance"] });
      void client.invalidateQueries({ queryKey: ["operating-bill"] });
      void client.invalidateQueries({ queryKey: ["operating-analysis"] });
      void client.invalidateQueries({
        predicate: (query) =>
          String(query.queryKey[0]).startsWith("operating-bill-"),
      });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["provider-resources"] });
    },
  });
}
