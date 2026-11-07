/**
 * W18 目录域 hooks —— 主体（principals）/ 厂商（providers）/ 统一模型 /
 * 员工授权与密钥 / POOL-033 单主体接入配置 / 模型路由 / 计价就绪路由。
 * 本模块自 api/hooks.ts 按域拆出；错误与重试约定见 hooks.ts 总说明。
 */
import { useQuery } from "@tanstack/react-query";

import { useCatalogPath } from "./catalog-access";
import { get } from "./client";
import { QUERY_KEYS } from "./hooks-query-keys";
import type {
  AccessConfiguration,
  GrantsResult,
  ModelRoutesResult,
  PrincipalKeysResult,
  PrincipalsResult,
  ProvidersResult,
  UnifiedModelsResult,
} from "./types";

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

export function useProviders(archived?: "exclude" | "only" | "all") {
  const base = useCatalogPath("providers", "/providers");
  const path = archived && archived !== "exclude" ? `${base}?archived=${archived}` : base;
  return useQuery({
    queryKey: [...QUERY_KEYS.providers, path],
    queryFn: ({ signal }) => get<ProvidersResult>(path, signal),
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
