export type UpstreamErrorMessageCategory =
  | "AUTHENTICATION_FAILED"
  | "CREDENTIAL_EXPIRED"
  | "CREDENTIAL_REVOKED"
  | "PERMISSION_DENIED"
  | "UNSUPPORTED_PARAMETER"
  | "INVALID_PARAMETER"
  | "INVALID_MESSAGE_CONTENT"
  | "INVALID_TOOL_SCHEMA"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "MODEL_IMAGE_UNSUPPORTED"
  | "MODEL_UNAVAILABLE"
  | "UNCLASSIFIED";

/**
 * 上游拒绝请求的脱敏证据。不保存原始响应正文；
 * 诊断哈希只基于白名单错误元组与安全结构摘要。
 */
export interface UpstreamErrorEvidence {
  httpStatus: number;
  type: string | null;
  code: string | null;
  param: string | null;
  messageCategory: UpstreamErrorMessageCategory;
  /** 只基于白名单错误元组与结构摘要，不包含 raw message/content 的 SHA-256。 */
  diagnosticHash: string;
}
/**
 * 实际发往上游的请求结构摘要。仅包含类型、数量和 Schema 关键字，
 * 不包含消息正文、工具名、属性名、参数值或 Secret。
 */
export interface RequestShapeSummary {
  topLevelFields: string[];
  messageCount: number;
  messageRoles: Record<string, number>;
  contentKinds: string[];
  contentBlockTypes: string[];
  assistantToolCallCount: number;
  toolResultCount: number;
  unmatchedAssistantToolCallCount: number;
  unmatchedToolResultCount: number;
  toolCount: number;
  functionToolCount: number;
  invalidToolCount: number;
  toolSchemaIssueCounts: Record<string, number>;
  toolTypes: string[];
  schemaKeywords: string[];
  schemaMaxDepth: number;
  schemaNodeCount: number;
  schemaPropertyCount: number;
  toolChoiceKind: string | null;
  stream: boolean;
  streamOptionsIncluded: boolean;
  countOverflowed: boolean;
}

const ERROR_CATEGORIES = new Set<UpstreamErrorMessageCategory>([
  "AUTHENTICATION_FAILED", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "PERMISSION_DENIED",
  "UNSUPPORTED_PARAMETER", "INVALID_PARAMETER", "INVALID_MESSAGE_CONTENT",
  "INVALID_TOOL_SCHEMA", "CONTEXT_LENGTH_EXCEEDED", "MODEL_IMAGE_UNSUPPORTED", "MODEL_UNAVAILABLE", "UNCLASSIFIED",
]);
const UPSTREAM_ERROR_TYPES = new Set([
  "access_denied", "api_error", "authentication_error", "invalid_request_error", "overloaded_error",
  "permission_error", "rate_limit_error", "server_error",
]);
const UPSTREAM_ERROR_CODES = new Set([
  "1210", "1211", "1212", "1213", "1214", "1215", "1302", "1305", "1308", "1309", "1310", "1311",
  "api_error", "authentication_error", "billing_blocked", "context_length_exceeded",
  "credential_expired", "credential_invalid", "credential_revoked", "expired_token",
  "insufficient_balance", "invalid_parameter", "invalid_request_error", "invalid_value",
  "invalid_api_key", "invalid_authentication", "model_not_found", "overloaded_error",
  "permission_error", "quota_exhausted",
  "rate_limit_exceeded", "server_error", "token_expired", "token_revoked", "unauthorized",
  "vendor_timeout",
]);
const SUMMARY_ARRAY_VALUES = {
  topLevelFields: new Set([
    "max_tokens", "messages", "model", "parallel_tool_calls", "reasoning_effort", "stream",
    "stream_options", "thinking", "tool_choice", "tool_stream", "tools",
  ]),
  contentKinds: new Set(["array", "boolean", "null", "number", "object", "other", "string"]),
  contentBlockTypes: new Set([
    "image_url", "input_audio", "input_text", "other", "refusal", "text", "tool_result", "tool_use",
  ]),
  toolTypes: new Set(["function", "other"]),
  schemaKeywords: new Set([
    "$defs", "$ref", "additionalProperties", "allOf", "anyOf", "const", "default",
    "description", "enum", "format", "items", "maximum", "maxLength", "minimum",
    "minLength", "oneOf", "pattern", "properties", "required", "type",
  ]),
};
const DIAGNOSTIC_PARAM_SEGMENTS = new Set([
  "additionalProperties", "arguments", "content", "function", "image_url", "include_usage",
  "items", "max_tokens", "messages", "model", "name", "parallel_tool_calls", "parameters",
  "properties", "reasoning", "reasoning_content", "reasoning_details", "reasoning_effort",
  "required", "role", "stream", "stream_options", "text",
  "thinking", "tool_call_id", "tool_calls", "tool_choice", "tool_stream", "tools", "type",
]);
const TOOL_SCHEMA_ISSUES = new Set([
  "NON_FUNCTION_TOOL", "FUNCTION_MISSING", "FUNCTION_NAME_INVALID",
  "PARAMETERS_NOT_OBJECT", "PARAMETERS_SCHEMA_INVALID",
]);

function diagnosticRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticInteger(value: unknown, max = 10_000): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function diagnosticStringArray(value: unknown, allowed: Set<string>): value is string[] {
  return Array.isArray(value)
    && value.length <= 32
    && value.every((item) => typeof item === "string" && allowed.has(item));
}

