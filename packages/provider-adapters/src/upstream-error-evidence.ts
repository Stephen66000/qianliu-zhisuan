import { createHash } from "node:crypto";

import type {
  RequestShapeSummary,
  UpstreamErrorEvidence,
  UpstreamErrorMessageCategory,
} from "@qianliu/contracts";
import {
  sanitizeUpstreamErrorCode,
  sanitizeUpstreamErrorParam,
  sanitizeUpstreamErrorType,
} from "@qianliu/contracts";

import type { ChatCompletionBody, ChatMessage } from "./openai-compatible-types.js";

const TOP_LEVEL_FIELDS = [
  "max_tokens", "messages", "model", "parallel_tool_calls", "reasoning_effort", "stream",
  "stream_options", "thinking", "tool_choice", "tool_stream", "tools",
] as const;
const CONTENT_BLOCK_TYPES = new Set([
  "image_url", "input_audio", "input_text", "refusal", "text", "tool_result", "tool_use",
]);
const MAX_DIAGNOSTIC_COUNT = 10_000;
const SCHEMA_KEYWORDS = new Set([
  "$defs", "$ref", "additionalProperties", "allOf", "anyOf", "const", "default",
  "description", "enum", "format", "items", "maximum", "maxLength", "minimum",
  "minLength", "oneOf", "pattern", "properties", "required", "type",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function messageCategory(message: string, providerCode: string, code: string | null): UpstreamErrorMessageCategory {
  const normalized = message.toLowerCase();
  if (/(?:image (?:format|size)|图片格式|图像格式|图片尺寸|图像尺寸)/.test(normalized)
    && /unsupported|not support|invalid|不支持|非法|无效/.test(normalized)) return "INVALID_MESSAGE_CONTENT";
  // Decimal points inside versioned model names are not sentence boundaries.
  const imageMessage = normalized.replace(/(\d)\.(?=\d)/g, "$1");
  if (/model[^.。\n]{0,100}(?:does not support|doesn't support|cannot (?:process|accept))[^.。\n]{0,50}(?:image|vision)|(?:image|vision)[^.。\n]{0,60}(?:not supported|unsupported)[^.。\n]{0,60}model/.test(imageMessage)
    || /模型[^。\n]{0,60}(?:不支持|无法处理|不能处理)[^。\n]{0,30}(?:图片|图像|视觉)|(?:图片|图像)[^。\n]{0,30}不支持[^。\n]{0,30}模型/.test(message)) {
    return "MODEL_IMAGE_UNSUPPORTED";
  }
  if (providerCode === "zhipu") {
    if (/模型[^。\n]{0,30}(?:不存在|不可用)/.test(message) || code === "1211") return "MODEL_UNAVAILABLE";
    if (/(?:上下文|token)[^。\n]{0,40}(?:超出|超过|上限)/i.test(message)) return "CONTEXT_LENGTH_EXCEEDED";
    if (/(?:图片|图像|消息内容)[^。\n]{0,40}(?:非法|无效|不支持|格式错误)/.test(message)) return "INVALID_MESSAGE_CONTENT";
    // Official 1210/1212-1215 are parameter/method errors, never proof of a missing image capability.
    if (code !== null && ["1210", "1212", "1213", "1214", "1215"].includes(code)) return "INVALID_PARAMETER";
    if (/(?:参数|字段)[^。\n]{0,40}(?:有误|非法|无效|错误|缺失)/.test(message)) return "INVALID_PARAMETER";
  }
  if (/(context|token).*(length|limit|maximum)|maximum context/.test(normalized)) {
    return "CONTEXT_LENGTH_EXCEEDED";
  }
  if (/(tool|function).*(schema|parameters?|definition)|invalid.*(tool|function)/.test(normalized)) {
    return "INVALID_TOOL_SCHEMA";
  }
  if (/(message|content|image|attachment).*(invalid|unsupported|expected|required)/.test(normalized)) {
    return "INVALID_MESSAGE_CONTENT";
  }
  if (/unsupported.*(parameter|field)|unknown (parameter|field)/.test(normalized)) {
    return "UNSUPPORTED_PARAMETER";
  }
  if (/invalid (value|parameter|field)|expected .* (for|at)/.test(normalized)) {
    return "INVALID_PARAMETER";
  }
  if (/(model).*(not found|unavailable|unsupported|does not exist)/.test(normalized)) {
    return "MODEL_UNAVAILABLE";
  }
  return "UNCLASSIFIED";
}

/**
 * 将上游 JSON 错误收敛为可持久化证据。原始 message 只在内存中参与分类，
 * 落库只有分类与哈希，避免厂商回显请求正文时泄露客户内容。
 */
export function buildUpstreamErrorEvidence(
  payload: unknown,
  httpStatus: number,
  providerCode: string,
  requestShapeSummary: RequestShapeSummary,
): UpstreamErrorEvidence {
  const root = isRecord(payload) ? payload : {};
  const error = isRecord(root.error) ? root.error : {};
  const message = `${stringValue(error.message)} ${stringValue(root.message)}`;
  const safeTuple = {
    httpStatus,
    type: sanitizeUpstreamErrorType(error.type),
    code: sanitizeUpstreamErrorCode(error.code),
    param: sanitizeUpstreamErrorParam(error.param ?? root.param),
    messageCategory: messageCategory(message, providerCode, sanitizeUpstreamErrorCode(error.code)),
  };
  return {
    ...safeTuple,
    diagnosticHash: createHash("sha256").update(canonicalJson({
      providerCode: new Set(["deepseek", "zhipu", "kimi"]).has(providerCode)
        ? providerCode
        : "unknown",
      ...safeTuple,
      requestShapeSummary,
    })).digest("hex"),
  };
}

function contentKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (isRecord(value)) return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "other";
}

function collectSchemaShape(
  value: unknown,
  keywords: Set<string>,
  depth: number,
  state: { maxDepth: number; visited: number; overflowed: boolean },
  counts: { properties: number },
): void {
  if (state.visited >= MAX_DIAGNOSTIC_COUNT || depth > 32) {
    state.overflowed = true;
    return;
  }
  state.visited += 1;
  state.maxDepth = Math.max(state.maxDepth, depth);
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaShape(item, keywords, depth + 1, state, counts);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_KEYWORDS.has(key)) keywords.add(key);
    if (key === "properties" && isRecord(child)) {
      const next = counts.properties + Object.keys(child).length;
      if (next > MAX_DIAGNOSTIC_COUNT) state.overflowed = true;
      counts.properties = Math.min(next, MAX_DIAGNOSTIC_COUNT);
    }
    collectSchemaShape(child, keywords, depth + 1, state, counts);
  }
}

