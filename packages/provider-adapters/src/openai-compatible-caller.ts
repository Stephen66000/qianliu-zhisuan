/**
 * OpenAI-compatible Provider HTTP caller.
 *
 * DeepSeek、智谱 Coding Plan、Kimi Coding Plan 均从 Chat Completions 兼容入口调用。
 * 北向 Responses 的正文只在内存中转换，不进入日志或账本：
 * Responses input/tools/function_call_output -> Chat messages/tools/tool_calls；
 * Chat assistant content/tool_calls -> Responses output items。
 */
import type {
  Outcome,
  ResponsesRequest,
  Usage,
} from "@qianliu/contracts";
import { fetch as undiciFetch } from "undici";
import { decryptCredential, type EncryptedCredential } from "./crypto.js";
import { SecretValue } from "./secret-value.js";
import {
  type AdapterRequest,
  type AdapterResource,
  type UpstreamCaller,
} from "./index.js";
import type {
  ChatCompletionBody,
  ChatMessage,
  ChatToolCall,
  HttpFetch,
  HttpResponseLike,
  OpenAiCompatibleCallerOptions,
  UpstreamMessage,
} from "./openai-compatible-types.js";
import { resolveFirstByteTimeoutMs, resolveStreamIdleTimeoutMs } from "./resource-timeout-policy.js";
import { buildRequestShapeSummary } from "./upstream-error-evidence.js";
import { upstreamFailure } from "./upstream-failure.js";

export type { HttpFetch, HttpResponseLike, OpenAiCompatibleCallerOptions } from "./openai-compatible-types.js";

type ProviderCode = AdapterResource["providerCode"];

const BASE_URL_ENV: Record<ProviderCode, string> = {
  deepseek: "DEEPSEEK_BASE_URL",
  zhipu: "ZHIPU_CODING_BASE_URL",
  kimi: "KIMI_CODING_BASE_URL",
};

const SECRET_ENV: Record<ProviderCode, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  zhipu: "ZHIPU_CODING_TOKEN",
  kimi: "KIMI_CODING_TOKEN",
};

const DEFAULT_BASE_URL: Record<ProviderCode, string> = {
  deepseek: "https://api.deepseek.com",
  zhipu: "https://open.bigmodel.cn/api/coding/paas/v4",
  kimi: "https://api.kimi.com/coding/v1",
};

/**
 * 创建真实 HTTP caller。未配置凭证或厂商 Base URL 时明确失败，不返回模拟内容。
 */
