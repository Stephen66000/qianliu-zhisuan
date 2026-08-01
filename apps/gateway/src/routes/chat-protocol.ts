import type { FastifyReply } from "fastify";

export interface ChatFunctionCall {
  callId: string;
  name: string;
  arguments: string;
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
