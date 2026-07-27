/**
 * 智谱 Adapter（W09）。
 *
 * 依据：TRD §7（Adapter 统一能力）、§7.2（智谱 Coding Plan 模式）。
 * W09 阶段：实现能力声明、模型映射、usage 原始口径解析、错误归一化（TRD §9 分类）、
 * 健康检查骨架。实际 HTTP 调用在 DEP-PROVIDER-CREDENTIALS 解锁后接入；
 * W09 用 upstreamCaller 注入点（测试注入 StubUpstream）。
 *
 * Coding Plan 计量口径（TRD §7.2 行 481-484）：
 *   - 保存原始 Token／Prompt 和厂商额度口径；
 *   - 北京时间 14:00–18:00 的高峰扣减倍数属于版本化计价规则（调研文档「以具体资源上已生效的规则版本为准」），
 *     归 W13 计价规则版本实现；Adapter 本身不做倍数折算，只保原始用量事实。
 *
 * usage 维度（TRD §7.2）：智谱 OpenAI 兼容入口返回 prompt_tokens/completion_tokens，
 * 当前公开 Coding Plan 不区分缓存命中分项，cache 兜底为 0。
 */
import type { Outcome, Usage } from "@qianliu/contracts";
import type { ErrorClassification } from "@qianliu/domain";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";
import type { ProviderAdapter, AdapterResource, AdapterRequest } from "../index.js";
import type { UpstreamCaller } from "./deepseek-adapter.js";

/** 智谱 Coding Plan 当前模型映射（alias → upstream model）。资源接入时可在 upstream_models 覆盖。 */
const ZHIPU_MODEL_MAP: Record<string, string> = {
  "qianliu-glm-coding": "glm-5.2", // GLM-5.2（调研文档确认的 Coding Plan 当前模型）
};

export class ZhipuAdapter implements ProviderAdapter {
  readonly providerCode = "zhipu" as const;
  readonly capabilities = new Set([
    "chat",
    "messages",
    "stream",
    "tools",
    "coding_plan", // Coding Plan 模式标识（TRD §7.2）
    // 注：智谱当前公开 Coding Plan 不区分 prompt cache 分项，不声明 prompt_cache。
  ]);

  constructor(private caller: UpstreamCaller) {}

  async invoke(
    resource: AdapterResource,
    request: AdapterRequest,
    attemptNo: number,
  ): Promise<Outcome> {
    // 鉴权注入：SecretValue 只在调用器内部 reveal（不写日志/Trace）
    const mappedRequest: AdapterRequest = {
      ...request,
      unifiedModel: request.unifiedModel,
    };
    // 校验模型映射存在（TRD §7 行 456：模型映射是 Adapter 责任）
    const upstreamModel = ZHIPU_MODEL_MAP[request.unifiedModel];
    if (!upstreamModel) {
      return {
        status: 400,
        committed: false,
        usage: zeroUsage(),
        error: "model_not_mapped",
      };
    }

    const outcome = await this.caller(resource, mappedRequest, attemptNo);
    // 错误归一化由调用方按 outcome.status/error 处理（TRD §9）；此处透传结果
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
   * 解析智谱 usage 为原始口径（TRD §7.2 行 482）。
   * 智谱 OpenAI 兼容入口返回 prompt_tokens/completion_tokens/total_tokens；
   * Coding Plan 不区分缓存命中分项，cache 兜底 0。
   * 倍数折算不在 Adapter 内进行（归 W13 版本化规则）。
   */
  parseUsage(raw: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  }): Usage {
    return {
      input: raw.prompt_tokens,
      output: raw.completion_tokens,
      cache: 0, // 智谱 Coding Plan 当前无缓存命中分项
      quality: "PROVIDER_REPORTED",
    };
  }
}

function zeroUsage(): Usage {
  return { input: 0, output: 0, cache: 0, quality: "UNKNOWN" };
}
