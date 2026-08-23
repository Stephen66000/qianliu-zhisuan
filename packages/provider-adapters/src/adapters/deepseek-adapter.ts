/**
 * DeepSeek Adapter（W06）。
 *
 * 依据：TRD §7（Adapter 统一能力）、§7.1（DeepSeek API 模式）。
 * 实现能力声明、usage 三维度解析（cache_hit/cache_miss/output）、
 * 错误归一化（TRD §9 分类）与上游调用委托。
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

export class DeepSeekAdapter implements ProviderAdapter {
  readonly providerCode = "deepseek" as const;
  readonly capabilities = new Set([
    "chat",
    "messages",
    "responses",
    "stream",
    "tools",
    "vision",
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
    // 统一别名由 Web/model_route 配置；resource.upstreamModel 是唯一上游模型事实源。
    // Adapter 不维护第二份硬编码别名表，避免合法的企业自定义别名被误拒。
    const outcome = await this.caller(resource, request, attemptNo);
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