export function createOpenAiCompatibleCaller(
  options: OpenAiCompatibleCallerOptions = {},
): UpstreamCaller {
  const { env = process.env, fetch: fetchImpl = defaultFetch } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60_000;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 30_000;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 45_000;

  return async (resource, request) => {
    if (!resource.secret.isConfigured()) {
      return failedOutcome(401, "upstream_credential_missing");
    }

    const baseUrl = env[BASE_URL_ENV[resource.providerCode]]
      ?? DEFAULT_BASE_URL[resource.providerCode];
    if (!baseUrl) {
      return failedOutcome(500, "upstream_base_url_missing");
    }

    const chatBody = toChatCompletionsRequest(resource, request);
    const timeout = createLayeredTimeout({
      requestAbort: request.abort,
      requestTimeoutMs,
      firstByteTimeoutMs: resolveFirstByteTimeoutMs(resource, firstByteTimeoutMs, options.firstByteTimeoutMsForResource),
      streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resource, streamIdleTimeoutMs, options.streamIdleTimeoutMsForResource),
    });

    let response: HttpResponseLike;
    try {
      response = await fetchImpl(chatCompletionsUrl(baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${resource.secret.reveal()}`,
          "content-type": "application/json",
          accept: request.stream ? "text/event-stream" : "application/json",
          "x-request-id": request.requestId,
        },
        body: JSON.stringify(chatBody),
        signal: timeout.signal,
      });
    } catch {
      const cancelled = request.abort?.aborted === true;
      const failure = timeout.failure(cancelled);
      timeout.dispose();
      return {
        ...failedOutcome(failure.status, failure.code),
        failureLayer: failure.layer,
        cancelled,
      };
    }

    if (!response.ok) {
      timeout.markFirstByte();
      const requestShapeSummary = response.status === 400
        ? buildRequestShapeSummary(chatBody)
        : null;
      const failure = await upstreamFailure(
        response,
        resource.providerCode,
        requestShapeSummary,
      );
      timeout.dispose();
      return {
        ...failedOutcome(response.status, failure.code),
        upstreamErrorKind: failure.kind,
        upstreamCode: failure.code,
        ...(failure.evidence && requestShapeSummary ? {
          upstreamErrorEvidence: failure.evidence,
          requestShapeSummary,
        } : {}),
        unifiedAvailabilitySignal: failure.signal,
        firstByteAt: timeout.firstByteAt,
        failureLayer: "UPSTREAM_HTTP",
        ...(failure.recoverAt === undefined ? {} : { recoverAt: failure.recoverAt }),
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs }),
      };
    }

    if (request.stream) {
      return parseStreamingResponse(response, request, timeout);
    }
    timeout.markFirstByte();
    const outcome = await parseJsonResponse(response, request, timeout);
    timeout.dispose();
    return outcome;
  };
}

/**
 * 从资源密文读取凭证；历史环境变量仅作为“资源尚未录入密文”的兼容回退。
 * 密文存在但损坏时不会回退到环境变量，避免掩盖错误资源配置。
 */
export function resolveProviderSecret(input: {
  providerCode: ProviderCode;
  credentialCiphertext: string | Partial<EncryptedCredential> | null;
  credentialKek: Buffer;
  env?: NodeJS.ProcessEnv;
}): SecretValue {
  if (input.credentialCiphertext) {
    try {
      // PostgreSQL jsonb 驱动通常返回对象；部分旧夹具/仓储类型仍声明为字符串。
      const parsed = typeof input.credentialCiphertext === "string"
        ? JSON.parse(input.credentialCiphertext) as Partial<EncryptedCredential>
        : input.credentialCiphertext;
      if (
        typeof parsed.ciphertext !== "string"
        || typeof parsed.nonce !== "string"
        || typeof parsed.tag !== "string"
      ) {
        return new SecretValue("");
      }
      return new SecretValue(decryptCredential(parsed as EncryptedCredential, input.credentialKek));
    } catch {
      return new SecretValue("");
    }
  }

  const env = input.env ?? process.env;
  return new SecretValue(env[SECRET_ENV[input.providerCode]] ?? "");
}

/** Responses / Chat / Messages 北向载荷统一转换为上游 Chat Completions。 */
export function toChatCompletionsRequest(
  resource: AdapterResource,
  request: AdapterRequest,
): ChatCompletionBody {
  if (request.capability === "responses") {
    return responsesToChatCompletions(
      request.body as ResponsesRequest,
      resource.upstreamModel,
      request.stream,
    );
  }

  const raw = request.body;
  const body = isRecord(raw) ? raw : null;
  const messagesValue = Array.isArray(raw)
    ? raw
    : body && Array.isArray(body.messages)
      ? body.messages
      : [];
  const messages = request.capability === "messages"
    ? messagesValue.flatMap(anthropicMessageToChatMessages)
    : messagesValue
      .map(normalizeExistingChatMessage)
      .filter((message): message is ChatMessage => message !== null);
  if (
    request.capability === "messages"
    && body
    && body.system !== undefined
  ) {
    const system = contentToText(body.system);
    if (system.length > 0) messages.unshift({ role: "system", content: system });
  }
  const tools = body && Array.isArray(body.tools)
    ? body.tools.map((tool) => request.capability === "messages"
      ? anthropicToolToChatTool(tool)
      : tool)
      .filter((tool) => tool !== null)
    : undefined;

  const toolChoice = body?.tool_choice === undefined
    ? undefined
    : request.capability === "messages"
      ? anthropicToolChoiceToChat(body.tool_choice)
      : body.tool_choice;
  const parallelToolCalls = request.capability === "messages"
    && isRecord(body?.tool_choice)
    && typeof body.tool_choice.disable_parallel_tool_use === "boolean"
    ? !body.tool_choice.disable_parallel_tool_use
    : undefined;

  return {
    model: resource.upstreamModel,
    messages,
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true as const } } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
  };
}

/** 官方 Responses 输入到 OpenAI-compatible Chat Completions 的确定性转换。 */
export function responsesToChatCompletions(
  request: ResponsesRequest,
  upstreamModel: string,
  stream = request.stream ?? false,
): ChatCompletionBody {
  const messages: ChatMessage[] = [];
  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
  } else {
    for (const item of request.input) {
      appendResponseInputItem(messages, item);
    }
  }

  // Responses 还可能携带 OpenAI 托管工具（如 web_search）以及 Codex 的
  // namespace 工具组。Chat Completions 上游无法执行这两类工具，不能把它们
  // 伪装成空名称 function；只下发可由客户端回传结果的标准函数工具。
  const tools = request.tools
    ?.filter((tool) => tool.type === "function")
    .map(responseToolToChatTool)
    .filter((tool): tool is unknown => tool !== null);
  return {
    model: upstreamModel,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true as const } } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(request.tool_choice !== undefined
      ? { tool_choice: responseToolChoiceToChat(request.tool_choice) }
      : {}),
    ...(request.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: request.parallel_tool_calls }
      : {}),
    ...(request.max_output_tokens !== undefined
      ? { max_tokens: request.max_output_tokens }
      : {}),
    ...(request.reasoning?.effort
      ? { reasoning_effort: request.reasoning.effort }
      : {}),
  };
}

/** 上游 assistant 内容/工具调用转换为 Responses output。 */
export function chatAssistantToResponsesOutput(
  message: UpstreamMessage,
  requestId: string,
): unknown[] {
  const output: unknown[] = [];
  const text = contentToText(message.content);
  if (text.length > 0) {
    output.push({
      id: `msg_${requestId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text,
        annotations: [],
        logprobs: [],
      }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((rawCall, index) => {
      const call = isRecord(rawCall) ? rawCall : {};
      const fn = isRecord(call.function) ? call.function : {};
      const callId = stringValue(call.id) || `call_${requestId}_${index}`;
      output.push({
        id: `fc_${requestId}_${index}`,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: stringValue(fn.name) || "tool",
        arguments: argumentString(fn.arguments),
      });
    });
  }

  if (output.length === 0) {
    output.push({
      id: `msg_${requestId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "",
        annotations: [],
        logprobs: [],
      }],
    });
  }
  return output;
}

async function parseJsonResponse(
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

  return {
    status: response.status,
    committed: true,
    usage,
    firstByteAt: timeout.firstByteAt,
    responseOutput: chatAssistantToResponsesOutput(message, request.requestId),
  };
}

async function parseStreamingResponse(
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

function appendResponseInputItem(
  messages: ChatMessage[],
  item: Record<string, unknown>,
): void {
  const type = stringValue(item.type);
  if (type === "function_call") {
    const call: ChatToolCall = {
      id: stringValue(item.call_id) || stringValue(item.id) || `call_${messages.length}`,
      type: "function",
      function: {
        name: stringValue(item.name) || "tool",
        arguments: argumentString(item.arguments),
      },
    };
    const previous = messages.at(-1);
    if (previous?.role === "assistant" && previous.tool_calls) {
      previous.tool_calls.push(call);
    } else {
      messages.push({ role: "assistant", content: null, tool_calls: [call] });
    }
    return;
  }
  if (type === "function_call_output") {
    messages.push({
      role: "tool",
      tool_call_id: stringValue(item.call_id),
      content: contentToText(item.output),
    });
    return;
  }

  const role = normalizeRole(item.role);
  if (role) {
    messages.push({ role, content: responseContentToChatContent(item.content) });
  }
}

function responseToolToChatTool(rawTool: Record<string, unknown>): unknown | null {
  if (isRecord(rawTool.function)) {
    return stringValue(rawTool.function.name) ? rawTool : null;
  }
  const name = stringValue(rawTool.name);
  if (!name) return null;
  return {
    type: "function",
    function: {
      name,
      ...(typeof rawTool.description === "string"
        ? { description: rawTool.description }
        : {}),
      ...(rawTool.parameters !== undefined
        ? { parameters: rawTool.parameters }
        : {}),
      ...(typeof rawTool.strict === "boolean"
        ? { strict: rawTool.strict }
        : {}),
    },
  };
}

function anthropicToolToChatTool(raw: unknown): unknown | null {
  const tool = isRecord(raw) ? raw : {};
  const name = stringValue(tool.name);
  if (!name) return null;
  return {
    type: "function",
    function: {
      name,
      ...(typeof tool.description === "string"
        ? { description: tool.description }
        : {}),
      ...(tool.input_schema !== undefined
        ? { parameters: tool.input_schema }
        : { parameters: { type: "object", properties: {} } }),
    },
  };
}

function anthropicToolChoiceToChat(choice: unknown): unknown {
  if (!isRecord(choice)) return choice;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return choice;
}

function responseToolChoiceToChat(choice: unknown): unknown {
  if (!isRecord(choice) || choice.type !== "function" || typeof choice.name !== "string") {
    return choice;
  }
  return { type: "function", function: { name: choice.name } };
}

function responseContentToChatContent(content: unknown): unknown {
  if (!Array.isArray(content)) return contentToText(content);
  const converted = content.flatMap((rawPart): unknown[] => {
    const part = isRecord(rawPart) ? rawPart : {};
    const type = stringValue(part.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      return [{ type: "text", text: stringValue(part.text) }];
    }
    if (type === "input_image" && typeof part.image_url === "string") {
      return [{ type: "image_url", image_url: { url: part.image_url } }];
    }
    return [];
  });
  return converted.length > 0 ? converted : contentToText(content);
}

function normalizeExistingChatMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  const role = normalizeRole(raw.role);
  if (!role) return null;
  return {
    role,
    content: raw.content ?? "",
    ...(typeof raw.tool_call_id === "string"
      ? { tool_call_id: raw.tool_call_id }
      : {}),
    ...(Array.isArray(raw.tool_calls)
      ? { tool_calls: raw.tool_calls as ChatToolCall[] }
      : {}),
  };
}

/** Anthropic Messages 内容块展开为 OpenAI Chat Completions 消息。 */
function anthropicMessageToChatMessages(raw: unknown): ChatMessage[] {
  if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant")) return [];
  if (!Array.isArray(raw.content)) {
    return [{ role: raw.role, content: contentToText(raw.content) }];
  }

  if (raw.role === "assistant") {
    const toolCalls = raw.content.flatMap((item): ChatToolCall[] => {
      if (!isRecord(item) || item.type !== "tool_use") return [];
      const id = stringValue(item.id);
      const name = stringValue(item.name);
      if (!id || !name) return [];
      return [{
        id,
        type: "function",
        function: { name, arguments: argumentString(item.input) },
      }];
    });
    const text = contentToText(raw.content.filter((item) => (
      !isRecord(item) || item.type !== "tool_use"
    )));
    return [{
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }];
  }

  const messages: ChatMessage[] = [];
  const nonToolResultParts: unknown[] = [];
  for (const item of raw.content) {
    if (!isRecord(item) || item.type !== "tool_result") {
      nonToolResultParts.push(item);
      continue;
    }
    const toolCallId = stringValue(item.tool_use_id);
    if (!toolCallId) continue;
    messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: contentToText(item.content),
    });
  }
  const userContent = contentToText(nonToolResultParts);
  if (userContent) messages.push({ role: "user", content: userContent });
  return messages;
}

function normalizeRole(role: unknown): ChatMessage["role"] | null {
  if (role === "developer" || role === "system") return "system";
  if (role === "user" || role === "assistant" || role === "tool") return role;
  return null;
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

function failedOutcome(status: number, error: string): Outcome {
  return {
    status,
    committed: false,
    usage: zeroUsage(),
    error,
  };
}

type TimeoutFailureLayer =
  | "FIRST_BYTE_TIMEOUT"
  | "STREAM_IDLE_TIMEOUT"
  | "REQUEST_TIMEOUT";

interface LayeredTimeout {
  signal: AbortSignal;
  firstByteAt?: number;
  /** 最近一次收到上游原始数据块的时间，超时排障用于推算空闲起点（POOL-034）。 */
  lastChunkAt?: number;
  timedOut: boolean;
  markFirstByte(): void;
  markChunk(): void;
  failure(cancelled: boolean): {
    status: number;
    code: "client_cancelled" | "upstream_timeout" | "transport_error";
    layer: "CLIENT" | "UPSTREAM_NETWORK" | TimeoutFailureLayer;
  };
  dispose(): void;
}

function createLayeredTimeout(input: {
  requestAbort?: AbortSignal;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
}): LayeredTimeout {
  const controller = new AbortController();
  const signal = input.requestAbort
    ? AbortSignal.any([input.requestAbort, controller.signal])
    : controller.signal;
  let firstByteAt: number | undefined;
  let lastChunkAt: number | undefined;
  let timeoutLayer: TimeoutFailureLayer | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const abortFor = (layer: TimeoutFailureLayer) => {
    if (signal.aborted) return;
    timeoutLayer = layer;
    controller.abort(new DOMException(layer, "TimeoutError"));
  };
  const firstByteTimer = setTimeout(
    () => abortFor("FIRST_BYTE_TIMEOUT"),
    input.firstByteTimeoutMs,
  );
  const requestTimer = setTimeout(
    () => abortFor("REQUEST_TIMEOUT"),
    input.requestTimeoutMs,
  );
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortFor("STREAM_IDLE_TIMEOUT"),
      input.streamIdleTimeoutMs,
    );
  };
  const markFirstByte = () => {
    if (firstByteAt !== undefined) return;
    firstByteAt = Date.now();
    clearTimeout(firstByteTimer);
  };

  return {
    signal,
    get firstByteAt() {
      return firstByteAt;
    },
    get lastChunkAt() {
      return lastChunkAt;
    },
    get timedOut() {
      return timeoutLayer !== null;
    },
    markFirstByte,
    markChunk() {
      markFirstByte();
      lastChunkAt = Date.now();
      resetIdle();
    },
    failure(cancelled) {
      if (cancelled) {
        return { status: 0, code: "client_cancelled", layer: "CLIENT" };
      }
      if (timeoutLayer) {
        return { status: 504, code: "upstream_timeout", layer: timeoutLayer };
      }
      return { status: 0, code: "transport_error", layer: "UPSTREAM_NETWORK" };
    },
    dispose() {
      clearTimeout(firstByteTimer);
      clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.text === "string") return item.text;
      return "";
    }).join("");
  }
  if (isRecord(value) && typeof value.text === "string") return value.text;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function argumentString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultFetch: HttpFetch = async (url, init) => {
  const response = await undiciFetch(url, init);
  return response as unknown as HttpResponseLike;
};
