/**
 * @qianliu/provider-adapters — DeepSeek/智谱/Kimi Adapter 接口骨架与凭证脱敏。
 *
 * W01 只提供：
 *   1. SecretValue —— 强制脱敏的凭证包装（迁移自 PoC provider-secrets.mjs，语义保留）。
 *   2. ProviderAdapter 接口 —— 约束所有 Adapter 实现统一签名（TRD §7 行 453-469 的 13 项能力）。
 *   3. Adapter 调用结果签名 —— (resource, request, attemptNo) => Outcome（迁移自 PoC gateway-spike.mjs 行 242）。
 *
 * 具体 DeepSeek/智谱/Kimi 实现在 W06（M2）落地；W01 不实现任何真实 HTTP 调用。
 */

import type { Outcome } from "@qianliu/contracts";
import type { SecretValue } from "./secret-value.js";

export {
  parseRequestShapeSummary,
  parseUpstreamErrorEvidence,
} from "@qianliu/contracts";

export { SecretValue } from "./secret-value.js";

/**
 * Adapter 调用时的资源上下文（W06 起填充真实字段）。
 * 字段集预留 TRD §5.4 provider_resource 的关键属性。
 */
export interface AdapterResource {
  providerCode: "deepseek" | "zhipu" | "kimi";
  resourceId: string;
  mode: "API" | "CODING_PLAN";
  upstreamModel: string;
  concurrencyLimit: number;
  /** 凭证（SecretValue 包装，脱敏安全）。 */
  secret: SecretValue;
}

/**
 * Adapter 调用时的请求上下文（W05/W06 起填充真实字段）。
 * 注意：请求正文（messages/prompt）只在 Adapter 进程内存中处理，
 * 不得进入本对象的持久化字段（content_retention_mode=METADATA_ONLY）。
 */
export interface AdapterRequest {
  /** 内部规范化请求 ID（贯穿响应头、日志、Trace、Attempt、账本）。 */
  requestId: string;
  /** 统一模型别名（客户端看到的 qianliu-* 别名）。 */
  unifiedModel: string;
  /** 是否流式。 */
  stream: boolean;
  /** 北向协议，用于保真转换 Responses 工具/推理字段。 */
  capability?: "chat" | "messages" | "responses";
  /** 请求正文载荷（仅内存传递；Adapter 不得持久化）。 */
  body: unknown;
  /** 客户端断开信号（AbortSignal），用于取消。 */
  abort?: AbortSignal;
  /**
   * 真实流式回调：Caller 解析到一个完整上游 Chat SSE data 后立即交给 Gateway。
   * payload 只在请求内存中停留，不得写日志或数据库。
   */
  onStreamChunk?: (payload: Record<string, unknown>) => void | Promise<void>;
}

/**
 * Provider Adapter 统一接口（TRD §7 行 453-469 的 13 项能力收敛为 invoke 一个方法 + 能力声明）。
 * 所有 Adapter 必须实现此接口；Gateway 在 W05/W06 通过此接口调用上游。
 */
export interface ProviderAdapter {
  readonly providerCode: "deepseek" | "zhipu" | "kimi";
  /** 能力声明（TRD §7 行 469：区分 Provider 默认/资源覆盖/模型覆盖）。 */
  readonly capabilities: ReadonlySet<string>;
  /**
   * 执行单次上游尝试。
   * 返回 Outcome；Adapter 内部处理 fetch/SSE/usage 解析/错误归一化（TRD §7）。
   */
  invoke(resource: AdapterResource, request: AdapterRequest, attemptNo: number): Promise<Outcome>;
}

export const PROVIDER_ADAPTERS_VERSION = "0.3.0" as const;

export {
  discoverProviderModels,
  builtinProviderModelDiscovery,
  clearProviderModelDiscoveryCache,
  officialSourceConfig,
  providerModelDiscoveryDescriptor,
  ProviderModelDiscoveryError,
  type DiscoveryErrorCode,
  type DiscoverySource,
  type DiscoveredProviderModel,
  type DiscoveredModelFacts,
  type DiscoveryFetch,
  type OfficialSourceConfig,
  type OfficialSourceOverrides,
  type ModelDiscoveryResult,
  type ModelDiscoveryCatalogDiff,
  type ModelIntegrationState,
  type ProviderCode,
  type ResourceMode,
} from "./model-discovery.js";

export {
  validateProviderModel,
  type ModelValidationCheck,
  type ModelValidationEvidence,
} from "./model-validation.js";

export {
  queryCodingPlanQuota,
  ProviderCodingPlanQuotaError,
  CODING_PLAN_QUOTA_ADAPTER_VERSION,
  type QuotaWindow,
  type QuotaWindowType,
  type QuotaWindowUnit,
  type CodingPlanQuotaResult,
  type QuotaFetch,
} from "./coding-plan-quota.js";
export {
  PROVIDER_OPERATING_ADAPTER_VERSION,
  ProviderOperatingFactsError,
  queryProviderOperatingBalance,
  type ProviderOperatingBalance,
  type ProviderOperatingFetch,
} from "./provider-operating-facts.js";

// 密码学原语（W02 起启用）
export {
  digestApiKey,
  generateApiKey,
  apiKeyPrefix,
  generateSessionToken,
  digestSessionToken,
  decodeKek,
  encryptCredential,
  decryptCredential,
  credentialFingerprint,
  type EncryptedCredential,
} from "./crypto.js";

// Adapter 与 Stub 上游（W06 起启用；W09 起增 ZhipuAdapter；W10 起增 KimiAdapter）
export {
  DeepSeekAdapter,
  type UpstreamCaller,
} from "./adapters/deepseek-adapter.js";
export { ZhipuAdapter } from "./adapters/zhipu-adapter.js";
export { KimiAdapter } from "./adapters/kimi-adapter.js";
export { StubUpstream, type StubMode, type StubUpstreamConfig } from "./adapters/stub-upstream.js";
export {
  createOpenAiCompatibleCaller,
  resolveProviderSecret,
  toChatCompletionsRequest,
  responsesToChatCompletions,
  chatAssistantToResponsesOutput,
  type HttpFetch,
  type HttpResponseLike,
  type OpenAiCompatibleCallerOptions,
} from "./openai-compatible-caller.js";