interface MessageShape {
  assistantToolCallCount: number;
  contentBlockTypes: string[];
  contentKinds: string[];
  countOverflowed: boolean;
  messageRoles: Record<string, number>;
  toolResultCount: number;
  unmatchedAssistantToolCallCount: number;
  unmatchedToolResultCount: number;
}

interface ToolShape {
  countOverflowed: boolean;
  functionToolCount: number;
  invalidToolCount: number;
  schemaKeywords: string[];
  schemaMaxDepth: number;
  schemaNodeCount: number;
  schemaPropertyCount: number;
  toolSchemaIssueCounts: Record<string, number>;
  toolTypes: string[];
}

function capped(value: number): number {
  return Math.min(value, MAX_DIAGNOSTIC_COUNT);
}

function summarizeMessageContent(
  message: ChatMessage,
  contentKinds: Set<string>,
  contentBlockTypes: Set<string>,
): void {
  contentKinds.add(contentKind(message.content));
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    const type = isRecord(block) && typeof block.type === "string" && CONTENT_BLOCK_TYPES.has(block.type)
      ? block.type
      : "other";
    contentBlockTypes.add(type);
  }
}

function summarizeMessages(messages: ChatMessage[]): MessageShape {
  const messageRoles: Record<string, number> = {};
  const contentKinds = new Set<string>();
  const contentBlockTypes = new Set<string>();
  const assistantIds = new Set<string>();
  const resultIds = new Set<string>();
  let assistantToolCallCount = 0;
  let toolResultCount = 0;
  let countOverflowed = messages.length > MAX_DIAGNOSTIC_COUNT;
  for (const message of messages) {
    const role = new Set(["system", "user", "assistant", "tool"]).has(message.role) ? message.role : "other";
    const roleCount = (messageRoles[role] ?? 0) + 1;
    countOverflowed ||= roleCount > MAX_DIAGNOSTIC_COUNT;
    messageRoles[role] = capped(roleCount);
    summarizeMessageContent(message, contentKinds, contentBlockTypes);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    assistantToolCallCount += calls.length;
    countOverflowed ||= assistantToolCallCount > MAX_DIAGNOSTIC_COUNT;
    for (const call of calls) if (typeof call.id === "string") assistantIds.add(call.id);
    if (message.role !== "tool") continue;
    toolResultCount += 1;
    countOverflowed ||= toolResultCount > MAX_DIAGNOSTIC_COUNT;
    if (typeof message.tool_call_id === "string") resultIds.add(message.tool_call_id);
  }
  const unmatchedAssistant = [...assistantIds].filter((id) => !resultIds.has(id)).length;
  const unmatchedResults = [...resultIds].filter((id) => !assistantIds.has(id)).length;
  countOverflowed ||= unmatchedAssistant > MAX_DIAGNOSTIC_COUNT || unmatchedResults > MAX_DIAGNOSTIC_COUNT;
  return {
    assistantToolCallCount: capped(assistantToolCallCount),
    contentBlockTypes: [...contentBlockTypes].sort(),
    contentKinds: [...contentKinds].sort(),
    countOverflowed,
    messageRoles,
    toolResultCount: capped(toolResultCount),
    unmatchedAssistantToolCallCount: capped(unmatchedAssistant),
    unmatchedToolResultCount: capped(unmatchedResults),
  };
}

