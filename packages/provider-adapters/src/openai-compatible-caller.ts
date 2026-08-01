/**
 * OpenAI-compatible Provider HTTP caller.
 *
 * DeepSeek、智谱 Coding Plan、Kimi Coding Plan 均从 Chat Completions 兼容入口调用。
 * 北向 Responses 的正文只在内存中转换，不进入日志或账本：
 * Responses input/tools/function_call_output -> Chat messages/tools/tool_calls；
 * Chat assistant content/tool_calls -> Responses output items。
 */
import type { Outcome, ResponsesRequest, Usage } from "@qianliu/contracts";
import { fetch as undiciFetch } from "undici";
import {
  decryptCredential,
  type EncryptedCredential,
} from "./crypto.js";
import {
  SecretValue,
  type AdapterRequest,
  type AdapterResource,
  type UpstreamCaller,
} from "./index.js";

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

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}

export type HttpFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<HttpResponseLike>;

export interface OpenAiCompatibleCallerOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: HttpFetch;
  requestTimeoutMs?: number;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  reasoning_effort?: string;
}

interface UpstreamMessage {
  content?: unknown;
  tool_calls?: unknown;
}

/**
 * 创建真实 HTTP caller。未配置凭证或厂商 Base URL 时明确失败，不返回模拟内容。
 */
export function createOpenAiCompatibleCaller(
  options: OpenAiCompatibleCallerOptions = {},
): UpstreamCaller {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? defaultFetch;
  const timeoutMs = options.requestTimeoutMs ?? 120_000;

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
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.abort
      ? AbortSignal.any([request.abort, timeout])
      : timeout;

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
        signal,
      });
    } catch {
      const cancelled = request.abort?.aborted === true;
      return {
        ...failedOutcome(0, cancelled ? "client_cancelled" : "transport_error"),
        cancelled,
      };
    }

    if (!response.ok) {
      const failure = await upstreamFailure(response, resource.providerCode);
      return {
        ...failedOutcome(response.status, failure.code),
        upstreamErrorKind: failure.kind,
        upstreamCode: failure.code,
        unifiedAvailabilitySignal: failure.signal,
        ...(failure.recoverAt === undefined ? {} : { recoverAt: failure.recoverAt }),
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs }),
      };
    }

    if (request.stream) {
      return parseStreamingResponse(response, request);
    }
    return parseJsonResponse(response, request);
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
  const messages = messagesValue
    .map(normalizeExistingChatMessage)
    .filter((message): message is ChatMessage => message !== null);
  if (
    request.capability === "messages"
    && body
    && typeof body.system === "string"
    && body.system.length > 0
  ) {
    messages.unshift({ role: "system", content: body.system });
  }
  const tools = body && Array.isArray(body.tools)
    ? body.tools.map((tool) => request.capability === "messages"
      ? anthropicToolToChatTool(tool)
      : tool)
    : undefined;

  return {
    model: resource.upstreamModel,
    messages,
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true as const } } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(body?.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
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
): Promise<Outcome> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failedOutcome(0, "upstream_invalid_json");
  }
  const root = isRecord(payload) ? payload : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const usage = normalizeUsage(root.usage);
  if (!isRecord(firstChoice.message) || usage === null) {
    // HTTP 200 但缺少 Chat Completion 必需事实时不能伪装为成功/零用量。
    return failedOutcome(0, "upstream_invalid_response");
  }
  const message = firstChoice.message as UpstreamMessage;

  return {
    status: response.status,
    committed: true,
    usage,
    responseOutput: chatAssistantToResponsesOutput(message, request.requestId),
  };
}

