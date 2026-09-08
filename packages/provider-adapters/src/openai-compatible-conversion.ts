import type { ReasoningFieldExtensions } from "@qianliu/contracts";
import type { ChatMessage, ChatToolCall, UpstreamMessage } from "./openai-compatible-types.js";


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

export function appendResponseInputItem(
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

export function responseToolToChatTool(rawTool: Record<string, unknown>): unknown | null {
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

export function anthropicToolToChatTool(raw: unknown): unknown | null {
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

export function anthropicToolChoiceToChat(choice: unknown): unknown {
  if (!isRecord(choice)) return choice;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return choice;
}

export function responseToolChoiceToChat(choice: unknown): unknown {
  if (!isRecord(choice) || choice.type !== "function" || typeof choice.name !== "string") {
    return choice;
  }
  return { type: "function", function: { name: choice.name } };
}

export function responseContentToChatContent(content: unknown): unknown {
  if (!Array.isArray(content)) return contentToText(content);
  const converted = content.flatMap((rawPart): unknown[] => {
    const part = isRecord(rawPart) ? rawPart : {};
    const type = stringValue(part.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      return [{ type: "text", text: stringValue(part.text) }];
    }
    if (type === "input_image" && typeof part.image_url === "string") {
      const detail = ["low", "high", "original", "auto"].includes(stringValue(part.detail))
        ? stringValue(part.detail)
        : undefined;
      return [{
        type: "image_url",
        image_url: { url: part.image_url, ...(detail ? { detail } : {}) },
      }];
    }
    if (type === "input_image" && typeof part.file_id === "string") {
      return [{ type: "file", file_id: part.file_id }];
    }
    return [];
  });
  return converted.length > 0 ? converted : contentToText(content);
}

export function normalizeExistingChatMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  const role = normalizeRole(raw.role);
  if (!role) return null;
  const reasoningExtensions = role === "assistant"
    ? reasoningFieldExtensions(raw)
    : undefined;
  return {
    role,
    content: raw.content ?? "",
    ...(typeof raw.tool_call_id === "string"
      ? { tool_call_id: raw.tool_call_id }
      : {}),
    ...(Array.isArray(raw.tool_calls)
      ? { tool_calls: raw.tool_calls as ChatToolCall[] }
      : {}),
    ...(reasoningExtensions ?? {}),
  };
}

/** 只复制白名单推理字段；不改名、不解析、不记录字段值。 */
export function reasoningFieldExtensions(
  raw: ReasoningFieldExtensions,
): ReasoningFieldExtensions | undefined {
  const extensions: ReasoningFieldExtensions = {};
  let found = false;
  for (const key of ["reasoning_content"] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined) continue;
    extensions[key] = raw[key];
    found = true;
  }
  return found ? extensions : undefined;
}

/** Anthropic Messages 内容块展开为 OpenAI Chat Completions 消息。 */
export function anthropicMessageToChatMessages(raw: unknown): ChatMessage[] {
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
      // Anthropic 工具结果允许同时返回文字与图片（例如浏览器截图）。
      // 文本结果继续保持 string，含图片时转换为 OpenAI-compatible
      // 多模态 content；不能只取 text，否则模型会在工具续轮中丢失截图。
      content: Array.isArray(item.content)
        ? anthropicUserContentToChatContent(item.content)
        : contentToText(item.content),
    });
  }
  const userContent = anthropicUserContentToChatContent(nonToolResultParts);
  if (Array.isArray(userContent) ? userContent.length > 0 : userContent) {
    messages.push({ role: "user", content: userContent });
  }
  return messages;
}

export function anthropicUserContentToChatContent(parts: unknown[]): unknown {
  let hasMedia = false;
  const converted = parts.flatMap((raw): unknown[] => {
    if (!isRecord(raw)) return [];
    if (raw.type === "text" && typeof raw.text === "string") {
      return [{ type: "text", text: raw.text }];
    }
    if (raw.type !== "image" || !isRecord(raw.source)) return [];
    hasMedia = true;
    const source = raw.source;
    if (source.type === "base64"
      && typeof source.media_type === "string"
      && typeof source.data === "string") {
      return [{
        type: "image_url",
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
      }];
    }
    if (source.type === "url" && typeof source.url === "string") {
      return [{ type: "image_url", image_url: { url: source.url } }];
    }
    if (source.type === "file" && typeof source.file_id === "string") {
      return [{ type: "file", file_id: source.file_id }];
    }
    return [];
  });
  return hasMedia && converted.length > 0 ? converted : contentToText(parts);
}

export function normalizeRole(role: unknown): ChatMessage["role"] | null {
  if (role === "developer" || role === "system") return "system";
  if (role === "user" || role === "assistant" || role === "tool") return role;
  return null;
}

export function contentToText(value: unknown): string {
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

export function argumentString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
