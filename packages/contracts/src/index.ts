/**
 * @qianliu/contracts — 仟流智算北向/管理 API 与错误合同。
 *
 * W01 仅提供类型骨架。具体 OpenAI 兼容 envelope、SSE 事件名、Anthropic 形状在 W05（M2）按 TRD §6 冻结。
 * 依据：
 *   - PoC gateway-spike.mjs 的 Outcome/Usage/Settlement 形状（迁移语义，不直接搬代码）。
 *   - TRD §5.7（请求与账本对象）、§6（北向协议）、§8（计量与提交边界）、§9（错误分类）。
 */

import type { RequestShapeSummary, UpstreamErrorEvidence } from "./diagnostic-evidence.js";
import type { ReasoningFieldExtensions } from "./northbound.js";

export * from "./diagnostic-evidence.js";

// ===== Usage（计量事实）=====

/** 计量质量分级（TRD §5.7 行 355）。后两类不得在 UI 冒充逐请求精确值。 */
export type UsageQuality =
  | "PROVIDER_REPORTED"
  | "ESTIMATED"
  | "ACCOUNT_AGGREGATED"
  | "MIXED"
  | "UNKNOWN";

/**
 * 上游返回或 Gateway 计算的输入/输出/缓存原始 Token（PRD §9）。
 * 这是"Token 用量事实"，未经过套餐倍率折算。
 */
export interface Usage {
  /** 输入 Token（DeepSeek 进一步区分缓存命中/未命中，由 Adapter 填）。 */
  input: number;
  /** 输出 Token。 */
  output: number;
  /** 缓存命中 Token（0 表示无）。 */
  cache: number;
  /** 输出 token 中的推理 token 子集（Responses output_tokens_details.reasoning_tokens）。 */
  reasoning?: number;
  /** 计量质量。 */
  quality: UsageQuality;
}

// ===== 上游 Attempt 结果 =====

/**
 * 单次上游尝试的结果（PoC gateway-spike.mjs Outcome 形状的 TypeScript 化）。
 * Adapter 必须实现 (resource, request, attemptNo) => Promise<Outcome> 签名（TRD §7）。
 */
export interface Outcome {
  /** HTTP 状态码；0 表示传输层失败（transport_error / client_cancelled）。 */
  status: number;
  /** 是否已向下游提交首个有效输出（TRD §8.3 committed 边界）。提交后禁止切换上游。 */
  committed: boolean;
  usage: Usage;
  /** 规范化 assistant 输出项；仅驻留内存，供各北向协议转换，不写入账本正文。 */
  responseOutput?: unknown[];
  /** 厂商推理字段；仅供 OpenAI-compatible 北向响应原样回传，不持久化。 */
  responseReasoningExtensions?: ReasoningFieldExtensions;
  /**
   * 兼容本地既有真实 Caller 的内存态原始 JSON；不得写入账本、日志或 Evidence。
   * 新的多厂商 Caller 优先使用 responseOutput，W04 再统一收敛该兼容字段。
   */
  responseBody?: unknown;
  /** 该 Attempt 的 API 费用（API 模式）；套餐模式为 undefined，由 settlement 折算。 */
  cost?: string; // decimal.js 字符串（避免 number 精度损失）
  error?: string;
  /**
   * 上游限流与额度错误的稳定语义（含厂商用 403 表达窗口耗尽的情况）。
   * 只保存归一化类型，不保存厂商原始正文，满足
   * METADATA_ONLY；Gateway 据此区分瞬时拥塞、并发占满和额度周期耗尽。
   */
  upstreamErrorKind?:
    | "ENGINE_OVERLOADED"
    | "CONCURRENCY_LIMITED"
    | "WINDOW_EXHAUSTED"
    | "QUOTA_EXHAUSTED"
    | "UNKNOWN";
  /** 厂商 Retry-After 归一化后的毫秒数；缺失时不伪造。 */
  retryAfterMs?: number;
  /** RA-W04：Adapter 规范化后的稳定可用性信号。 */
  unifiedAvailabilitySignal?:
    | "RATE_LIMIT_RETRY_AFTER"
    | "QUOTA_EXHAUSTED"
    | "PLAN_EXPIRED"
    | "MODEL_UNAUTHORIZED"
    | "UPSTREAM_MAINTENANCE"
    | "CONFIGURATION_ERROR"
    | "TECHNICAL_FAILURE";
  /** 允许落库的稳定业务码，不含上游原始正文。 */
  upstreamCode?: string;
  /** 上游 4xx/5xx 的脱敏结构化证据。 */
  upstreamErrorEvidence?: UpstreamErrorEvidence;
  /** 实际上游请求的无正文结构摘要，仅在失败时持久化。 */
  requestShapeSummary?: RequestShapeSummary;
  /** 上游明确恢复时间；没有可靠字段时保持缺失。 */
  recoverAt?: string;
  /** 收到上游首个响应字节的时间（epoch ms），仅记元数据。 */
  firstByteAt?: number;
  /** 收到上游最后一个数据块的时间（epoch ms），仅用于超时排障，不落库（POOL-034）。 */
  lastByteAt?: number;
  /** 故障所在分层；不含上游或请求正文。 */
  failureLayer?:
    | "UPSTREAM_HTTP"
    | "UPSTREAM_NETWORK"
    | "UPSTREAM_PROTOCOL"
    | "FIRST_BYTE_TIMEOUT"
    | "STREAM_IDLE_TIMEOUT"
    | "REQUEST_TIMEOUT"
    | "CLIENT";
  cancelled?: boolean;
}

