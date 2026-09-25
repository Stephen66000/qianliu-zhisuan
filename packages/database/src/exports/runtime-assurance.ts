/**
 * @qianliu/database 子导出：运行保障域。
 *
 * 由 src/index.ts 按域拆分而来（质量门禁单文件上限）；src/index.ts 以 `export *`
 * 再导出本模块，包对外导出面与历史调用点保持不变。
 *
 * 本文件只做再导出，不含实现，新增导出必须归入对应域子模块而非重新堆回 index.ts。
 */
export {
  DeploymentLogRepository,
  DeploymentLogImmutableError,
  type DeploymentLog,
  type DeploymentLogEvent,
  type DeploymentManifest,
  type DeploymentStatus,
} from "../repositories/deployment-log-repository.js";

export {
  AlertEventRepository,
  DEFAULT_THRESHOLDS,
  type AlertEvent,
  type AlertThresholds,
} from "../repositories/alert-event-repository.js";

export {
  RuntimeAssuranceRepository,
  RuntimeAssuranceConflictError,
  type Person,
  type PersonView,
  type PersonExternalIdentity,
  type AvailabilityRule,
  type AvailabilityRuleVersion,
  type AvailabilityEvent,
  type NotificationEndpoint,
  type NotificationDelivery,
  type RuleVersionInput,
  type RuleView,
  type SignalInput,
  type SignalResult,
  type DeliveryContext,
  type LegacyUnavailableAssessment,
} from "../repositories/runtime-assurance-repository.js";

export type {
  NotificationCategory,
  RuntimeNotificationRecipientTable,
} from "../kysely-availability-tables.js";
