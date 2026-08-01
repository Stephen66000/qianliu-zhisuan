/**
 * Kimi Adapter（W10）。
 *
 * 依据：TRD §7（Adapter 统一能力）、§7.3（Kimi Coding Plan 模式）。
 * W10 阶段：实现能力声明、模型映射、usage 原始口径解析、错误归一化（TRD §9 分类）、
 * 健康检查骨架。生产由 OpenAI-compatible Caller 注入真实 HTTP 调用；
 * 测试通过同一 upstreamCaller 注入脱敏夹具。
 *
 * Coding Plan 计量口径（TRD §7.3 行 488-492）：
 *   - 模式：Coding Plan；一期首用模型 Kimi K3；
 *   - 保存原始 Token／Prompt 和厂商额度口径；
 *   - 「按模型档位配置额度倍数」（如 kimi-for-coding-highspeed 3 倍档）属于模型档位规则，
 *     非分时规则；倍数折算归 W13 版本化计价规则实现；Adapter 本身不做倍数折算，只保原始用量事实。
 *   - 周期、限流窗口和套餐有效期按资源配置保存（归 W11 账号池状态机使用）。
 *
 * usage 维度（TRD §7.3）：Kimi OpenAI 兼容入口返回 prompt_tokens/completion_tokens，
 * 当前公开 Coding Plan 不区分缓存命中分项，cache 兜底为 0。
 */
import type { Outcome, Usage } from "@qianliu/contracts";
import type { ErrorClassification } from "@qianliu/domain";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";
import type { ProviderAdapter, AdapterResource, AdapterRequest } from "../index.js";
import type { UpstreamCaller } from "./deepseek-adapter.js";

export class KimiAdapter implements ProviderAdapter {
  readonly providerCode = "kimi" as const;
  readonly capabilities = new Set([
    "chat",
    "messages",
    "responses",
    "stream",
    "tools",
    "coding_plan", // Coding Plan 模式标识（TRD §7.3）
    // 注：Kimi 当前公开 Coding Plan 不区分 prompt cache 分项，不声明 prompt_cache。
  ]);

  constructor(private caller: UpstreamCaller) {}

  async invoke(
    resource: AdapterResource,
    request: AdapterRequest,
    attemptNo: number,
  ): Promise<Outcome> {
    // 鉴权注入：SecretValue 只在调用器内部 reveal（不写日志/Trace）
    // Web/model_route 允许企业自定义统一别名；resource.upstreamModel 是路由冻结后的
    // 唯一上游模型事实源，Adapter 不再用内置别名表重复门禁。
    const outcome = await this.caller(resource, request, attemptNo);
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
   * 解析 Kimi usage 为原始口径（TRD §7.3）。
   * Kimi OpenAI 兼容入口返回 prompt_tokens/completion_tokens/total_tokens；
   * Coding Plan 不区分缓存命中分项，cache 兜底 0。
   * 模型档位倍数折算不在 Adapter 内进行（归 W13 版本化规则）。
   */
  parseUsage(raw: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  }): Usage {
    return {
      input: raw.prompt_tokens,
      output: raw.completion_tokens,
      cache: 0, // Kimi Coding Plan 当前无缓存命中分项
      quality: "PROVIDER_REPORTED",
    };
  }
}