async function parseStreamingResponse(
  response: HttpResponseLike,
  request: AdapterRequest,
): Promise<Outcome> {
  if (!response.body) return failedOutcome(0, "upstream_empty_stream");

  let text = "";
  let usage: Usage = zeroUsage();
  const calls = new Map<number, ChatToolCall>();
  let sawPartialOutput = false;
  let sawDone = false;
  let sawUsage = false;
  try {
    for await (const data of readSseData(response.body)) {
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
        return bufferedStreamFailure(usage, sawPartialOutput, false);
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
        return bufferedStreamFailure(usage, sawPartialOutput, false);
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
    return bufferedStreamFailure(
      usage,
      sawPartialOutput,
      request.abort?.aborted === true,
    );
  }

  // caller 会先完整聚合上游流，随后 Gateway 才开始向北向输出 Responses SSE。
  // 因此看到上游 delta 不等于“已向下游提交”；无 [DONE] 的正常 EOF 也按中断处理，
  // committed=false 允许 pipeline 安全切换到下一资源，不会拼接两家输出。
  if (!sawDone) {
    return bufferedStreamFailure(usage, sawPartialOutput, false);
  }
  // 所有真实 caller 都请求 stream_options.include_usage。若流虽发出 [DONE] 却没有
  // 最终 usage，不能把零值冒充厂商精确计量；按不完整流在北向提交前失败并允许切换。
  if (!sawUsage) {
    return bufferedStreamFailure(usage, sawPartialOutput, false);
  }

  const message: UpstreamMessage = {
    content: text,
    tool_calls: [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call),
  };
  return {
    status: response.status,
    committed: true,
    usage,
    responseOutput: chatAssistantToResponsesOutput(message, request.requestId),
  };
}

function bufferedStreamFailure(
  usage: Usage,
  sawPartialOutput: boolean,
  cancelled: boolean,
): Outcome {
  const hasReportedUsage = usage.input > 0
    || usage.output > 0
    || usage.cache > 0
    || (usage.reasoning ?? 0) > 0;
  return {
    ...failedOutcome(0, cancelled ? "client_cancelled" : "transport_error"),
    committed: false,
    // 中断流的最终厂商计量可能不完整；保留已收到的数值，但明确降级为估算，
    // 让 failover 前置 Attempt 仍可独立入账且不会冒充厂商最终精确值。
    usage: sawPartialOutput || hasReportedUsage
      ? { ...usage, quality: "ESTIMATED" }
      : usage,
    cancelled,
  };
}

async function* readSseData(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
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

function anthropicToolToChatTool(raw: unknown): unknown {
  const tool = isRecord(raw) ? raw : {};
  return {
    type: "function",
    function: {
      name: stringValue(tool.name),
      ...(typeof tool.description === "string"
        ? { description: tool.description }
        : {}),
      ...(tool.input_schema !== undefined
        ? { parameters: tool.input_schema }
        : {}),
    },
  };
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
  return {
    input: nonNegativeNumber(raw.prompt_tokens),
    output: nonNegativeNumber(raw.completion_tokens),
    cache: nonNegativeNumber(
      raw.prompt_cache_hit_tokens ?? details.cached_tokens,
    ),
    reasoning: nonNegativeNumber(
      outputDetails.reasoning_tokens ?? raw.reasoning_tokens,
    ),
    quality: "PROVIDER_REPORTED",
  };
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

async function upstreamFailure(response: HttpResponseLike, providerCode: ProviderCode): Promise<{
  code: string;
  kind: NonNullable<Outcome["upstreamErrorKind"]>;
  signal: NonNullable<Outcome["unifiedAvailabilitySignal"]>;
  retryAfterMs?: number;
  recoverAt?: string;
}> {
  let code = `upstream_http_${response.status}`;
  let message = "";
  let resetValue: unknown;
  try {
    const payload = await response.json();
    const root = isRecord(payload) ? payload : {};
    const error = isRecord(root.error) ? root.error : {};
    code = stringValue(error.code) || stringValue(error.type) || code;
    message = [
      stringValue(error.message),
      stringValue(root.message),
      code,
    ].filter(Boolean).join(" ");
    resetValue = error.resetTime ?? error.reset_time ?? error.next_flush_time
      ?? root.resetTime ?? root.reset_time ?? root.next_flush_time;
  } catch {
    // 非 JSON 错误仍保留 HTTP 状态语义，不读取/持久化原始正文。
  }
  const kind = response.status === 429 ? classifyRateLimit(message) : "UNKNOWN";
  const retry = parseRetryAfter(response.headers?.get("retry-after") ?? null);
  const recoverAt = parseRecoverAt(resetValue) ??
    (retry.retryAfterMs === undefined ? undefined : new Date(Date.now() + retry.retryAfterMs).toISOString());
  return {
    code,
    kind,
    signal: classifyAvailabilitySignal(providerCode, response.status, code, kind, recoverAt),
    ...retry,
    ...(recoverAt === undefined ? {} : { recoverAt }),
  };
}

function classifyAvailabilitySignal(
  providerCode: ProviderCode,
  status: number,
  code: string,
  kind: NonNullable<Outcome["upstreamErrorKind"]>,
  recoverAt?: string,
): NonNullable<Outcome["unifiedAvailabilitySignal"]> {
  if (providerCode === "zhipu") {
    if (code === "1211") return "CONFIGURATION_ERROR";
    if (code === "1308" || code === "1310") return "QUOTA_EXHAUSTED";
    if (code === "1309") return "PLAN_EXPIRED";
    if (code === "1311") return "MODEL_UNAUTHORIZED";
    if (code === "1302" || code === "1305") return "TECHNICAL_FAILURE";
  }
  if (status === 429) {
    if ((kind === "WINDOW_EXHAUSTED" || kind === "QUOTA_EXHAUSTED") && recoverAt) {
      return "QUOTA_EXHAUSTED";
    }
    if (kind === "ENGINE_OVERLOADED" || kind === "CONCURRENCY_LIMITED") return "TECHNICAL_FAILURE";
    return recoverAt ? "RATE_LIMIT_RETRY_AFTER" : "TECHNICAL_FAILURE";
  }
  if (status >= 500 || status === 0) return "TECHNICAL_FAILURE";
  if (status >= 400 && status < 500) return "CONFIGURATION_ERROR";
  return "TECHNICAL_FAILURE";
}

function parseRecoverAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof value !== "string" || value.length > 128) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") return parseRecoverAt(numeric);
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
}

function classifyRateLimit(message: string): NonNullable<Outcome["upstreamErrorKind"]> {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("engine is overloaded")
    || normalized.includes("engine overloaded")
    || normalized.includes("server overloaded")
  ) return "ENGINE_OVERLOADED";
  if (
    normalized.includes("concurrent")
    || normalized.includes("too many requests")
    || normalized.includes("frequency limit")
  ) return "CONCURRENCY_LIMITED";
  if (
    normalized.includes("5-hour")
    || normalized.includes("5 hour")
    || normalized.includes("five-hour")
    || normalized.includes("rolling window")
  ) return "WINDOW_EXHAUSTED";
  if (
    normalized.includes("monthly quota")
    || normalized.includes("quota exhausted")
    || normalized.includes("quota limit")
  ) return "QUOTA_EXHAUSTED";
  return "UNKNOWN";
}

function parseRetryAfter(value: string | null): { retryAfterMs?: number } {
  if (!value) return {};
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.ceil(seconds * 1_000) };
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return {};
  return { retryAfterMs: Math.max(0, date - Date.now()) };
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

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
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
