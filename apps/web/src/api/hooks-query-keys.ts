/**
 * W18 数据获取 hooks 的 query key 注册表 —— TanStack Query 缓存标识的唯一出处。
 *
 * 从 hooks.ts 按域拆分时独立成叶模块：资源/模型/用量等多个 hooks-* 域模块的
 * 失效（invalidateQueries）互相引用跨域 key，主文件再导出保持原公共面。
 */
import type { UsageQueryParams } from "./types";

export const QUERY_KEYS = {
  dashboard: ["dashboard"] as const,
  standardHome: ["dashboard", "home"] as const,
  usage: (params: UsageQueryParams) => ["usage", params] as const,
  billingRules: ["billing-rules"] as const,
  dispatchPolicies: ["dispatch-policies"] as const,
  supplyForecasts: ["supply-forecasts"] as const,
  principals: ["principals"] as const,
  accessConfiguration: (principalId: string) => ["principals", principalId, "access-configuration"] as const,
  providerResources: ["provider-resources"] as const,
  resourceRoutes: (resourceId: string) =>
    ["provider-resources", resourceId, "routes"] as const,
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
