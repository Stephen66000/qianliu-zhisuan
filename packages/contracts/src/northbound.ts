/**
 * 北向协议合同 DTO（W05 冻结，基于 OpenAI/Anthropic 官方规范）。
 *
 * 依据：TRD §6（北向协议）、PoC app.mjs 响应雏形、OpenAI Chat Completions / Anthropic Messages 官方规范。
 * 这些形状冻结 POC-01 北向合同，使 WorkBuddy/ZCode/Claude Code 等真实客户端可直接接入。
 */

// ===== GET /v1/models 响应 =====

export interface ModelObject {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ListModelsResponse {
  object: "list";
  data: ModelObject[];
}

// ===== POST /v1/chat/completions =====

export interface ChatCompletionRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionRequestMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  /** OpenAI-compatible 结构化输出约束（例如 json_schema + strict）。 */
  response_format?: unknown;
  /** 厂商兼容的推理强度；具体枚举由上游模型校验。 */
  reasoning_effort?: string;
  /** 上游最大输出 Token，用于限制成本与响应体量。 */
  max_completion_tokens?: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "tool_calls" | null;
}

/** OpenAI usage（prompt/completion/total_tokens）。 */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 非流式响应（OpenAI chat.completion）。 */
export interface ChatCompletionResponse {
  id: string; // chatcmpl-{request_id}
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

/** 流式 chunk（OpenAI chat.completion.chunk）。 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | "length" | null;
  }>;
  usage?: ChatCompletionUsage;
}

// ===== POST /v1/messages（Anthropic）=====

export interface MessageRequest {
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface MessageContentBlock {
  type: "text";
  text: string;
}

/** Anthropic 非流式响应。 */
export interface MessageResponse {
  id: string; // msg_{request_id}
  type: "message";
  role: "assistant";
  model: string;
  content: MessageContentBlock[];
  stop_reason: "end_turn" | "stop_sequence" | "max_tokens" | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ===== POST /v1/responses（OpenAI / 官方 Codex）=====

export interface ResponsesRequest {
  model: string;
  input: string | Array<Record<string, unknown>>;
  instructions?: string;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: {
    effort?: string | null;
    summary?: string | null;
  };
  text?: Record<string, unknown>;
  max_output_tokens?: number;
  store?: boolean;
  previous_response_id?: string | null;
  metadata?: Record<string, string>;
}

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponseMessageOutput {
  id: string;
  type: "message";
  status: "completed";
  role: "assistant";
  content: Array<{
    type: "output_text";
    text: string;
    annotations: unknown[];
    logprobs: unknown[];
  }>;
}

export interface ResponseFunctionCallOutput {
  id: string;
  type: "function_call";
  status: "completed";
  call_id: string;
  name: string;
  arguments: string;
}

export type ResponseOutputItem = ResponseMessageOutput | ResponseFunctionCallOutput;

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  error: null;
  incomplete_details: null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: {
    effort: string | null;
    summary: string | null;
  };
  store: boolean;
  tool_choice: unknown;
  tools: Array<Record<string, unknown>>;
  usage: ResponseUsage;
  metadata: Record<string, string>;
}

// ===== 错误 envelope（OpenAI 兼容）=====

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "capability_not_supported"
  | "rate_limit_error"
  | "server_error";

export interface ErrorEnvelope {
  error: {
    message: string;
    type: ErrorType;
    code: string; // 稳定错误码（machine-readable）
    param: string | null;
    retryable: boolean;
    request_id?: string;
    recover_at?: string;
    event_id?: string;
    retry_after_ms?: number;
  };
}

// ===== 能力支持三态（TRD §6.3 行 424）=====

export type CapabilitySupport = "NATIVE" | "TRANSFORMED" | "UNSUPPORTED";

/** 北向端点能力声明。 */
export interface EndpointCapability {
  endpoint: string; // "GET /v1/models" 等
  support: CapabilitySupport;
}

/**
 * 一期对外端点 + 能力矩阵。
 *
 * 单一事实源：gateway 的 unsupported 路由从此矩阵派生（filter UNSUPPORTED 的
 * POST 端点），避免两份硬编码漂移。W23 冻结启用集（详细计划 §4.6）。
 */
export const CAPABILITY_MATRIX: EndpointCapability[] = [
  { endpoint: "GET /v1/models", support: "NATIVE" },
  { endpoint: "POST /v1/chat/completions", support: "NATIVE" },
  { endpoint: "POST /v1/chat/completions#stream", support: "NATIVE" },
  { endpoint: "POST /v1/messages", support: "NATIVE" },
  { endpoint: "POST /v1/messages#stream", support: "NATIVE" },
  // 当前由 Responses 子集转换为上游 Chat Completions；不支持托管工具与
  // 原生事件透传，不得宣称 NATIVE。
  { endpoint: "POST /v1/responses", support: "TRANSFORMED" },
  { endpoint: "POST /v1/responses#stream", support: "TRANSFORMED" },
  // 默认关闭（详细计划 §4.6）：未启用能力必须显式拒绝，不得静默降级。
  { endpoint: "POST /v1/embeddings", support: "UNSUPPORTED" },
  { endpoint: "POST /v1/messages/count_tokens", support: "UNSUPPORTED" },
  // WebSocket 握手是带 Upgrade 头的 HTTP GET，由 server onRequest hook 拦截拒绝。
  { endpoint: "WebSocket /v1/ws#upgrade", support: "UNSUPPORTED" },
];

/** 从矩阵派生需要显式拒绝的 POST 路径（gateway unsupported 路由用）。 */
export const UNSUPPORTED_POST_PATHS: string[] = CAPABILITY_MATRIX.filter(
  (c) => c.support === "UNSUPPORTED" && c.endpoint.startsWith("POST "),
).map((c) => c.endpoint.slice("POST ".length));
