/**
 * W18 认证 hooks —— /auth/me 会话探测 + 登录/登出。
 *
 * 会话以 httpOnly cookie 承载，前端不接触 token；
 * useAdminSession 用 enabled 控制仅在需要时探测（登录页不探测）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post } from "./client";
import type { AdminSession, LoginResponse } from "./types";

export const AUTH_QUERY_KEY = ["auth", "me"] as const;

export function useAdminSession() {
  return useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: ({ signal }) => get<{ admin: AdminSession }>("/auth/me", signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      post<LoginResponse>("/auth/login", credentials),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
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
