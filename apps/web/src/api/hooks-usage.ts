/**
 * W18 用量与运营分析域 hooks —— dashboard / usage / 计费规则 / 调度策略 / 供给预测。
 * 错误与重试约定见 hooks.ts 总说明（本模块自 api/hooks.ts 按域拆出）。
 */
import { useQuery } from "@tanstack/react-query";

import { get } from "./client";
import { QUERY_KEYS } from "./hooks-query-keys";
import type {
  AgentUsageResult,
  BillingRulesResult,
  DashboardSummary,
  DispatchPoliciesResult,
  StandardHomeSummary,
  SupplyForecastsResult,
  UsageQueryParams,
  UsageResult,
} from "./types";

export function useDashboard() {
  return useQuery({
    queryKey: QUERY_KEYS.dashboard,
    queryFn: ({ signal }) => get<DashboardSummary>("/dashboard", signal),
    retry: 1,
    staleTime: 30_000,
  });
}

/** 标准版首页两分区聚合（HOME-STANDARD-20260910）。 */
export function useStandardHome() {
  return useQuery({
    queryKey: QUERY_KEYS.standardHome,
    queryFn: ({ signal }) => get<StandardHomeSummary>("/dashboard/home", signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useUsage(params: UsageQueryParams) {
  return useQuery({
    queryKey: QUERY_KEYS.usage(params),
    queryFn: ({ signal }) => {
      const search = new URLSearchParams();
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      if (params.offset !== undefined) search.set("offset", String(params.offset));
      if (params.search) search.set("search", params.search);
      if (params.principal_id) search.set("principal_id", params.principal_id);
      if (params.project_id) search.set("project_id", params.project_id);
      if (params.subject_type) search.set("subject_type", params.subject_type);
      if (params.client_id) search.set("client_id", params.client_id);
      if (params.agent_family) search.set("agent_family", params.agent_family);
      if (params.provider_id) search.set("provider_id", params.provider_id);
      if (params.provider_resource_id) {
        search.set("provider_resource_id", params.provider_resource_id);
      }
      if (params.unified_model) search.set("unified_model", params.unified_model);
      if (params.status) search.set("status", params.status);
      if (params.from) search.set("from", params.from);
      if (params.to) search.set("to", params.to);
      if (params.to_exclusive) search.set("to_exclusive", params.to_exclusive);
      if (params.overage_only) search.set("overage_only", "true");
      if (params.settled_only) search.set("settled_only", "true");
      const qs = search.toString();
      return get<UsageResult>(qs ? `/usage?${qs}` : "/usage", signal);
    },
    retry: 1,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}

export function usePrincipalAgentUsage(principalId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.principalAgentUsage(principalId),
    queryFn: ({ signal }) => get<AgentUsageResult>(`/principals/${principalId}/agent-usage`, signal),
    enabled: Boolean(principalId),
    retry: 1,
    staleTime: 15_000,
  });
}

export function useBillingRules(archived: "exclude" | "only" | "all" = "exclude") {
  return useQuery({
    queryKey: [...QUERY_KEYS.billingRules, archived],
    queryFn: ({ signal }) => get<BillingRulesResult>(`/billing-rules?archived=${archived}`, signal),
    retry: 1,
    staleTime: 60_000,
  });
}

export function useDispatchPolicies() {
  return useQuery({
    queryKey: QUERY_KEYS.dispatchPolicies,
    queryFn: ({ signal }) => get<DispatchPoliciesResult>("/dispatch-policies", signal),
    retry: 1,
    staleTime: 60_000,
  });
}

export function useSupplyForecasts(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.supplyForecasts,
    queryFn: ({ signal }) => get<SupplyForecastsResult>("/supply-forecasts", signal),
    retry: 1,
    staleTime: 60_000,
    enabled,
  });
}
