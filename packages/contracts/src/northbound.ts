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
  };
}

// ===== 能力支持三态（TRD §6.3 行 424）=====

export type CapabilitySupport = "NATIVE" | "TRANSFORMED" | "UNSUPPORTED";

/** 北向端点能力声明。 */
export interface EndpointCapability {
  endpoint: string; // "GET /v1/models" 等
  support: CapabilitySupport;
}

/** 一期对外端点 + 能力矩阵。 */
export const CAPABILITY_MATRIX: EndpointCapability[] = [
  { endpoint: "GET /v1/models", support: "NATIVE" },
  { endpoint: "POST /v1/chat/completions", support: "NATIVE" },
  { endpoint: "POST /v1/chat/completions#stream", support: "NATIVE" },
  { endpoint: "POST /v1/messages", support: "NATIVE" },
  { endpoint: "POST /v1/messages#stream", support: "NATIVE" },
  { endpoint: "POST /v1/responses", support: "UNSUPPORTED" },
  { endpoint: "POST /v1/embeddings", support: "UNSUPPORTED" },
];
