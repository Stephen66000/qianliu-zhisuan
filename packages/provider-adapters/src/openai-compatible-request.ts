import type { ResponsesRequest } from "@qianliu/contracts";
import type { AdapterRequest, AdapterResource } from "./index.js";
import type { ChatCompletionBody, ChatMessage } from "./openai-compatible-types.js";
import {
  anthropicMessageToChatMessages, anthropicToolChoiceToChat, anthropicToolToChatTool,
  appendResponseInputItem, contentToText, isRecord, normalizeExistingChatMessage,
  responseToolChoiceToChat, responseToolToChatTool,
} from "./openai-compatible-conversion.js";

type ProviderCode = AdapterResource["providerCode"];

export function responsesToChatCompletions(
  request: ResponsesRequest,
  upstreamModel: string,
  stream = request.stream ?? false,
  providerCode: ProviderCode = "deepseek",
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
    ...providerRequestExtensions(
      { providerCode, upstreamModel },
      request as unknown as Record<string, unknown>,
      request.reasoning?.effort,
    ),
  };
}


export function toChatCompletionsRequest(
  resource: AdapterResource,
  request: AdapterRequest,
): ChatCompletionBody {
  if (request.capability === "responses") {
    return responsesToChatCompletions(
      request.body as ResponsesRequest,
      resource.upstreamModel,
      request.stream,
      resource.providerCode,
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
  const upstreamMessages = backfillToolReasoning(
    resource,
    tools,
    messages,
  );
  const vendorExtensions = providerRequestExtensions(
    resource,
    body,
    body?.reasoning_effort,
    upstreamMessages,
    tools,
  );

  return {
    model: resource.upstreamModel,
    messages: upstreamMessages,
    stream: request.stream,
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.stream ? { stream_options: { include_usage: true as const } } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
    ...vendorExtensions,
  };
}

/** DeepSeek 与 Kimi K3 的工具续轮对缺失 reasoning_content 做结构兼容。 */
function backfillToolReasoning(
  resource: Pick<AdapterResource, "providerCode" | "upstreamModel">,
  tools: unknown[] | undefined,
  messages: ChatMessage[],
): ChatMessage[] {
  const supportsEmptyReasoning = resource.providerCode === "deepseek"
    || (resource.providerCode === "kimi" && isKimiK3Model(resource.upstreamModel));
  if (!supportsEmptyReasoning || !tools?.length) return messages;
  return messages.map((message) =>
    message.role === "assistant"
      && !Object.prototype.hasOwnProperty.call(message, "reasoning_content")
      ? { ...message, reasoning_content: "" }
      : message
  );
}

function providerRequestExtensions(
  resource: Pick<AdapterResource, "providerCode" | "upstreamModel">,
  body: Record<string, unknown> | null,
  reasoningEffort: unknown,
  messages: ChatMessage[] = [],
  tools?: unknown[],
): Pick<ChatCompletionBody, "reasoning_effort" | "thinking" | "tool_stream"> {
  const normalizedEffort = providerReasoningEffort(resource, reasoningEffort);
  if (resource.providerCode === "zhipu") {
    const extensions = vendorRequestExtensions(body, true, true);
    return {
      ...(normalizedEffort ? { reasoning_effort: normalizedEffort } : {}),
      ...extensions,
      ...(shouldRestartZhipuThinking(body, tools, messages)
        ? { thinking: { type: "enabled" as const, clear_thinking: true } }
        : {}),
    };
  }
  if (resource.providerCode === "deepseek") {
    return {
      ...(normalizedEffort ? { reasoning_effort: normalizedEffort } : {}),
      ...vendorRequestExtensions(body, false, false),
    };
  }
  return normalizedEffort ? { reasoning_effort: normalizedEffort } : {};
}

/** GLM 工具历史缺少真实推理时退出保留式思考，避免伪造或续接不完整推理。 */
function shouldRestartZhipuThinking(
  body: Record<string, unknown> | null,
  tools: unknown[] | undefined,
  messages: ChatMessage[],
): boolean {
  if (!tools?.length) return false;
  const thinking = body?.thinking;
  if (isRecord(thinking) && thinking.type === "disabled") return false;
  if (isRecord(thinking) && thinking.clear_thinking === true) return false;
  return messages.some((message) =>
    message.role === "assistant"
      && Boolean(message.tool_calls?.length)
      && (typeof message.reasoning_content !== "string"
        || message.reasoning_content.length === 0)
  );
}

function vendorRequestExtensions(
  body: Record<string, unknown> | null,
  includeToolStream: boolean,
  includeClearThinking: boolean,
): Pick<ChatCompletionBody, "thinking" | "tool_stream"> {
  const thinking = providerThinking(body?.thinking, includeClearThinking);
  return {
    ...(thinking ? { thinking } : {}),
    ...(includeToolStream && typeof body?.tool_stream === "boolean"
      ? { tool_stream: body.tool_stream }
      : {}),
  };
}

function providerThinking(
  raw: unknown,
  includeClearThinking: boolean,
): { type: "enabled" | "disabled"; clear_thinking?: boolean } | undefined {
  if (!isRecord(raw) || (raw.type !== "enabled" && raw.type !== "disabled")) return undefined;
  return {
    type: raw.type,
    ...(includeClearThinking && typeof raw.clear_thinking === "boolean"
      ? { clear_thinking: raw.clear_thinking }
      : {}),
  };
}

function providerReasoningEffort(
  resource: Pick<AdapterResource, "providerCode" | "upstreamModel">,
  raw: unknown,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (resource.providerCode === "zhipu") {
    if (!supportsZhipuReasoningEffort(resource.upstreamModel)) return undefined;
    return ["max", "xhigh", "high", "medium", "low", "minimal", "none"].includes(raw)
      ? raw
      : undefined;
  }
  if (resource.providerCode === "deepseek") {
    return ["max", "xhigh", "high", "medium", "low"].includes(raw) ? raw : undefined;
  }
  if (!isKimiK3Model(resource.upstreamModel)) return undefined;
  if (raw === "medium") return "high";
  if (raw === "xhigh") return "max";
  return ["max", "high", "low"].includes(raw) ? raw : undefined;
}

function isKimiK3Model(upstreamModel: string): boolean {
  return /^(?:kimi-)?k3(?:-|$)/i.test(upstreamModel);
}

function supportsZhipuReasoningEffort(upstreamModel: string): boolean {
  const match = /^glm-(\d+)(?:\.(\d+))?/i.exec(upstreamModel);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}

/** 官方 Responses 输入到 OpenAI-compatible Chat Completions 的确定性转换。 */
