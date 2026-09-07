import { useQuery } from "@tanstack/react-query";

import { get } from "./client";
import { shanghaiMonthBounds } from "./provider-finance";
import type { ProviderFinanceEvent } from "./provider-finance-types";

const paymentTypes = new Set([
  "API_RECHARGE",
  "CODING_PLAN_PURCHASE",
  "CODING_PLAN_RENEWAL",
  "REVERSAL",
]);

export async function loadOperatingBillPayments(
  month: string,
  resourceIds: string[],
  signal?: AbortSignal,
) {
  const bounds = shanghaiMonthBounds(month);
  const results = await Promise.all(
    [...new Set(resourceIds)].sort().map(async (resourceId) => {
      const items: ProviderFinanceEvent[] = [];
      let offset = 0;
      while (true) {
        const query = new URLSearchParams({
          ...bounds,
          limit: "100",
          offset: String(offset),
        });
        const page = await get<{
          items: ProviderFinanceEvent[];
          total: number;
        }>(`/provider-resources/${resourceId}/finance/events?${query}`, signal);
        items.push(...page.items);
        offset += page.items.length;
        if (offset >= page.total) break;
        if (page.items.length === 0)
          throw new Error("实付流水未读取完整，请重试");
      }
      return items;
    }),
  );
  return [...new Map(results.flat().map((item) => [item.id, item])).values()]
    .filter(
      (item) =>
        paymentTypes.has(item.eventType) &&
        item.cashPaidCny !== null &&
        Number.isFinite(Number(item.cashPaidCny)) &&
        Number(item.cashPaidCny) !== 0,
    )
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
    );
}

export function useOperatingBillPayments(
  month: string,
  resourceIds: string[],
  enabled = true,
) {
  const stableIds = [...new Set(resourceIds)].sort();
  return useQuery({
    queryKey: ["provider-finance", "operating-bill-payments", month, stableIds],
    queryFn: ({ signal }) =>
      loadOperatingBillPayments(month, stableIds, signal),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
