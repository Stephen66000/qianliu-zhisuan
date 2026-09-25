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

/**
 * 资金事实变化后的统一缓存刷新（PFU-04 Scenario: Activation succeeds）。
 *
 * 资金事实会影响厂商资源、资金摘要/余额/周期、经营账单（含各分页前缀）、
 * 经营分析、首页聚合，以及资源利用/采购/采购复核视图，因此这里集中一处失效，
 * 避免调用点各自漏刷一个命名空间。
 * 初始化激活（`provider-finance-activation.ts`）与日常入账共用本函数。
 * 注意按命名空间前缀失效（不带月份），因为激活会影响所有月份的利用/采购视图。
 */
export function invalidateProviderFinanceCaches(client: {
  invalidateQueries: (filters: {
    queryKey?: readonly unknown[];
    predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
  }) => Promise<unknown>;
}): void {
  void client.invalidateQueries({ queryKey: ["provider-finance"] });
  void client.invalidateQueries({ queryKey: ["provider-resources"] });
  void client.invalidateQueries({ queryKey: ["operating-bill"] });
  void client.invalidateQueries({ queryKey: ["operating-analysis"] });
  void client.invalidateQueries({
    predicate: (query) => String(query.queryKey[0]).startsWith("operating-bill-"),
  });
  void client.invalidateQueries({ queryKey: ["dashboard"] });
  void client.invalidateQueries({ queryKey: ["resource-utilization"] });
  void client.invalidateQueries({ queryKey: ["resource-purchases"] });
  void client.invalidateQueries({ queryKey: ["procurement-review"] });
}

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
    enabled, staleTime: 15_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: 1 });
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
    ), enabled: enabled && resourceId !== null, staleTime: 15_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: 1 });
}

export function useProviderSubscriptionPeriods(resourceId: string | null, enabled = true) {
  return useQuery({ queryKey: FINANCE_QUERY_KEYS.periods(resourceId ?? ""),
    queryFn: ({ signal }) => get<{ periods: ProviderSubscriptionPeriod[] }>(
      `/provider-resources/${resourceId}/subscription-periods`, signal,
    ), enabled: enabled && resourceId !== null, staleTime: 15_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: 1 });
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
    onSuccess: () => invalidateProviderFinanceCaches(client),
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
    onSuccess: () => invalidateProviderFinanceCaches(client),
  });
}
