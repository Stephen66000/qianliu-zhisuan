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

/**
 * 强制脱敏的凭证包装。
 * 任何 JSON.stringify/toString 都返回 [REDACTED]，明文只能通过 reveal() 取出。
 * 依据：PoC provider-secrets.mjs SecretValue；TRD §14.2 行 784（管理 API 不返回上游 Secret）。
 */
export class SecretValue {
  #value: string;
  #redacted = "[REDACTED]";

  constructor(value: string) {
    this.#value = value;
  }

  /** 取明文。调用方负责不写入日志/Trace/DB。 */
  reveal(): string {
    return this.#value;
  }

  /** 是否已配置（非空）。 */
  isConfigured(): boolean {
    return this.#value.length > 0;
  }

  /** 强制脱敏。 */
  toString(): string {
    return this.#redacted;
  }

  toJSON(): string {
    return this.#redacted;
  }

  /** 用于显示的指纹（前 4 位 + 长度，不泄露可还原信息）。 */
  fingerprint(): string {
    if (this.#value.length === 0) return "[EMPTY]";
    const head = this.#value.slice(0, 4);
    return `${head}…(len=${this.#value.length})`;
  }
}

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
  /** 请求正文载荷（仅内存传递；Adapter 不得持久化）。 */
  body: unknown;
  /** 客户端断开信号（AbortSignal），用于取消。 */
  abort?: AbortSignal;
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
