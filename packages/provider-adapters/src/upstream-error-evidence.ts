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

import type { ChatCompletionBody } from "./openai-compatible-types.js";

const TOP_LEVEL_FIELDS = [
  "max_tokens", "messages", "model", "parallel_tool_calls", "reasoning_effort", "stream",
  "stream_options", "tool_choice", "tools",
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

function messageCategory(message: string): UpstreamErrorMessageCategory {
  const normalized = message.toLowerCase();
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
  const message = [stringValue(error.message), stringValue(root.message)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const safeTuple = {
    httpStatus,
    type: sanitizeUpstreamErrorType(error.type),
    code: sanitizeUpstreamErrorCode(error.code),
    param: sanitizeUpstreamErrorParam(error.param ?? root.param),
    messageCategory: messageCategory(message),
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

/** 构造不含正文、工具名和 Schema 属性名的请求形状摘要。 */
// eslint-disable-next-line complexity -- 固定白名单分支集中在单一纯函数，避免安全规则跨文件漂移。
export function buildRequestShapeSummary(body: ChatCompletionBody): RequestShapeSummary {
  let countOverflowed = body.messages.length > MAX_DIAGNOSTIC_COUNT
    || (body.tools?.length ?? 0) > MAX_DIAGNOSTIC_COUNT;
  const messageRoles: Record<string, number> = {};
  const contentKinds = new Set<string>();
  const contentBlockTypes = new Set<string>();
  const assistantToolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  let assistantToolCallCount = 0;
  let toolResultCount = 0;

  for (const message of body.messages) {
    const role = new Set(["system", "user", "assistant", "tool"]).has(message.role)
      ? message.role
      : "other";
    const roleCount = (messageRoles[role] ?? 0) + 1;
    if (roleCount > MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
    messageRoles[role] = Math.min(roleCount, MAX_DIAGNOSTIC_COUNT);
    contentKinds.add(contentKind(message.content));
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const type = isRecord(block) && typeof block.type === "string" && CONTENT_BLOCK_TYPES.has(block.type)
          ? block.type
          : "other";
        contentBlockTypes.add(type);
      }
    }
    if (Array.isArray(message.tool_calls)) {
      assistantToolCallCount += message.tool_calls.length;
      if (assistantToolCallCount > MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
      assistantToolCallCount = Math.min(assistantToolCallCount, MAX_DIAGNOSTIC_COUNT);
      for (const call of message.tool_calls) {
        if (typeof call.id === "string") assistantToolCallIds.add(call.id);
      }
    }
    if (message.role === "tool") {
      if (toolResultCount >= MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
      toolResultCount = Math.min(toolResultCount + 1, MAX_DIAGNOSTIC_COUNT);
      if (typeof message.tool_call_id === "string") toolResultIds.add(message.tool_call_id);
    }
  }

  const toolTypes = new Set<string>();
  const schemaKeywords = new Set<string>();
  const schemaState = { maxDepth: 0, visited: 0, overflowed: false };
  const schemaCounts = { properties: 0 };
  const toolSchemaIssueCounts: Record<string, number> = {};
  const addIssue = (issue: string) => {
    const next = (toolSchemaIssueCounts[issue] ?? 0) + 1;
    if (next > MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
    toolSchemaIssueCounts[issue] = Math.min(next, MAX_DIAGNOSTIC_COUNT);
  };
  let functionToolCount = 0;
  let invalidToolCount = 0;
  for (const tool of body.tools ?? []) {
    if (!isRecord(tool)) {
      toolTypes.add("other");
      addIssue("NON_FUNCTION_TOOL");
      if (invalidToolCount >= MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
      invalidToolCount = Math.min(invalidToolCount + 1, MAX_DIAGNOSTIC_COUNT);
      continue;
    }
    const type = tool.type === "function" ? "function" : "other";
    toolTypes.add(type);
    const fn = isRecord(tool.function) ? tool.function : null;
    let validFunction = true;
    if (type !== "function") {
      addIssue("NON_FUNCTION_TOOL");
      validFunction = false;
    } else if (fn === null) {
      addIssue("FUNCTION_MISSING");
      validFunction = false;
    }
    if (fn && (
      typeof fn.name !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)
    )) {
      addIssue("FUNCTION_NAME_INVALID");
      validFunction = false;
    }
    const parameters = fn?.parameters;
    if (fn && !isRecord(parameters)) {
      addIssue("PARAMETERS_NOT_OBJECT");
      validFunction = false;
    } else if (isRecord(parameters)) {
      const properties = parameters.properties;
      const required = parameters.required;
      const schemaInvalid = (parameters.type !== undefined && parameters.type !== "object")
        || (properties !== undefined && !isRecord(properties))
        || (required !== undefined && (
          !Array.isArray(required)
          || required.some((item) => typeof item !== "string")
          || (isRecord(properties) && required.some((item) =>
            typeof item === "string" && !Object.prototype.hasOwnProperty.call(properties, item)))
        ));
      if (schemaInvalid) {
        addIssue("PARAMETERS_SCHEMA_INVALID");
        validFunction = false;
      }
    }
    if (type === "function") {
      if (functionToolCount >= MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
      functionToolCount = Math.min(functionToolCount + 1, MAX_DIAGNOSTIC_COUNT);
    }
    if (!validFunction) {
      if (invalidToolCount >= MAX_DIAGNOSTIC_COUNT) countOverflowed = true;
      invalidToolCount = Math.min(invalidToolCount + 1, MAX_DIAGNOSTIC_COUNT);
    }
    if (fn) collectSchemaShape(fn.parameters, schemaKeywords, 0, schemaState, schemaCounts);
  }

  const unmatchedAssistantRaw = [...assistantToolCallIds].filter((id) => !toolResultIds.has(id)).length;
  const unmatchedToolResultRaw = [...toolResultIds].filter((id) => !assistantToolCallIds.has(id)).length;
  if (unmatchedAssistantRaw > MAX_DIAGNOSTIC_COUNT || unmatchedToolResultRaw > MAX_DIAGNOSTIC_COUNT) {
    countOverflowed = true;
  }
  const unmatchedAssistantToolCallCount = Math.min(unmatchedAssistantRaw, MAX_DIAGNOSTIC_COUNT);
  const unmatchedToolResultCount = Math.min(unmatchedToolResultRaw, MAX_DIAGNOSTIC_COUNT);
  const toolChoiceKind = typeof body.tool_choice === "string"
    ? new Set(["auto", "none", "required"]).has(body.tool_choice) ? body.tool_choice : "other"
    : isRecord(body.tool_choice)
      ? body.tool_choice.type === "function" ? "function" : "object"
      : body.tool_choice === undefined
        ? null
        : "other";

  return {
    topLevelFields: TOP_LEVEL_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(body, key)),
    messageCount: Math.min(body.messages.length, MAX_DIAGNOSTIC_COUNT),
    messageRoles,
    contentKinds: [...contentKinds].sort(),
    contentBlockTypes: [...contentBlockTypes].sort(),
    assistantToolCallCount,
    toolResultCount,
    unmatchedAssistantToolCallCount,
    unmatchedToolResultCount,
    toolCount: Math.min(body.tools?.length ?? 0, MAX_DIAGNOSTIC_COUNT),
    functionToolCount,
    invalidToolCount,
    toolSchemaIssueCounts,
    toolTypes: [...toolTypes].sort(),
    schemaKeywords: [...schemaKeywords].sort(),
    schemaMaxDepth: schemaState.maxDepth,
    schemaNodeCount: schemaState.visited,
    schemaPropertyCount: schemaCounts.properties,
    toolChoiceKind,
    stream: body.stream,
    streamOptionsIncluded: body.stream_options !== undefined,
    countOverflowed: countOverflowed || schemaState.overflowed,
  };
}
