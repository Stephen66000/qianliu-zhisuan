import type { Outcome, Usage } from "@qianliu/contracts";
import type { AdapterRequest } from "./index.js";
import type { ChatToolCall, HttpResponseLike, UpstreamMessage } from "./openai-compatible-types.js";
import {
  chatAssistantToResponsesOutput, contentToText, integerValue, isRecord,
  reasoningFieldExtensions, stringValue,
} from "./openai-compatible-conversion.js";
import type { LayeredTimeout } from "./openai-compatible-timeout.js";

export async function parseJsonResponse(
  response: HttpResponseLike,
  request: AdapterRequest,
  timeout: LayeredTimeout,
): Promise<Outcome> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    const cancelled = request.abort?.aborted === true;
    if (cancelled || timeout.timedOut) {
      const failure = timeout.failure(cancelled);
      return {
        ...failedOutcome(failure.status, failure.code),
        firstByteAt: timeout.firstByteAt,
        failureLayer: failure.layer,
        cancelled,
      };
    }
    return {
      ...failedOutcome(0, "upstream_invalid_json"),
      firstByteAt: timeout.firstByteAt,
      failureLayer: "UPSTREAM_PROTOCOL",
    };
  }
  const root = isRecord(payload) ? payload : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const usage = normalizeUsage(root.usage);
  if (!isRecord(firstChoice.message) || usage === null) {
    // HTTP 200 但缺少 Chat Completion 必需事实时不能伪装为成功/零用量。
    return {
      ...failedOutcome(0, "upstream_invalid_response"),
      firstByteAt: timeout.firstByteAt,
      failureLayer: "UPSTREAM_PROTOCOL",
    };
  }
  const message = firstChoice.message as UpstreamMessage;
  const responseReasoningExtensions = reasoningFieldExtensions(message);

  return {
    status: response.status,
    committed: true,
    usage,
    firstByteAt: timeout.firstByteAt,
    responseOutput: chatAssistantToResponsesOutput(message, request.requestId),
    ...(responseReasoningExtensions ? { responseReasoningExtensions } : {}),
  };
}

export async function parseStreamingResponse(
  response: HttpResponseLike,
  request: AdapterRequest,
  timeout: LayeredTimeout,
): Promise<Outcome> {
  if (!response.body) {
    timeout.dispose();
    return {
      ...failedOutcome(0, "upstream_empty_stream"),
      failureLayer: "UPSTREAM_PROTOCOL",
    };
  }

  let text = "";
  let usage: Usage = zeroUsage();
  const calls = new Map<number, ChatToolCall>();
  let sawPartialOutput = false;
  let sawDone = false;
  let sawUsage = false;
  let forwarded = false;
  try {
    for await (const data of readSseData(response.body, () => timeout.markChunk())) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        // caller 尚未向北向提交任何事件；任一损坏 data 都可能是被截断的正文，
        // 不能静默跳过后再用后续 usage/[DONE] 伪装成完整成功。
        timeout.dispose();
        return streamFailure(usage, sawPartialOutput, forwarded, false, timeout);
      }
      const root = isRecord(payload) ? payload : {};
      if (root.usage !== undefined) {
        const reportedUsage = normalizeUsage(root.usage);
        // OpenAI-compatible 流的普通 delta 可能带 usage:null；只有同时含合法
        // prompt_tokens/completion_tokens 的对象才是可结算的最终 Usage。
        if (reportedUsage !== null) {
          usage = reportedUsage;
          sawUsage = true;
        }
      }
      if (root.error !== undefined) {
        timeout.dispose();
        return streamFailure(usage, sawPartialOutput, forwarded, false, timeout);
      }

      // 先转发完整 data 事件，再继续聚合计量与工具调用。回调不做持久化。
      if (request.onStreamChunk) {
        await request.onStreamChunk(root);
        forwarded = true;
      }

      const choices = Array.isArray(root.choices) ? root.choices : [];
      for (const rawChoice of choices) {
        const choice = isRecord(rawChoice) ? rawChoice : {};
        const delta = isRecord(choice.delta) ? choice.delta : {};
        const content = contentToText(delta.content);
        if (content) {
          text += content;
          sawPartialOutput = true;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawToolCall of delta.tool_calls) {
            const toolCall = isRecord(rawToolCall) ? rawToolCall : {};
            const index = integerValue(toolCall.index);
            const previous = calls.get(index) ?? {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            const fn = isRecord(toolCall.function) ? toolCall.function : {};
            previous.id += stringValue(toolCall.id);
            previous.function.name += stringValue(fn.name);
            previous.function.arguments += stringValue(fn.arguments);
            calls.set(index, previous);
            sawPartialOutput = true;
          }
        }
      }
    }
  } catch {
    const cancelled = request.abort?.aborted === true;
    const failure = streamFailure(
      usage,
      sawPartialOutput,
      forwarded,
      cancelled,
      timeout,
    );
    timeout.dispose();
    return failure;
  }

  // Chat / Messages 通过 onStreamChunk 已逐事件提交；Responses 暂无原生透传，
  // 仍由 caller 聚合后做受限转换。无 [DONE] 的正常 EOF 一律按中断处理。
  if (!sawDone) {
    const failure = streamFailure(usage, sawPartialOutput, forwarded, false, timeout);
    timeout.dispose();
    return failure;
  }
  // 所有真实 caller 都请求 stream_options.include_usage。若流虽发出 [DONE] 却没有
  // 最终 usage，不能把零值冒充厂商精确计量；按不完整流在北向提交前失败并允许切换。
  if (!sawUsage) {
    const failure = streamFailure(usage, sawPartialOutput, forwarded, false, timeout);
    timeout.dispose();
    return failure;
  }

  const message: UpstreamMessage = {
    content: text,
    tool_calls: [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call),
  };
  const outcome: Outcome = {
    status: response.status,
    committed: true,
    usage,
    firstByteAt: timeout.firstByteAt,
    responseOutput: chatAssistantToResponsesOutput(message, request.requestId),
  };
  timeout.dispose();
  return outcome;
}