function parametersSchemaInvalid(parameters: Record<string, unknown>): boolean {
  const properties = parameters.properties;
  const required = parameters.required;
  if (parameters.type !== undefined && parameters.type !== "object") return true;
  if (properties !== undefined && !isRecord(properties)) return true;
  if (required === undefined) return false;
  if (!Array.isArray(required) || required.some((item) => typeof item !== "string")) return true;
  return isRecord(properties) && (required as string[]).some((item) =>
    !Object.prototype.hasOwnProperty.call(properties, item));
}

function inspectTool(tool: unknown): {
  fn: Record<string, unknown> | null;
  functionTool: boolean;
  issues: string[];
  type: string;
} {
  if (!isRecord(tool)) {
    return { fn: null, functionTool: false, issues: ["NON_FUNCTION_TOOL"], type: "other" };
  }
  const functionTool = tool.type === "function";
  const fn = isRecord(tool.function) ? tool.function : null;
  const issues: string[] = [];
  if (!functionTool) issues.push("NON_FUNCTION_TOOL");
  else if (!fn) issues.push("FUNCTION_MISSING");
  if (fn && (typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name))) {
    issues.push("FUNCTION_NAME_INVALID");
  }
  if (fn && !isRecord(fn.parameters)) issues.push("PARAMETERS_NOT_OBJECT");
  else if (fn && isRecord(fn.parameters) && parametersSchemaInvalid(fn.parameters)) {
    issues.push("PARAMETERS_SCHEMA_INVALID");
  }
  return { fn, functionTool, issues, type: functionTool ? "function" : "other" };
}

function summarizeTools(tools: unknown[]): ToolShape {
  const toolTypes = new Set<string>();
  const schemaKeywords = new Set<string>();
  const schemaState = { maxDepth: 0, visited: 0, overflowed: false };
  const schemaCounts = { properties: 0 };
  const issueCounts: Record<string, number> = {};
  let functionToolCount = 0;
  let invalidToolCount = 0;
  let countOverflowed = tools.length > MAX_DIAGNOSTIC_COUNT;
  for (const tool of tools) {
    const inspected = inspectTool(tool);
    toolTypes.add(inspected.type);
    functionToolCount += Number(inspected.functionTool);
    invalidToolCount += Number(inspected.issues.length > 0);
    countOverflowed ||= functionToolCount > MAX_DIAGNOSTIC_COUNT
      || invalidToolCount > MAX_DIAGNOSTIC_COUNT;
    for (const issue of inspected.issues) {
      const next = (issueCounts[issue] ?? 0) + 1;
      countOverflowed ||= next > MAX_DIAGNOSTIC_COUNT;
      issueCounts[issue] = capped(next);
    }
    if (inspected.fn) {
      collectSchemaShape(inspected.fn.parameters, schemaKeywords, 0, schemaState, schemaCounts);
    }
  }
  return {
    countOverflowed: countOverflowed || schemaState.overflowed,
    functionToolCount: capped(functionToolCount),
    invalidToolCount: capped(invalidToolCount),
    schemaKeywords: [...schemaKeywords].sort(),
    schemaMaxDepth: schemaState.maxDepth,
    schemaNodeCount: schemaState.visited,
    schemaPropertyCount: schemaCounts.properties,
    toolSchemaIssueCounts: issueCounts,
    toolTypes: [...toolTypes].sort(),
  };
}

function summarizeToolChoice(value: unknown): string | null {
  if (typeof value === "string") {
    return new Set(["auto", "none", "required"]).has(value) ? value : "other";
  }
  if (isRecord(value)) return value.type === "function" ? "function" : "object";
  return value === undefined ? null : "other";
}

/** 构造不含正文、工具名和 Schema 属性名的请求形状摘要。 */
export function buildRequestShapeSummary(body: ChatCompletionBody): RequestShapeSummary {
  const messages = summarizeMessages(body.messages);
  const tools = summarizeTools(body.tools ?? []);
  return {
    topLevelFields: TOP_LEVEL_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(body, key)),
    messageCount: capped(body.messages.length),
    messageRoles: messages.messageRoles,
    contentKinds: messages.contentKinds,
    contentBlockTypes: messages.contentBlockTypes,
    assistantToolCallCount: messages.assistantToolCallCount,
    toolResultCount: messages.toolResultCount,
    unmatchedAssistantToolCallCount: messages.unmatchedAssistantToolCallCount,
    unmatchedToolResultCount: messages.unmatchedToolResultCount,
    toolCount: capped(body.tools?.length ?? 0),
    functionToolCount: tools.functionToolCount,
    invalidToolCount: tools.invalidToolCount,
    toolSchemaIssueCounts: tools.toolSchemaIssueCounts,
    toolTypes: tools.toolTypes,
    schemaKeywords: tools.schemaKeywords,
    schemaMaxDepth: tools.schemaMaxDepth,
    schemaNodeCount: tools.schemaNodeCount,
    schemaPropertyCount: tools.schemaPropertyCount,
    toolChoiceKind: summarizeToolChoice(body.tool_choice),
    stream: body.stream,
    streamOptionsIncluded: body.stream_options !== undefined,
    countOverflowed: messages.countOverflowed || tools.countOverflowed,
  };
}
