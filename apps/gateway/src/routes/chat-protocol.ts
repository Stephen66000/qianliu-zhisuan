/**
 * OpenAI Chat Completions 北向流协议适配。
 *
 * 本模块只负责把上游增量事件写成标准 SSE，不持久化消息正文。`committed`
 * 是故障切换边界：一旦首个事件发给客户端，调用链不得再切换上游拼接第二份响应。
 */
import type { FastifyReply } from "fastify";
import type { Outcome } from "@qianliu/contracts";

export interface ChatFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface GatewayStreamWriter {
  readonly committed: boolean;
  writeChunk(payload: Record<string, unknown>): Promise<void>;
  complete(outcome: Outcome): void;
  fail(input: {
    code: string;
    message: string;
    requestId: string;
  }): void;
}

/** OpenAI Chat SSE：每个上游 delta 到达后立即改写模型/请求标识并刷新给客户端。 */
export function createChatStreamWriter(
  reply: FastifyReply,
  input: {
    requestId: string;
    traceId: string;
    createdAt: number;
    model: string;
  },
): GatewayStreamWriter {
  let started = false;
  let ended = false;
  let sawUsage = false;
  let sawFinishReason = false;
  let sawToolCall = false;
  const id = `chatcmpl-${input.requestId}`;
  const start = () => {
    if (started || ended) return;
    started = true;
    startSse(reply, input.traceId, input.requestId);
  };
  const write = (payload: Record<string, unknown>) => {
    if (ended || reply.raw.destroyed) return;
    start();
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  return {
    get committed() {
      return started;
    },
    async writeChunk(payload) {
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const usage = isRecord(payload.usage) ? payload.usage : null;
      for (const rawChoice of choices) {
        const choice = isRecord(rawChoice) ? rawChoice : {};
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          sawFinishReason = true;
        }
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) sawToolCall = true;
      }
      if (usage) sawUsage = true;
      // 空 usage chunk 也必须保留；它位于 [DONE] 前且 choices=[]。
      if (choices.length === 0 && !usage) return;
      // 少数兼容上游省略 finish_reason；在最终 usage 前补齐，维持 OpenAI 事件顺序。
      if (usage && choices.length === 0 && !sawFinishReason) {
        write(chatChunk(input, {}, sawToolCall ? "tool_calls" : "stop"));
        sawFinishReason = true;
      }
      write({
        id,
        object: "chat.completion.chunk",
        created: input.createdAt,
        model: input.model,
        choices,
        usage,
      });
    },
    complete(outcome) {
      if (ended) return;
      if (!started) {
        // Stub/非流式测试 Caller 没有逐块回调时保留合同，但生产真实 Caller 不走此分支。
        const assistant = normalizeOutput(outcome.responseOutput);
        write(chatChunk(input, { role: "assistant", content: "" }, null));
        if (assistant.text) write(chatChunk(input, { content: assistant.text }, null));
        assistant.calls.forEach((call, index) => write(chatChunk(input, {
          tool_calls: [{
            index,
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }],
        }, null)));
        write(chatChunk(
          input,
          {},
          assistant.calls.length > 0 ? "tool_calls" : "stop",
        ));
        sawFinishReason = true;
      } else if (!sawFinishReason) {
        write(chatChunk(input, {}, sawToolCall ? "tool_calls" : "stop"));
        sawFinishReason = true;
      }
      if (!sawUsage) {
        write({
          id,
          object: "chat.completion.chunk",
          created: input.createdAt,
          model: input.model,
          choices: [],
          usage: openAiUsage(outcome),
        });
      }
      ended = true;
      if (!reply.raw.destroyed) reply.raw.end("data: [DONE]\n\n");
    },
    fail(error) {
      if (ended) return;
      write({
        error: {
          type: "server_error",
          code: error.code,
          message: error.message,
          retryable: true,
          request_id: error.requestId,
        },
      });
      ended = true;
      if (!reply.raw.destroyed) reply.raw.end("data: [DONE]\n\n");
    },
  };
}

export function writeChatCompletionsSse(
  reply: FastifyReply,
  input: {
    requestId: string;
    traceId: string;
    createdAt: number;
    model: string;
    text: string;
    functionCalls: ChatFunctionCall[];
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    reasoningTokens: number;
  },
): void {
  const id = `chatcmpl-${input.requestId}`;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": input.traceId,
    "x-ai-request-id": input.requestId,
  });

  const write = (payload: Record<string, unknown>) => {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const chunk = (
    delta: Record<string, unknown>,
    finishReason: "stop" | "tool_calls" | null,
    usage: Record<string, unknown> | null = null,
  ) => ({
    id,
    object: "chat.completion.chunk",
    created: input.createdAt,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage,
  });

  write(chunk({ role: "assistant", content: "" }, null));
  if (input.text) {
    write(chunk({ content: input.text }, null));
  }
  input.functionCalls.forEach((call, index) => {
    write(chunk({
      tool_calls: [{
        index,
        id: call.callId,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      }],
    }, null));
  });

  write(chunk(
    {},
    input.functionCalls.length > 0 ? "tool_calls" : "stop",
    {
      prompt_tokens: input.inputTokens,
      completion_tokens: input.outputTokens,
      total_tokens: input.inputTokens + input.outputTokens,
      prompt_tokens_details: { cached_tokens: input.cacheTokens },
      completion_tokens_details: { reasoning_tokens: input.reasoningTokens },
    },
  ));
  reply.raw.end("data: [DONE]\n\n");
}

function startSse(reply: FastifyReply, traceId: string, requestId: string): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "x-request-id": traceId,
    "x-ai-request-id": requestId,
  });
  reply.raw.flushHeaders();
}

function chatChunk(
  input: { requestId: string; createdAt: number; model: string },
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion.chunk",
    created: input.createdAt,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

function openAiUsage(outcome: Outcome): Record<string, unknown> {
  return {
    prompt_tokens: outcome.usage.input,
    completion_tokens: outcome.usage.output,
    total_tokens: outcome.usage.input + outcome.usage.output,
    prompt_tokens_details: { cached_tokens: outcome.usage.cache },
    completion_tokens_details: { reasoning_tokens: outcome.usage.reasoning ?? 0 },
  };
}

function normalizeOutput(output: unknown[] | undefined): {
  text: string;
  calls: ChatFunctionCall[];
} {
  let text = "";
  const calls: ChatFunctionCall[] = [];
  for (const raw of output ?? []) {
    if (!isRecord(raw)) continue;
    if (raw.type === "message" && Array.isArray(raw.content)) {
      for (const part of raw.content) {
        if (isRecord(part) && typeof part.text === "string") text += part.text;
      }
    }
    if (raw.type === "function_call") {
      calls.push({
        callId: stringValue(raw.call_id) || stringValue(raw.id),
        name: stringValue(raw.name),
        arguments: stringValue(raw.arguments) || "{}",
      });
    }
  }
  return { text, calls };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