export function sanitizeUpstreamErrorType(value: unknown): string | null {
  return typeof value === "string" && UPSTREAM_ERROR_TYPES.has(value) ? value : null;
}

export function sanitizeUpstreamErrorCode(value: unknown): string | null {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof normalized === "string" && UPSTREAM_ERROR_CODES.has(normalized) ? normalized : null;
}

export function sanitizeUpstreamErrorParam(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  const normalized = value.replace(/\[\d+\]/g, "[]");
  const segments = normalized.split(".");
  const safe: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const base = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
    if (index > 0 && segments[index - 1] === "properties") {
      safe.push("*");
      continue;
    }
    if (!DIAGNOSTIC_PARAM_SEGMENTS.has(base)) return null;
    safe.push(segment);
  }
  const result = safe.join(".");
  return result.length <= 128 ? result : null;
}

/** 从 DB/API 边界重新校验上游错误证据；任一字段越界则整体 fail-closed。 */
export function parseUpstreamErrorEvidence(value: unknown): UpstreamErrorEvidence | null {
  if (!diagnosticRecord(value)) return null;
  const httpStatus = value.httpStatus;
  const type = sanitizeUpstreamErrorType(value.type);
  const code = sanitizeUpstreamErrorCode(value.code);
  const param = sanitizeUpstreamErrorParam(value.param);
  if (typeof httpStatus !== "number" || !new Set([400, 401, 403]).has(httpStatus)
    || !(value.type === null || type !== null)
    || !(value.code === null || code !== null)
    || !(value.param === null || param === value.param)
    || typeof value.messageCategory !== "string"
    || !ERROR_CATEGORIES.has(value.messageCategory as UpstreamErrorMessageCategory)
    || typeof value.diagnosticHash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.diagnosticHash)) return null;
  return {
    httpStatus,
    type,
    code,
    param,
    messageCategory: value.messageCategory as UpstreamErrorMessageCategory,
    diagnosticHash: value.diagnosticHash,
  };
}

/** 从 DB/API 边界重新校验请求形状摘要，不向管理面透传任意 jsonb。 */
export function parseRequestShapeSummary(value: unknown): RequestShapeSummary | null {
  if (!diagnosticRecord(value)
    || !diagnosticStringArray(value.topLevelFields, SUMMARY_ARRAY_VALUES.topLevelFields)
    || !diagnosticStringArray(value.contentKinds, SUMMARY_ARRAY_VALUES.contentKinds)
    || !diagnosticStringArray(value.contentBlockTypes, SUMMARY_ARRAY_VALUES.contentBlockTypes)
    || !diagnosticStringArray(value.toolTypes, SUMMARY_ARRAY_VALUES.toolTypes)
    || !diagnosticStringArray(value.schemaKeywords, SUMMARY_ARRAY_VALUES.schemaKeywords)
    || !diagnosticRecord(value.messageRoles)) return null;
  const roleEntries = Object.entries(value.messageRoles);
  if (roleEntries.length > 5 || roleEntries.some(([role, count]) =>
    !new Set(["assistant", "other", "system", "tool", "user"]).has(role)
    || !diagnosticInteger(count))) return null;
  if (!diagnosticRecord(value.toolSchemaIssueCounts)) return null;
  const issueEntries = Object.entries(value.toolSchemaIssueCounts);
  if (issueEntries.length > TOOL_SCHEMA_ISSUES.size || issueEntries.some(([issue, count]) =>
    !TOOL_SCHEMA_ISSUES.has(issue) || !diagnosticInteger(count))) return null;
  const numericFields = [
    "messageCount", "assistantToolCallCount", "toolResultCount",
    "unmatchedAssistantToolCallCount", "unmatchedToolResultCount", "toolCount",
    "functionToolCount", "invalidToolCount", "schemaMaxDepth", "schemaNodeCount",
    "schemaPropertyCount",
  ] as const;
  if (numericFields.some((field) => !diagnosticInteger(value[field]))) return null;
  const toolChoice = value.toolChoiceKind;
  if (!(toolChoice === null || (
    typeof toolChoice === "string"
    && new Set(["auto", "function", "none", "object", "other", "required"]).has(toolChoice)
  )) || typeof value.stream !== "boolean"
    || typeof value.streamOptionsIncluded !== "boolean"
    || typeof value.countOverflowed !== "boolean") return null;
  return {
    topLevelFields: value.topLevelFields,
    messageCount: value.messageCount as number,
    messageRoles: Object.fromEntries(roleEntries) as Record<string, number>,
    contentKinds: value.contentKinds,
    contentBlockTypes: value.contentBlockTypes,
    assistantToolCallCount: value.assistantToolCallCount as number,
    toolResultCount: value.toolResultCount as number,
    unmatchedAssistantToolCallCount: value.unmatchedAssistantToolCallCount as number,
    unmatchedToolResultCount: value.unmatchedToolResultCount as number,
    toolCount: value.toolCount as number,
    functionToolCount: value.functionToolCount as number,
    invalidToolCount: value.invalidToolCount as number,
    toolSchemaIssueCounts: Object.fromEntries(issueEntries) as Record<string, number>,
    toolTypes: value.toolTypes,
    schemaKeywords: value.schemaKeywords,
    schemaMaxDepth: value.schemaMaxDepth as number,
    schemaNodeCount: value.schemaNodeCount as number,
    schemaPropertyCount: value.schemaPropertyCount as number,
    toolChoiceKind: toolChoice,
    stream: value.stream,
    streamOptionsIncluded: value.streamOptionsIncluded,
    countOverflowed: value.countOverflowed,
  };
}
