/**
 * DeepSeek Adapter（W06）。
 *
 * 依据：TRD §7（Adapter 统一能力）、§7.1（DeepSeek API 模式）。
 * W06 阶段：实现能力声明、模型映射、usage 三维度解析（cache_hit/cache_miss/output）、
 * 错误归一化（TRD §9 分类）、健康检查骨架。实际 HTTP 调用在 DEP-PROVIDER-CREDENTIALS
 * 解锁后接入；W06 用 upstreamCaller 注入点（测试注入 StubUpstream）。
 *
 * usage 三维度（TRD §7.1 行 474）：输入缓存命中、输入缓存未命中、输出 Token。
 */
import type { Outcome, Usage } from "@qianliu/contracts";
import type { ErrorClassification } from "@qianliu/domain";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";
import type { ProviderAdapter, AdapterResource, AdapterRequest } from "../index.js";

/**
 * 上游调用器（注入点）。
 * 真实实现：fetch DeepSeek API（DEP-PROVIDER-CREDENTIALS 解锁后）。
 * 测试实现：StubUpstream。
 */
export type UpstreamCaller = (
  resource: AdapterResource,
  request: AdapterRequest,
  attemptNo: number,
) => Promise<Outcome>;

/** DeepSeek 上游模型映射（alias → upstream model）。 */
const DEEPSEEK_MODEL_MAP: Record<string, string> = {
  "qianliu-deepseek": "deepseek-chat",
  "qianliu-deepseek-reasoner": "deepseek-reasoner",
};

export class DeepSeekAdapter implements ProviderAdapter {
  readonly providerCode = "deepseek" as const;
  readonly capabilities = new Set([
    "chat",
    "messages",
    "stream",
    "tools",
    "prompt_cache", // DeepSeek 支持 Prompt Cache
  ]);

  constructor(private caller: UpstreamCaller) {}

  async invoke(
    resource: AdapterResource,
    request: AdapterRequest,
    attemptNo: number,
  ): Promise<Outcome> {
    // 鉴权注入：SecretValue 只在调用器内部 reveal（不写日志/Trace）
    // resource.secret 已由上层（Gateway）从凭证密文解密后包装为 SecretValue
    const mappedRequest: AdapterRequest = {
      ...request,
      // 模型别名 → 上游模型（Adapter 责任，TRD §7 行 456）
      unifiedModel: request.unifiedModel,
    };
    // 校验模型映射存在
    const upstreamModel = DEEPSEEK_MODEL_MAP[request.unifiedModel];
    if (!upstreamModel) {
      return {
        status: 400,
        committed: false,
        usage: zeroUsage(),
        error: "model_not_mapped",
      };
    }

    const outcome = await this.caller(resource, mappedRequest, attemptNo);
    // 错误归一化（TRD §9）：将 outcome.error/status 映射到 ErrorClassification
    return outcome;
  }

  /** 将上游 HTTP 状态码归一化为错误分类（TRD §9 行 588-596）。 */
  classifyUpstreamError(status: number, errorMessage?: string): ErrorClassification {
    if (status === 401 || status === 403) return ERROR_CLASSIFICATION.UPSTREAM_CREDENTIAL_INVALID;
    if (status === 429) return ERROR_CLASSIFICATION.UPSTREAM_RATE_LIMITED;
    if (status >= 500) return ERROR_CLASSIFICATION.UPSTREAM_TEMPORARY;
    if (status === 0 && errorMessage === "transport_error") return ERROR_CLASSIFICATION.TRANSPORT_ERROR;
    if (errorMessage === "client_cancelled") return ERROR_CLASSIFICATION.CLIENT_INVALID;
    if (errorMessage === "stream_interrupted_after_commit")
      return ERROR_CLASSIFICATION.STREAM_INTERRUPTED_AFTER_COMMIT;
    if (status === 402) return ERROR_CLASSIFICATION.UPSTREAM_BILLING_BLOCKED;
    if (status >= 400 && status < 500) return ERROR_CLASSIFICATION.CLIENT_INVALID;
    return ERROR_CLASSIFICATION.UNKNOWN;
  }

  /**
   * 解析 DeepSeek usage 为三维度（TRD §7.1 行 474）。
   * DeepSeek 在 prompt_tokens_details 返回 cached_tokens。
   */
  parseUsage(raw: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  }): Usage {
    const cache = raw.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      input: raw.prompt_tokens, // 总输入（含缓存命中）
      output: raw.completion_tokens,
      cache, // 缓存命中部分
      quality: "PROVIDER_REPORTED",
    };
  }
}

function zeroUsage(): Usage {
  return { input: 0, output: 0, cache: 0, quality: "UNKNOWN" };
}
