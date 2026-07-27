/**
 * @qianliu/domain — 仟流智算领域模型与确定性规则的枚举常量。
 *
 * 工程规则 §7：所有金额、倍率、周期、路由和账本规则必须确定、版本化、可回放；不得由 LLM 决定热路径。
 * 本包只放纯枚举与无副作用的领域常量；带状态的领域逻辑在 W02-W08 按工作包逐步落地。
 */

// 业务状态枚举（与 contracts 互补：contracts 放协议层，domain 放业务层）

export const ENTERPRISE_STATUS = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;

export const ADMIN_USER_STATUS = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;

export const PRINCIPAL_STATUS = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;

export const API_KEY_STATUS = {
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED",
} as const;

export const GRANT_STATUS = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  DISABLED: "DISABLED",
} as const;

export const BILLING_RULE_TYPE = {
  API_PRICE: "API_PRICE",
  PLAN_QUOTA_MULTIPLIER: "PLAN_QUOTA_MULTIPLIER",
} as const;

export const DISPATCH_POLICY_STATUS = {
  DRAFT: "DRAFT",
  VALIDATED: "VALIDATED",
  PUBLISHED: "PUBLISHED",
  RETIRED: "RETIRED",
} as const;

export const DISPATCH_ACTION = {
  ALLOW: "ALLOW",
  SWITCH: "SWITCH",
  RATE_LIMIT: "RATE_LIMIT",
  REJECT: "REJECT",
  ALLOW_OVERAGE: "ALLOW_OVERAGE",
} as const;

export const AI_REQUEST_STATUS = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export const LEDGER_TRANSACTION_STATUS = {
  PENDING: "PENDING",
  SETTLED: "SETTLED",
  REVERSED: "REVERSED",
} as const;

/** 周期单位（一期主体额度固定为 TOKEN，TRD §5.5 行 289）。 */
export const QUOTA_UNIT = {
  TOKEN: "TOKEN",
} as const;

/**
 * 可重试上游状态码集合（PoC gateway-spike.mjs RETRYABLE 迁移）。
 * 用于 W05/W06 Gateway failover 决策；非此集合的 4xx 不切换。
 */
export const RETRYABLE_UPSTREAM_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * 日志白名单字段（PoC observability.mjs MetadataLogger 白名单迁移）。
 * 只允许这 11 个字段进入结构化日志；其余字段在写入前过滤。
 * 依据：TRD §14.3 行 799-801（长度/Token/模型/规则/状态/错误分类/耗时 + 脱敏请求ID/客户端/网络摘要）。
 */
export const LOG_WHITELIST_FIELDS = [
  "time",
  "level",
  "event",
  "requestId",
  "principalId",
  "model",
  "capability",
  "status",
  "attemptCount",
  "errorCode",
  "durationMs",
] as const;

export type LogWhitelistField = (typeof LOG_WHITELIST_FIELDS)[number];

/** 默认内容留存模式（TRD §14.3 行 788：当前版本固定 METADATA_ONLY）。 */
export const DEFAULT_CONTENT_RETENTION_MODE = "METADATA_ONLY" as const;

export type ContentRetentionMode = "METADATA_ONLY";

// ===== M2：错误分类与提交边界（ai_request/ledger 状态已在前面定义）=====

/**
 * 错误分类（TRD §9 行 588-596）。
 * 每类有明确的"是否切换上游"策略。
 */
export const ERROR_CLASSIFICATION = {
  CLIENT_INVALID: "CLIENT_INVALID", // 参数错误、上下文超限 — 不切换
  CAPABILITY_UNSUPPORTED: "CAPABILITY_UNSUPPORTED", // 工具/内容块不支持 — 不切换
  DOWNSTREAM_AUTH_OR_QUOTA: "DOWNSTREAM_AUTH_OR_QUOTA", // Key/主体/授权/额度 — 不切换
  UPSTREAM_CREDENTIAL_INVALID: "UPSTREAM_CREDENTIAL_INVALID", // 401/403 — 提交前可切换
  UPSTREAM_RATE_LIMITED: "UPSTREAM_RATE_LIMITED", // 429 — 提交前可切换
  UPSTREAM_TEMPORARY: "UPSTREAM_TEMPORARY", // 连接失败/超时/5xx — 提交前可切换
  UPSTREAM_BILLING_BLOCKED: "UPSTREAM_BILLING_BLOCKED", // 上游余额/套餐耗尽 — 按兜底切换
  STREAM_INTERRUPTED_AFTER_COMMIT: "STREAM_INTERRUPTED_AFTER_COMMIT", // 已输出后断流 — 不切换
  LEDGER_FAILURE: "LEDGER_FAILURE", // 内部记账失败 — 不切换
  TRANSPORT_ERROR: "TRANSPORT_ERROR", // 传输层错误 — 可切换
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorClassification =
  (typeof ERROR_CLASSIFICATION)[keyof typeof ERROR_CLASSIFICATION];

/** 错误分类是否允许切换上游（提交前）。 */
export function isSwitchable(classification: ErrorClassification): boolean {
  return (
    classification === ERROR_CLASSIFICATION.UPSTREAM_CREDENTIAL_INVALID ||
    classification === ERROR_CLASSIFICATION.UPSTREAM_RATE_LIMITED ||
    classification === ERROR_CLASSIFICATION.UPSTREAM_TEMPORARY ||
    classification === ERROR_CLASSIFICATION.UPSTREAM_BILLING_BLOCKED ||
    classification === ERROR_CLASSIFICATION.TRANSPORT_ERROR
  );
}

/** 流式提交状态（TRD §8.3 response_committed 边界）。 */
export const COMMIT_STATE = {
  NOT_COMMITTED: "NOT_COMMITTED", // 响应头/空白保活阶段
  COMMITTED: "COMMITTED", // 首个有效输出已发给客户端
} as const;

export const DOMAIN_VERSION = "0.3.0" as const;
