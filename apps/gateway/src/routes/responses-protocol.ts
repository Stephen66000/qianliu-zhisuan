/**
 * OpenAI Responses 北向协议输出适配。
 *
 * 1.0 仅支持由 Chat Completions 转换得到的 Responses 子集；这里负责构造最终
 * response 对象和规定顺序的 SSE 事件，不保存请求或响应正文。
 */
import type { FastifyReply } from "fastify";
import type {
  ResponseOutputItem,
  ResponsesRequest,
  ResponsesResponse,
} from "@qianliu/contracts";

/** 将内部 Outcome 的 Token 与输出项冻结为客户端可见的 Responses 最终对象。 */
export function buildResponsesResponse(input: {
  requestId: string;
  createdAt: number;
  model: string;
  request: ResponsesRequest;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  reasoningTokens: number;
  output?: unknown[];
}): ResponsesResponse {
  return {
    id: `resp_${input.requestId}`,
    object: "response",
    created_at: input.createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: input.model,
    output: normalizeOutput(input.output, input.requestId),
    parallel_tool_calls: input.request.parallel_tool_calls ?? true,
    previous_response_id: input.request.previous_response_id ?? null,
    reasoning: {
      effort: input.request.reasoning?.effort ?? null,
      summary: input.request.reasoning?.summary ?? null,
    },
    store: input.request.store ?? false,
    tool_choice: input.request.tool_choice ?? "auto",
    tools: input.request.tools ?? [],
    usage: {
      input_tokens: input.inputTokens,
      input_tokens_details: { cached_tokens: input.cacheTokens },
      output_tokens: input.outputTokens,
      output_tokens_details: { reasoning_tokens: input.reasoningTokens },
      total_tokens: input.inputTokens + input.outputTokens,
    },
    metadata: input.request.metadata ?? {},
  };
}

/**
 * 按 Responses 事件顺序一次性写出缓冲结果。
 * 该函数不是上游实时透传；1.0 的 Responses streaming 能力边界为转换兼容。
 */
export function writeResponsesSse(
  reply: FastifyReply,
  response: ResponsesResponse,
  traceId: string,
): void {
  const aiRequestId = response.id.slice("resp_".length);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": traceId,
    "x-ai-request-id": aiRequestId,
  });
  let sequenceNumber = 0;
  const write = (type: string, payload: Record<string, unknown>) => {
    reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({
      type,
      sequence_number: sequenceNumber++,
      ...payload,
    })}\n\n`);
  };

  write("response.created", {
    response: { ...response, status: "in_progress", output: [], usage: null },
  });
  write("response.in_progress", {
    response: { ...response, status: "in_progress", output: [], usage: null },
  });

  response.output.forEach((item, outputIndex) => {
    if (item.type === "function_call") {
      write("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      write("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      write("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
      write("response.output_item.done", { output_index: outputIndex, item });
      return;
    }

    write("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress", content: [] },
    });
    item.content.forEach((part, contentIndex) => {
      write("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { ...part, text: "" },
      });
      write("response.output_text.delta", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: contentIndex,
        delta: part.text,
        logprobs: [],
      });
      write("response.output_text.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: contentIndex,
        text: part.text,
        logprobs: [],
      });
      write("response.content_part.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: contentIndex,
        part,
      });
    });
    write("response.output_item.done", { output_index: outputIndex, item });
  });

  write("response.completed", { response });
  reply.raw.end();
}

function normalizeOutput(output: unknown[] | undefined, requestId: string): ResponseOutputItem[] {
  if (output && output.length > 0) return output as ResponseOutputItem[];
  return [{
    id: `msg_${requestId}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "OK", annotations: [], logprobs: [] }],
  }];
}
