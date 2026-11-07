/**
 * W18 数据获取 hooks —— TanStack Query 封装，三态（loading/error/success）由此驱动。
 *
 * 约定：401（UnauthorizedError）说明会话失效，由调用侧跳 /login；
 * 其余错误进 ErrorState 并可重试。无界重试禁止（工程规则 §7），retry 收敛为 1 次。
 *
 * 2026-11 v1.5 质量预检整改（GATE-01 第 2/3 批）：按域拆分至同目录 hooks-*.ts 模块，
 * 本文件保留总说明并再导出全部导出名，公共面（调用方导入路径与签名）不变。
 */
export { QUERY_KEYS } from "./hooks-query-keys";
export {
  useDashboard,
  useStandardHome,
  useUsage,
  usePrincipalAgentUsage,
  useBillingRules,
  useDispatchPolicies,
  useSupplyForecasts,
} from "./hooks-usage";
export {
  useProviderResources,
  useResourceUsageOverview,
  useQuotaWindows,
  useSyncQuotaWindow,
  useRefreshOfficialBalance,
  useResourceHealth,
  useResourceRoutes,
  useRetireResourceRoute,
  useRestoreResourceRoute,
  useEnableResourceRoute,
} from "./hooks-resources";
export {
  usePrincipals,
  useProviders,
  useUnifiedModels,
  useGrants,
  usePrincipalKeys,
  useAccessConfiguration,
  useModelRoutes,
  usePricingReadyRoutes,
} from "./hooks-catalog";
export {
  useGatewayRequest,
  useRouteCandidates,
  useAttempts,
  useDispatchDecision,
} from "./hooks-drilldown";
export {
  useAlerts,
  useOperationLogs,
  useDeploymentLogs,
  useDeploymentLog,
} from "./hooks-ops";
