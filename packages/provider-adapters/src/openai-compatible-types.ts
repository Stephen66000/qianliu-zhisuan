import type { ReasoningFieldExtensions } from "@qianliu/contracts";
import type { AdapterResource } from "./index.js";

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
  firstByteTimeoutMs?: number;
  firstByteTimeoutMsForResource?: (resource: AdapterResource) => number;
  streamIdleTimeoutMs?: number;
  streamIdleTimeoutMsForResource?: (resource: AdapterResource) => number;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage extends ReasoningFieldExtensions {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  reasoning_effort?: string;
  thinking?: unknown;
  tool_stream?: boolean;
  response_format?: unknown;
  max_completion_tokens?: number;
}

export interface UpstreamMessage extends ReasoningFieldExtensions {
  content?: unknown;
  tool_calls?: unknown;
}
