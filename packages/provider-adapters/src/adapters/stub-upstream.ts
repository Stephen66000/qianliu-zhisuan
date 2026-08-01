/**
 * StubUpstream —— 离线 Stub 上游（W06 测试基础设施）。
 *
 * 实现 ProviderAdapter 接口，可配置响应模式与故障注入。
 * 用于在没有真实 DeepSeek 凭证时验证 Adapter 的鉴权注入、模型映射、流式解析、
 * usage 解析、错误归一化、取消、健康检查、committed 边界。
 *
 * 依据：W06 DoD「离线夹具通过；真实凭证只影响上线签字」、TRD §7 Adapter 统一能力。
 */
import type { Outcome } from "@qianliu/contracts";
import type { ProviderAdapter, AdapterResource, AdapterRequest } from "../index.js";

/** Stub 响应模式。 */
export type StubMode =
  | { kind: "SUCCESS"; usage: { input: number; output: number; cache: number; reasoning?: number }; content?: string }
  | { kind: "STREAM"; chunks: string[]; usage: { input: number; output: number; cache: number; reasoning?: number }; failAfterChunk?: number }
  | { kind: "ERROR"; status: number; errorCode: string; classification: string }
  | { kind: "TIMEOUT" }
  | { kind: "CANCEL" };

export interface StubUpstreamConfig {
  /** 默认响应模式（未被 calls 配置覆盖时）。 */
  default: StubMode;
  /** 按 attempt 序号配置响应（attemptNo 从 1 开始）。用于双 Attempt 测试。 */
  byAttempt?: Record<number, StubMode>;
  /**
   * 该 Stub 实例代表的厂商上游（W09 起可配，便于智谱/Kimi Adapter 复用同一 Stub 基础设施）。
   * 默认 "deepseek"，保持现有 DeepSeek 测试零改动。
   */
  providerCode?: "deepseek" | "zhipu" | "kimi";
}

/**
 * Stub 上游。invoke 按 attemptNo 返回对应响应。
 * 调用记录在 calls 数组，便于测试断言。
 */
export class StubUpstream implements ProviderAdapter {
  readonly providerCode: "deepseek" | "zhipu" | "kimi";
  readonly capabilities = new Set(["chat", "messages", "stream"]);
  readonly calls: Array<{ resource: AdapterResource; request: AdapterRequest; attemptNo: number }> = [];

  constructor(private config: StubUpstreamConfig) {
    this.providerCode = config.providerCode ?? "deepseek";
  }

  async invoke(
    resource: AdapterResource,
    request: AdapterRequest,
    attemptNo: number,
  ): Promise<Outcome> {
    this.calls.push({ resource, request, attemptNo });
    const mode = this.config.byAttempt?.[attemptNo] ?? this.config.default;

    // 模拟取消检查
    if (request.abort?.aborted) {
      return { status: 0, committed: false, usage: zeroUsage(), error: "client_cancelled", cancelled: true };
    }

    switch (mode.kind) {
      case "SUCCESS":
        return {
          status: 200,
          committed: true,
          usage: { ...mode.usage, quality: "PROVIDER_REPORTED" },
          responseOutput: responseOutputFor(request, mode.content ?? "OK"),
        };
      case "STREAM": {
        // 模拟流式：若有 failAfterChunk，在输出部分 chunk 后失败（committed=true）
        const failedAt = mode.failAfterChunk;
        if (failedAt !== undefined && failedAt > 0) {
          // 已发送 failedAt 个有效 chunk → committed=true 后失败
          return {
            status: 0,
            committed: true,
            usage: { input: mode.usage.input, output: mode.usage.output / 2, cache: mode.usage.cache, quality: "ESTIMATED" },
            error: "stream_interrupted_after_commit",
            cancelled: false,
          };
        }
        return {
          status: 200,
          committed: true,
          usage: { ...mode.usage, quality: "PROVIDER_REPORTED" },
          responseOutput: responseOutputFor(request, mode.chunks.join("")),
        };
      }
      case "ERROR":
        return {
          status: mode.status,
          committed: false,
          usage: zeroUsage(),
          error: mode.errorCode,
        };
      case "TIMEOUT":
        // 模拟超时：返回 0 状态（transport），未提交
        return { status: 0, committed: false, usage: zeroUsage(), error: "transport_error" };
      case "CANCEL":
        return { status: 0, committed: false, usage: zeroUsage(), error: "client_cancelled", cancelled: true };
      default:
        return { status: 500, committed: false, usage: zeroUsage(), error: "unknown" };
    }
  }
}

function zeroUsage() {
  return { input: 0, output: 0, cache: 0, quality: "UNKNOWN" as const };
}

function responseOutputFor(request: AdapterRequest, content: string): unknown[] | undefined {
  if (request.capability !== "responses") return undefined;
  const body = request.body as {
    input?: unknown;
    tools?: Array<{ type?: string; name?: string; function?: { name?: string }; parameters?: unknown }>;
  };
  const input = Array.isArray(body.input) ? body.input : [];
  const hasToolOutput = input.some(
    (item) => typeof item === "object" && item !== null
      && (item as { type?: string }).type === "function_call_output",
  );
  const firstTool = body.tools?.find((tool) => tool.type === "function" || tool.name || tool.function?.name);
  if (firstTool && !hasToolOutput) {
    const name = firstTool.name ?? firstTool.function?.name ?? "tool";
    const args = name === "exec_command"
      ? JSON.stringify({ cmd: "printf 'Codex gateway tool call OK\\n'" })
      : "{}";
    return [{
      id: `fc_${request.requestId}`,
      type: "function_call",
      status: "completed",
      call_id: `call_${request.requestId}`,
      name,
      arguments: args,
    }];
  }
  return [{
    id: `msg_${request.requestId}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [], logprobs: [] }],
  }];
}