// ===== 错误分类（TRD §9 行 588-596）=====

/**
 * Gateway 统一错误分类。每类有明确的"是否切换上游"策略。
 * 来源：PoC gateway-spike.mjs GatewayError + TRD §9 错误表。
 */
export type ErrorClassification =
  | "CLIENT_INVALID" // 参数错误、上下文超限 — 不切换
  | "CAPABILITY_UNSUPPORTED" // 工具/内容块不支持 — 不切换
  | "DOWNSTREAM_AUTH_OR_QUOTA" // Key/主体/授权/额度失败 — 不切换
  | "UPSTREAM_TEMPORARY" // 429/5xx 可重试 — 可切换
  | "UPSTREAM_AUTH_INVALID" // 上游凭证失效 — 可切换到其他资源
  | "STREAM_INTERRUPTED_AFTER_COMMIT" // 已提交后断流 — 不切换，记录中断
  | "LEDGER_FAILURE" // 内部记账失败 — 不切换
  | "TRANSPORT_ERROR" // 传输层错误 — 可切换
  | "UNKNOWN";

/**
 * Gateway 统一错误（OpenAI 兼容 error envelope 在 W05 落地；此处先定内部形状）。
 */
export interface GatewayError {
  /** HTTP 状态码。 */
  status: number;
  /** 稳定错误码（machine-readable）。 */
  code: string;
  /** 面向调用方的脱敏消息。 */
  message: string;
  classification: ErrorClassification;
  details: {
    retryable: boolean;
    requestId?: string;
    provider?: string;
  };
}

// ===== 结算（Settlement）=====

/**
 * 一个 ai_request 对应唯一幂等结算汇总（TRD §5.7 ledger_transaction）。
 * 金额使用 decimal.js 字符串，数据库用 PostgreSQL numeric。
 */
export interface Settlement {
  requestId: string;
  /** 累计输入 Token（所有 Attempt 汇总）。 */
  usageInput: number;
  usageOutput: number;
  usageCache: number;
  /** 计量质量合成（多 Attempt 时按字典序合成 MIXED，PoC gateway-spike.mjs 行 191）。 */
  usageQuality: UsageQuality | string;
  /** API 总费用（decimal.js 字符串）。 */
  apiCost: string;
  /** 套餐扣减额度（PLAN 模式资源）。 */
  deduction?: number;
  /** 是否超额。 */
  overage: boolean;
  /** 节省（高峰等价组切换时；'NOT_CALCULABLE' 表示无反事实基线）。 */
  saving: number | "NOT_CALCULABLE";
  attemptCount: number;
}

// ===== 北向端点合同（W05 冻结细节）=====

/** 一期对外端点（PRD §4.1.1 行 83；TRD §6 行 383）。 */
export const NORTHBOUND_ENDPOINTS = [
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/messages",
  "POST /v1/responses",
] as const;

export type NorthboundEndpoint = (typeof NORTHBOUND_ENDPOINTS)[number];

/** 协议能力支持声明（TRD §6.3 行 424：原样/转换/不支持三选一）。 */
export type { CapabilitySupport } from "./northbound.js";

// 北向协议合同 DTO（W05 冻结）——见 northbound.ts
export * from "./northbound.js";

/** 资源模式（TRD §5.4）。 */
export type ResourceMode = "API" | "CODING_PLAN";

/** 凭证类型（TRD §5.4 行 236）。 */
export type CredentialType = "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION";

/** 资源状态（TRD §5.4 行 243）。 */
export type ResourceStatus =
  | "ACTIVE"
  | "DEGRADED"
  | "EXHAUSTED"
  | "EXPIRED"
  | "CREDENTIAL_INVALID"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

/** 主体类型（TRD §5.2）。 */
export type PrincipalType = "EMPLOYEE" | "PROJECT";

/** W01 出口标记——防止空包导入失败。 */
export const CONTRACTS_VERSION = "0.3.0" as const;
export * from "./admin-permissions.js";
