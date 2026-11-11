/**
 * W18 资源域 hooks —— 厂商资源列表 / 用量总览 / POOL-032 额度窗口与同步 /
 * OAB-03 官方余额手动刷新 / 资源健康 / 资源路由上下架（POOL-031 相关）。
 * 本模块自 api/hooks.ts 按域拆出；错误与重试约定见 hooks.ts 总说明。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCatalogPath } from "./catalog-access";
import { get, patch, post } from "./client";
import { QUERY_KEYS } from "./hooks-query-keys";
import type {
  OfficialBalanceRefreshResult,
  ProviderQuotaWindowsResult,
  ProviderResourcesResult,
  ResourceHealth,
  ResourceRouteItem,
  ResourceRoutesResult,
  ResourceUsageOverview,
  RetireResourceRouteResult,
  RestoreResourceRouteResult,
  UnifiedModelsResult,
} from "./types";

export function useProviderResources(archived?: "exclude" | "only" | "all") {
  const base = useCatalogPath("resources", "/provider-resources");
  const path = archived && archived !== "exclude" ? `${base}?archived=${archived}` : base;
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

/** WP3 C2 / OAB-03：管理员手动刷新官方余额。三态（ACCEPTED/IN_PROGRESS/COOLDOWN）由后端给出，
 * 冷却展示一律消费 official_balance.next_refresh_at（不前端推算 P1/P2/P3）；成功后刷新资源列表。 */
export function useRefreshOfficialBalance(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post<OfficialBalanceRefreshResult>(
        `/provider-resources/${resourceId}/official-balance/refresh`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
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

/** 查询指定资源挂载的模型路由列表。 */
export function useResourceRoutes(
  resourceId: string | null,
  archived: "exclude" | "only" | "all" = "exclude",
) {
  return useQuery({
    queryKey: [...QUERY_KEYS.resourceRoutes(resourceId ?? ""), archived],
    queryFn: ({ signal }) =>
      get<ResourceRoutesResult>(
        `/provider-resources/${resourceId}/routes?archived=${archived}`,
        signal,
      ),
    enabled: resourceId !== null,
    retry: 1,
    staleTime: 30_000,
  });
}

/** 一键下架指定资源的模型路由（原子归档路由、关联计价规则、撤销员工授权及孤儿统一模型）。 */
export function useRetireResourceRoute(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (routeId: string) =>
      post<RetireResourceRouteResult>(
        `/provider-resources/${resourceId}/routes/${routeId}/retire`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resourceRoutes(resourceId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.unifiedModels });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.billingRules });
      void queryClient.invalidateQueries({ queryKey: ["principals"] });
    },
  });
}

/** 恢复上架已下架的模型路由（恢复路由与统一模型；计价规则需重新配置）。 */
export function useRestoreResourceRoute(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (routeId: string) =>
      post<RestoreResourceRouteResult>(
        `/provider-resources/${resourceId}/routes/${routeId}/restore`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resourceRoutes(resourceId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.unifiedModels });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.billingRules });
    },
  });
}

/** 启用未在服务的模型路由：先启用路由（未通过真实验证会被 409 拒绝且不产生副作用），成功后再把统一模型置为 ACTIVE（F-099）。 */
export function useEnableResourceRoute(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (route: ResourceRouteItem) => {
      await patch(`/model-routes/${route.id}`, {
        expected_version: route.version,
        enabled: true,
      });
      const models = await get<UnifiedModelsResult>("/unified-models?archived=all");
      const unified = models.models.find((m) => m.id === route.unified_model_id);
      if (!unified) throw new Error("统一模型不存在，请刷新后重试");
      if (unified.status !== "ACTIVE") {
        await patch(`/unified-models/${unified.id}`, {
          expected_version: unified.version,
          status: "ACTIVE",
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resourceRoutes(resourceId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.unifiedModels });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.billingRules });
    },
  });
}
