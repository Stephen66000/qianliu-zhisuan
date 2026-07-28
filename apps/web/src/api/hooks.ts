/**
 * W18 数据获取 hooks —— TanStack Query 封装，三态（loading/error/success）由此驱动。
 *
 * 约定：401（UnauthorizedError）说明会话失效，由调用侧跳 /login；
 * 其余错误进 ErrorState 并可重试。无界重试禁止（工程规则 §7），retry 收敛为 1 次。
 */
import { useQuery } from "@tanstack/react-query";

import { get } from "./client";
import type {
  AlertsResult,
  AttemptsResult,
  BillingRulesResult,
  DashboardSummary,
  DispatchDecisionItem,
  DispatchPoliciesResult,
  GatewayRequestDetail,
  GrantsResult,
  OperationLogsResult,
  PrincipalsResult,
  ProviderResourcesResult,
  RouteCandidateItem,
  SupplyForecastsResult,
  UnifiedModelsResult,
  UsageQueryParams,
  UsageResult,
} from "./types";

export const QUERY_KEYS = {
  dashboard: ["dashboard"] as const,
  usage: (params: UsageQueryParams) => ["usage", params] as const,
  billingRules: ["billing-rules"] as const,
  dispatchPolicies: ["dispatch-policies"] as const,
  supplyForecasts: ["supply-forecasts"] as const,
  principals: ["principals"] as const,
  providerResources: ["provider-resources"] as const,
  unifiedModels: ["unified-models"] as const,
  grants: (principalId: string) => ["principals", principalId, "grants"] as const,
  gatewayRequest: (id: string) => ["gateway-requests", id] as const,
  alerts: ["alerts"] as const,
  operationLogs: ["operation-logs"] as const,
} as const;

export function useDashboard() {
  return useQuery({
    queryKey: QUERY_KEYS.dashboard,
    queryFn: ({ signal }) => get<DashboardSummary>("/dashboard", signal),
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
      if (params.principal_id) search.set("principal_id", params.principal_id);
      if (params.client_id) search.set("client_id", params.client_id);
      if (params.unified_model) search.set("unified_model", params.unified_model);
      if (params.status) search.set("status", params.status);
      if (params.from) search.set("from", params.from);
      if (params.to) search.set("to", params.to);
      const qs = search.toString();
      return get<UsageResult>(qs ? `/usage?${qs}` : "/usage", signal);
    },
    retry: 1,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}

export function useBillingRules() {
  return useQuery({
    queryKey: QUERY_KEYS.billingRules,
    queryFn: ({ signal }) => get<BillingRulesResult>("/billing-rules", signal),
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

export function useSupplyForecasts() {
  return useQuery({
    queryKey: QUERY_KEYS.supplyForecasts,
    queryFn: ({ signal }) => get<SupplyForecastsResult>("/supply-forecasts", signal),
    retry: 1,
    staleTime: 60_000,
  });
}

export function usePrincipals() {
  return useQuery({
    queryKey: QUERY_KEYS.principals,
    queryFn: ({ signal }) => get<PrincipalsResult>("/principals", signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useProviderResources() {
  return useQuery({
    queryKey: QUERY_KEYS.providerResources,
    queryFn: ({ signal }) => get<ProviderResourcesResult>("/provider-resources", signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useUnifiedModels() {
  return useQuery({
    queryKey: QUERY_KEYS.unifiedModels,
    queryFn: ({ signal }) => get<UnifiedModelsResult>("/unified-models", signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useGrants(principalId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.grants(principalId ?? ""),
    queryFn: ({ signal }) => get<GrantsResult>(`/principals/${principalId}/grants`, signal),
    enabled: principalId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

// ---------- W20 诊断下钻 ----------

export function useGatewayRequest(requestId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.gatewayRequest(requestId ?? ""),
    queryFn: ({ signal }) => get<GatewayRequestDetail>(`/gateway-requests/${requestId}`, signal),
    enabled: requestId !== null,
    retry: 1,
    staleTime: 60_000,
  });
}

export function useRouteCandidates(requestId: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEYS.gatewayRequest(requestId ?? ""), "route-candidates"],
    queryFn: ({ signal }) =>
      get<{ candidates: RouteCandidateItem[] }>(
        `/gateway-requests/${requestId}/route-candidates`,
        signal,
      ),
    enabled: requestId !== null,
    retry: 1,
    staleTime: 60_000,
  });
}

export function useAttempts(requestId: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEYS.gatewayRequest(requestId ?? ""), "attempts"],
    queryFn: ({ signal }) =>
      get<AttemptsResult>(`/gateway-requests/${requestId}/attempts`, signal),
    enabled: requestId !== null,
    retry: 1,
    staleTime: 60_000,
  });
}

export function useDispatchDecision(requestId: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEYS.gatewayRequest(requestId ?? ""), "dispatch-decision"],
    queryFn: ({ signal }) =>
      get<{ decision: DispatchDecisionItem | null }>(
        `/gateway-requests/${requestId}/dispatch-decision`,
        signal,
      ),
    enabled: requestId !== null,
    retry: 1,
    staleTime: 60_000,
  });
}

// ---------- W20 告警 + 操作日志 ----------

export function useAlerts(history = false) {
  return useQuery({
    queryKey: [...QUERY_KEYS.alerts, history],
    queryFn: ({ signal }) =>
      get<AlertsResult>(history ? "/alerts?history=true" : "/alerts", signal),
    retry: 1,
    staleTime: 15_000,
  });
}

export function useOperationLogs(limit = 100) {
  return useQuery({
    queryKey: [...QUERY_KEYS.operationLogs, limit],
    queryFn: ({ signal }) => get<OperationLogsResult>(`/operation-logs?limit=${limit}`, signal),
    retry: 1,
    staleTime: 30_000,
  });
}
