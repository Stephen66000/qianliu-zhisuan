/**
 * W20 运维观测域 hooks —— 告警（含 30 秒前台轮询）/ 操作日志 / 部署日志。
 * 本模块自 api/hooks.ts 按域拆出；错误与重试约定见 hooks.ts 总说明。
 */
import { useQuery } from "@tanstack/react-query";

import { get } from "./client";
import { QUERY_KEYS } from "./hooks-query-keys";
import type {
  AlertsResult,
  DeploymentLogDetail,
  DeploymentLogsResult,
  DeploymentStatus,
  OperationLogsResult,
} from "./types";

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
