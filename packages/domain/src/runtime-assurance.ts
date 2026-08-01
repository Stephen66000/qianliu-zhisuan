/**
 * RA-W01：运行保障冻结枚举与既有六态迁移判定。
 *
 * 本文件只提供纯类型与 Shadow 迁移判定，不接入 Gateway 热路径。
 * 硬熔断只能来自已确认的上游信号或计划规则；技术故障只降级／预警。
 */

export const RUNTIME_ASSURANCE_MODE = {
  OFF: "OFF",
  OBSERVE: "OBSERVE",
  ENFORCE: "ENFORCE",
} as const;

export type RuntimeAssuranceMode =
  (typeof RUNTIME_ASSURANCE_MODE)[keyof typeof RUNTIME_ASSURANCE_MODE];

export const AVAILABILITY_RULE_TYPE = {
  UPSTREAM_SIGNAL: "UPSTREAM_SIGNAL",
  SCHEDULE_BLOCK: "SCHEDULE_BLOCK",
  OBSERVATION_ALERT: "OBSERVATION_ALERT",
} as const;

export type AvailabilityRuleType =
  (typeof AVAILABILITY_RULE_TYPE)[keyof typeof AVAILABILITY_RULE_TYPE];

export const AVAILABILITY_RULE_VERSION_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  SUPERSEDED: "SUPERSEDED",
  DISABLED: "DISABLED",
} as const;

export type AvailabilityRuleVersionStatus =
  (typeof AVAILABILITY_RULE_VERSION_STATUS)[keyof typeof AVAILABILITY_RULE_VERSION_STATUS];

export const AVAILABILITY_ACTION = {
  WARN_ONLY: "WARN_ONLY",
  BLOCK: "BLOCK",
} as const;

export type AvailabilityAction =
  (typeof AVAILABILITY_ACTION)[keyof typeof AVAILABILITY_ACTION];

export const AVAILABILITY_RECOVERY_METHOD = {
  RETRY_AFTER: "RETRY_AFTER",
  UPSTREAM_RESET_TIME: "UPSTREAM_RESET_TIME",
  FIXED_DURATION: "FIXED_DURATION",
  SCHEDULE_END: "SCHEDULE_END",
  MANUAL: "MANUAL",
} as const;

export type AvailabilityRecoveryMethod =
  (typeof AVAILABILITY_RECOVERY_METHOD)[keyof typeof AVAILABILITY_RECOVERY_METHOD];

export const UNIFIED_AVAILABILITY_SIGNAL = {
  RATE_LIMIT_RETRY_AFTER: "RATE_LIMIT_RETRY_AFTER",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  PLAN_EXPIRED: "PLAN_EXPIRED",
  MODEL_UNAUTHORIZED: "MODEL_UNAUTHORIZED",
  UPSTREAM_MAINTENANCE: "UPSTREAM_MAINTENANCE",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  TECHNICAL_FAILURE: "TECHNICAL_FAILURE",
} as const;

export type UnifiedAvailabilitySignal =
  (typeof UNIFIED_AVAILABILITY_SIGNAL)[keyof typeof UNIFIED_AVAILABILITY_SIGNAL];

/** 冻结信号字典 v1 的统一中文摘要，Gateway 与企微通知共用。 */
export const UNIFIED_AVAILABILITY_SIGNAL_LABEL = {
  QUOTA_EXHAUSTED: "上游额度已耗尽",
  PLAN_EXPIRED: "上游套餐已过期",
  MODEL_UNAUTHORIZED: "上游模型未获授权",
  UPSTREAM_MAINTENANCE: "上游正在维护",
  RATE_LIMIT_RETRY_AFTER: "上游明确要求稍后重试",
  CONFIGURATION_ERROR: "上游配置错误",
  TECHNICAL_FAILURE: "上游技术故障",
} as const satisfies Record<UnifiedAvailabilitySignal, string>;

export function availabilitySignalSummary(signal: UnifiedAvailabilitySignal): string {
  return UNIFIED_AVAILABILITY_SIGNAL_LABEL[signal];
}

export const AVAILABILITY_DECISION = {
  ALLOW: "ALLOW",
  BLOCKED_UPSTREAM: "BLOCKED_UPSTREAM",
  BLOCKED_SCHEDULE: "BLOCKED_SCHEDULE",
} as const;

export type AvailabilityDecision =
  (typeof AVAILABILITY_DECISION)[keyof typeof AVAILABILITY_DECISION];

