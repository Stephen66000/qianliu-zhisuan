/**
 * W18 认证 hooks —— /auth/me 会话探测 + 登录/登出。
 *
 * 会话以 httpOnly cookie 承载，前端不接触 token；
 * 有效会话每 30 秒复查；401 转为匿名状态并停止轮询，成功登录后重新确认会话。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post, UnauthorizedError } from "./client";
import type { AdminSession, FeatureFlags, LoginResponse, ProviderFinanceMode } from "./types";

export const AUTH_QUERY_KEY = ["auth", "me"] as const;

export function useAdminSession() {
  return useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: async ({ signal }) => {
      try { return await get<{
      admin: AdminSession; featureFlags: FeatureFlags; providerFinanceMode: ProviderFinanceMode;
      }>("/auth/me", signal); }
      catch (error) {
        // A revoked session is a settled anonymous state, not a failed refresh retaining old identity.
        if (error instanceof UnauthorizedError) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 30_000,
    refetchInterval: query => query.state.data === null ? false : 30_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      post<LoginResponse>("/auth/login", credentials),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "auth" });
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => post<void>("/auth/logout"),
    onSettled: () => {
      queryClient.clear();
    },
  });
}
