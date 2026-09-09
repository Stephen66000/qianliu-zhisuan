/**
 * W18 数据获取 hooks —— TanStack Query 封装，三态（loading/error/success）由此驱动。
 *
 * 约定：401（UnauthorizedError）说明会话失效，由调用侧跳 /login；
 * 其余错误进 ErrorState 并可重试。无界重试禁止（工程规则 §7），retry 收敛为 1 次。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post } from "./client";
import { useCatalogPath } from "./catalog-access";
import type {
  AccessConfiguration,
  AlertsResult,
  AgentUsageResult,
  AttemptsResult,
  BillingRulesResult,
  DashboardSummary,
  DispatchDecisionItem,
  DispatchPoliciesResult,
  DeploymentLogDetail,
  DeploymentLogsResult,
  DeploymentStatus,
  GatewayRequestDetail,
  GrantsResult,
  ModelRoutesResult,
  OperationLogsResult,
  PrincipalsResult,
  PrincipalKeysResult,
  ProviderQuotaWindowsResult,
  ProviderResourcesResult,
  ProvidersResult,
  ResourceHealth,
  ResourceUsageOverview,
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
  accessConfiguration: (principalId: string) => ["principals", principalId, "access-configuration"] as const,
  providerResources: ["provider-resources"] as const,
  quotaWindows: (resourceId: string) =>
    ["provider-resources", resourceId, "quota-windows"] as const,
  resourceHealth: (resourceId: string) =>
    ["provider-resources", resourceId, "health"] as const,
  resourceUsageOverview: ["provider-resources", "usage-overview"] as const,
  providers: ["providers"] as const,
  unifiedModels: ["unified-models"] as const,
  grants: (principalId: string) => ["principals", principalId, "grants"] as const,
  principalKeys: (principalId: string) => ["principals", principalId, "keys"] as const,
  principalAgentUsage: (principalId: string) => ["principals", principalId, "agent-usage"] as const,
  modelRoutes: (modelId: string) => ["unified-models", modelId, "routes"] as const,
  gatewayRequest: (id: string) => ["gateway-requests", id] as const,
  alerts: ["alerts"] as const,
  operationLogs: ["operation-logs"] as const,
  deploymentLogs: ["deployment-logs"] as const,
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

export function usePrincipals(
  archived: "exclude" | "only" | "all" = "exclude",
  status?: "ACTIVE" | "DISABLED",
) {
  const query = new URLSearchParams({ archived });
  if (status) query.set("status", status);
  const path = useCatalogPath("principals", `/principals?${query}`);
  return useQuery({
    queryKey: [...QUERY_KEYS.principals, archived, status ?? "all-statuses", path],
    queryFn: ({ signal }) =>
      get<PrincipalsResult>(path, signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useProviderResources() {
  const path = useCatalogPath("resources", "/provider-resources");
  return useQuery({
    queryKey: [...QUERY_KEYS.providerResources, path],
    queryFn: ({ signal }) => get<ProviderResourcesResult>(path, signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useResourceUsageOverview() {
  return useQuery({
    queryKey: QUERY_KEYS.resourceUsageOverview,
    queryFn: ({ signal }) =>
      get<ResourceUsageOverview>("/provider-resources/usage-overview", signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useProviders() {
  const path = useCatalogPath("providers", "/providers");
  return useQuery({
    queryKey: [...QUERY_KEYS.providers, path],
    queryFn: ({ signal }) => get<ProvidersResult>(path, signal),
    retry: 1,
    staleTime: 30_000,
  });
}

/** POOL-032：厂商 Coding Plan 额度窗口快照（按资源）。 */
export function useQuotaWindows(resourceId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.quotaWindows(resourceId ?? ""),
    queryFn: ({ signal }) =>
      get<ProviderQuotaWindowsResult>(`/provider-resources/${resourceId}/quota-windows`, signal),
    enabled: resourceId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

/** POOL-032：管理员手动触发厂商额度同步。失败保鲜由后端处理；成功后刷新资源列表与窗口。 */
export function useSyncQuotaWindow(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post<ProviderQuotaWindowsResult>(`/provider-resources/${resourceId}/quota-sync`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.quotaWindows(resourceId) });
    },
  });
}

/** POOL-031：资源健康详情（服务端聚合原因/可用性/调度影响/恢复说明）。 */
export function useResourceHealth(resourceId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.resourceHealth(resourceId ?? ""),
    queryFn: ({ signal }) =>
      get<ResourceHealth>(`/provider-resources/${resourceId}/health`, signal),
    enabled: resourceId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

export function useUnifiedModels(archived: "exclude" | "only" | "all" = "exclude") {
  const path = useCatalogPath("models", `/unified-models?archived=${archived}`);
  return useQuery({
    queryKey: [...QUERY_KEYS.unifiedModels, archived, path],
    queryFn: ({ signal }) => get<UnifiedModelsResult>(path, signal),
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

export function usePrincipalKeys(principalId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.principalKeys(principalId ?? ""),
    queryFn: ({ signal }) =>
      get<PrincipalKeysResult>(`/principals/${principalId}/key`, signal),
    enabled: principalId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

/** POOL-033：单主体接入配置（厂商池）读模型。 */
export function useAccessConfiguration(principalId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.accessConfiguration(principalId ?? ""),
    queryFn: ({ signal }) =>
      get<AccessConfiguration>(`/principals/${principalId}/access-configuration`, signal),
    enabled: principalId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

export function useModelRoutes(
  modelId: string | null,
  archived: "exclude" | "only" | "all" = "exclude",
) {
  return useQuery({
    queryKey: [...QUERY_KEYS.modelRoutes(modelId ?? ""), archived],
    queryFn: ({ signal }) =>
      get<ModelRoutesResult>(`/unified-models/${modelId}/routes?archived=${archived}`, signal),
    enabled: modelId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

export function usePricingReadyRoutes() {
  return useQuery({ queryKey: ["pricing-ready-routes"],
    queryFn: ({ signal }) => get<{ routes: Array<{ id: string; alias: string; provider_resource_id: string; mode: string; upstream_model: string }> }>("/pricing-ready-routes", signal),
    staleTime: 0, retry: 1 });
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
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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

export function useDeploymentLogs(params: {
  status?: DeploymentStatus;
  version?: string;
  poolRef?: string;
} = {}) {
  const search = new URLSearchParams({ limit: "100", offset: "0" });
  if (params.status) search.set("status", params.status);
  if (params.version) search.set("version", params.version);
  if (params.poolRef) search.set("pool_ref", params.poolRef);
  return useQuery({
    queryKey: [...QUERY_KEYS.deploymentLogs, params],
    queryFn: ({ signal }) => get<DeploymentLogsResult>(`/deployment-logs?${search}`, signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useDeploymentLog(id: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEYS.deploymentLogs, id],
    queryFn: ({ signal }) => get<DeploymentLogDetail>(`/deployment-logs/${id}`, signal),
    enabled: id !== null,
    retry: 1,
    staleTime: 30_000,
  });
}
