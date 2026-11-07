/**
 * W20 诊断下钻域 hooks —— 网关请求明细 / 路由候选 / 上游尝试 / 调度决策。
 * 本模块自 api/hooks.ts 按域拆出；错误与重试约定见 hooks.ts 总说明。
 */
import { useQuery } from "@tanstack/react-query";

import { get } from "./client";
import { QUERY_KEYS } from "./hooks-query-keys";
import type {
  AttemptsResult,
  DispatchDecisionItem,
  GatewayRequestDetail,
  RouteCandidateItem,
} from "./types";

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