function streamFailure(
  usage: Usage,
  sawPartialOutput: boolean,
  forwarded: boolean,
  cancelled: boolean,
  timeout: LayeredTimeout,
): Outcome {
  const hasReportedUsage = usage.input > 0
    || usage.output > 0
    || usage.cache > 0
    || (usage.reasoning ?? 0) > 0;
  const timeoutFailure = timeout.failure(cancelled);
  const error = cancelled
    ? "client_cancelled"
    : timeout.timedOut
      ? "upstream_timeout"
      : forwarded
        ? "stream_interrupted_after_commit"
        : "transport_error";
  return {
    ...failedOutcome(timeout.timedOut ? 504 : 0, error),
    committed: forwarded,
    // 中断流的最终厂商计量可能不完整；保留已收到的数值，但明确降级为估算，
    // 让 failover 前置 Attempt 仍可独立入账且不会冒充厂商最终精确值。
    usage: sawPartialOutput || hasReportedUsage
      ? { ...usage, quality: "ESTIMATED" }
      : usage,
    firstByteAt: timeout.firstByteAt,
    lastByteAt: timeout.lastChunkAt,
    failureLayer: timeout.timedOut
      ? timeoutFailure.layer
      : cancelled
        ? "CLIENT"
        : "UPSTREAM_NETWORK",
    cancelled,
  };
}

async function* readSseData(
  body: AsyncIterable<Uint8Array>,
  onChunk: () => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    // 对累计缓冲区归一化，覆盖 "\r" / "\n" 恰好跨 TCP chunk 的边界。
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data) yield data;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const data = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data) yield data;
}

function normalizeUsage(raw: unknown): Usage | null {
  if (
    !isRecord(raw)
    || !isNonNegativeTokenCount(raw.prompt_tokens)
    || !isNonNegativeTokenCount(raw.completion_tokens)
  ) {
    return null;
  }
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const outputDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : {};
  const total = optionalToken(raw.total_tokens);
  const cache = firstOptionalToken(
    raw.prompt_cache_hit_tokens, details.cached_tokens, raw.cached_tokens,
  );
  const reasoning = firstOptionalToken(
    outputDetails.reasoning_tokens, raw.reasoning_tokens,
  );
  if (!total.valid || !cache.valid || !reasoning.valid) return null;
  return {
    input: raw.prompt_tokens,
    output: raw.completion_tokens,
    cache: cache.value,
    reasoning: reasoning.value,
    quality: cache.present && reasoning.present ? "PROVIDER_REPORTED" : "MIXED",
  };
}

function optionalToken(value: unknown): { present: boolean; valid: boolean; value: number } {
  if (value === undefined) return { present: false, valid: true, value: 0 };
  return isNonNegativeTokenCount(value)
    ? { present: true, valid: true, value }
    : { present: true, valid: false, value: 0 };
}

function firstOptionalToken(...values: unknown[]): { present: boolean; valid: boolean; value: number } {
  const selected = values.find((value) => value !== undefined);
  return optionalToken(selected);
}

function isNonNegativeTokenCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cache: 0,
    reasoning: 0,
    quality: "UNKNOWN",
  };
}

export function failedOutcome(status: number, error: string): Outcome {
  return {
    status,
    committed: false,
    usage: zeroUsage(),
    error,
  };
}