export type LegacyResourceStatus =
  | "ACTIVE"
  | "DEGRADED"
  | "EXHAUSTED"
  | "EXPIRED"
  | "CREDENTIAL_INVALID"
  | "UNAVAILABLE";

export type ConfirmedAvailabilitySource = "UPSTREAM" | "SCHEDULE" | null;

export type LegacyResourceMigrationDisposition =
  | "KEEP_ALLOW"
  | "CREATE_SHADOW_BLOCK_CANDIDATE"
  | "DOWNGRADE_TECHNICAL_UNAVAILABLE"
  | "REVIEW_REQUIRED";

export interface LegacyResourceMigrationInput {
  status: LegacyResourceStatus;
  /** 最近状态事件原因；只接受稳定 reason code，不接受原始响应正文。 */
  latestReason: string | null;
  /** 已由 Adapter／管理员证据确认的可用性来源；仅状态值本身不算确认。 */
  confirmedAvailabilitySource: ConfirmedAvailabilitySource;
}

export interface LegacyResourceMigrationPlan {
  targetHealthStatus: "ACTIVE" | "DEGRADED";
  availabilityDecision: AvailabilityDecision | null;
  disposition: LegacyResourceMigrationDisposition;
  requiresManualReview: boolean;
}

export interface AvailabilityRuleSnapshot {
  id: string;
  ruleId: string;
  ruleVersion: number;
  ruleType: AvailabilityRuleType;
  providerId: string | null;
  providerResourceId: string | null;
  unifiedModelId: string | null;
  upstreamModel: string | null;
  unifiedSignal: UnifiedAvailabilitySignal | null;
  action: AvailabilityAction;
  recoveryMethod: AvailabilityRecoveryMethod | null;
  fallbackDurationSeconds: number | null;
  scheduleTimezone: string | null;
  scheduleDaysOfWeek: number[] | null;
  scheduleStartTime: string | null;
  scheduleEndTime: string | null;
  priority: number;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

export interface AvailabilityMatchContext {
  now: Date;
  providerId: string | null;
  providerResourceId: string | null;
  unifiedModelId: string | null;
  upstreamModel: string | null;
  unifiedSignal?: UnifiedAvailabilitySignal | null;
}

function scopeMatches(rule: AvailabilityRuleSnapshot, context: AvailabilityMatchContext): boolean {
  return (
    (rule.providerId === null || rule.providerId === context.providerId) &&
    (rule.providerResourceId === null || rule.providerResourceId === context.providerResourceId) &&
    (rule.unifiedModelId === null || rule.unifiedModelId === context.unifiedModelId) &&
    (rule.upstreamModel === null || rule.upstreamModel === context.upstreamModel)
  );
}

function effectiveAt(rule: AvailabilityRuleSnapshot, now: Date): boolean {
  return (rule.effectiveFrom === null || rule.effectiveFrom <= now) &&
    (rule.effectiveTo === null || rule.effectiveTo > now);
}

function localParts(now: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return { day: dayMap[weekday] ?? 0, minutes: hour * 60 + minute };
}

function timeMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** 按规则时区确定性判断计划时段；跨午夜时把凌晨段归属到前一配置日。 */
export function scheduleMatches(rule: AvailabilityRuleSnapshot, now: Date): boolean {
  if (rule.ruleType !== AVAILABILITY_RULE_TYPE.SCHEDULE_BLOCK) return true;
  if (!rule.scheduleTimezone || !rule.scheduleStartTime || !rule.scheduleEndTime) return false;
  const local = localParts(now, rule.scheduleTimezone);
  const start = timeMinutes(rule.scheduleStartTime);
  const end = timeMinutes(rule.scheduleEndTime);
  const days = rule.scheduleDaysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
  if (start < end) return days.includes(local.day) && local.minutes >= start && local.minutes < end;
  if (start === end) return days.includes(local.day);
  if (local.minutes >= start) return days.includes(local.day);
  const previousDay = (local.day + 6) % 7;
  return local.minutes < end && days.includes(previousDay);
}

function specificity(rule: AvailabilityRuleSnapshot): number {
  if (rule.providerResourceId && rule.upstreamModel) return 5;
  if (rule.providerResourceId) return 4;
  if (rule.providerId && rule.upstreamModel) return 3;
  if (rule.providerId) return 2;
  return 1;
}

/** 选择唯一确定性规则：作用域具体度、BLOCK、优先级、业务版本依次排序。 */
export function matchAvailabilityRule(
  rules: AvailabilityRuleSnapshot[],
  context: AvailabilityMatchContext,
  ruleType?: AvailabilityRuleType,
): AvailabilityRuleSnapshot | null {
  return rules
    .filter((rule) => (!ruleType || rule.ruleType === ruleType))
    .filter((rule) => effectiveAt(rule, context.now) && scopeMatches(rule, context))
    .filter((rule) => rule.unifiedSignal === null || rule.unifiedSignal === context.unifiedSignal)
    .filter((rule) => scheduleMatches(rule, context.now))
    .sort((a, b) =>
      specificity(b) - specificity(a) ||
      Number(b.action === AVAILABILITY_ACTION.BLOCK) - Number(a.action === AVAILABILITY_ACTION.BLOCK) ||
      a.priority - b.priority ||
      b.ruleVersion - a.ruleVersion,
    )[0] ?? null;
}

function rangesOverlap(a: AvailabilityRuleSnapshot, b: AvailabilityRuleSnapshot): boolean {
  const aStart = a.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = b.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = b.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart < bEnd && bStart < aEnd;
}

/** 发布前保守冲突检查：完全相同作用域、类型、信号且有效期重叠即拒绝。 */
export function findAvailabilityRuleConflicts(
  candidate: AvailabilityRuleSnapshot,
  published: AvailabilityRuleSnapshot[],
): AvailabilityRuleSnapshot[] {
  return published.filter((rule) =>
    rule.ruleId !== candidate.ruleId &&
    rule.ruleType === candidate.ruleType &&
    rule.providerId === candidate.providerId &&
    rule.providerResourceId === candidate.providerResourceId &&
    rule.unifiedModelId === candidate.unifiedModelId &&
    rule.upstreamModel === candidate.upstreamModel &&
    rule.unifiedSignal === candidate.unifiedSignal &&
    rangesOverlap(rule, candidate),
  );
}

export function recoverAtForRule(
  rule: AvailabilityRuleSnapshot,
  now: Date,
  upstreamRecoverAt?: Date | null,
): Date | null {
  if (upstreamRecoverAt) return upstreamRecoverAt;
  if (rule.fallbackDurationSeconds) {
    return new Date(now.getTime() + rule.fallbackDurationSeconds * 1_000);
  }
  return null;
}

const TECHNICAL_UNAVAILABLE_REASONS = new Set([
  "PASSIVE_FAILURE",
  "FAILURE_THRESHOLD",
  "RATE_LIMITED",
  "TRANSPORT_ERROR",
]);

/**
 * 把既有 provider_resource 六态拆成“健康 + 事件派生可用性”的迁移计划。
 *
 * 返回值只用于 W01 盘点／Shadow 对比；W05B 才能在 Evidence 审核后执行数据迁移。
 */
export function planLegacyResourceMigration(
  input: LegacyResourceMigrationInput,
): LegacyResourceMigrationPlan {
  if (input.status === "ACTIVE") {
    return {
      targetHealthStatus: "ACTIVE",
      availabilityDecision: AVAILABILITY_DECISION.ALLOW,
      disposition: "KEEP_ALLOW",
      requiresManualReview: false,
    };
  }

  if (input.status === "DEGRADED") {
    return {
      targetHealthStatus: "DEGRADED",
      availabilityDecision: AVAILABILITY_DECISION.ALLOW,
      disposition: "KEEP_ALLOW",
      requiresManualReview: false,
    };
  }

  if (input.status === "UNAVAILABLE" && TECHNICAL_UNAVAILABLE_REASONS.has(input.latestReason ?? "")) {
    return {
      targetHealthStatus: "DEGRADED",
      availabilityDecision: AVAILABILITY_DECISION.ALLOW,
      disposition: "DOWNGRADE_TECHNICAL_UNAVAILABLE",
      requiresManualReview: false,
    };
  }

  if (input.confirmedAvailabilitySource !== null) {
    return {
      targetHealthStatus: "DEGRADED",
      availabilityDecision:
        input.confirmedAvailabilitySource === "SCHEDULE"
          ? AVAILABILITY_DECISION.BLOCKED_SCHEDULE
          : AVAILABILITY_DECISION.BLOCKED_UPSTREAM,
      disposition: "CREATE_SHADOW_BLOCK_CANDIDATE",
      requiresManualReview: false,
    };
  }

  // EXHAUSTED／EXPIRED／CREDENTIAL_INVALID／来源不明的 UNAVAILABLE 都不能只凭旧状态
  // 自动创建正式熔断事件，也不能无证据自动放行。
  return {
    targetHealthStatus: "DEGRADED",
    availabilityDecision: null,
    disposition: "REVIEW_REQUIRED",
    requiresManualReview: true,
  };
}
