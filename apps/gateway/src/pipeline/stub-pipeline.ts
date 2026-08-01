/**
 * W05 阶段的 pipelineHandler stub —— 证明北向合同工作。
 *
 * 返回符合 OpenAI/Anthropic 规范的固定响应（usage 来自固定值）。
 * W07 替换为真实 pipeline（Adapter + 账本 + committed 边界）。
 *
 * 注意：此 stub 不接入上游、不写账本；仅用于 W05 契约冻结验证。
 */
import type { PipelineHandler } from "../routes/chat.js";
import { buildResponsesResponse, writeResponsesSse } from "../routes/responses-protocol.js";

export const stubPipeline: PipelineHandler = async ({ request, reply, body, capability }) => {
  const requestId = request.requestId;
  const created = Math.floor(Date.now() / 1000);

  // 固定 usage（W05 stub；W07 来自真实 Attempt）
  const promptTokens = 11;
  const completionTokens = 7;

  if (capability === "responses") {
    const responsesRequest = body.responsesRequest!;
    const response = buildResponsesResponse({
      requestId,
      createdAt: created,
      model: body.model,
      request: responsesRequest,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheTokens: 2,
      reasoningTokens: 3,
      output: responsesStubOutput(responsesRequest, requestId),
    });
    if (body.stream) {
      writeResponsesSse(reply, response, requestId);
      return;
    }
    return reply.header("x-request-id", requestId).code(200).send(response);
  }

  if (body.stream) {
    // SSE 流式（OpenAI chat.completion.chunk）
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-request-id": requestId,
    });
    const write = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    write({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    write({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
    });
    write({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return;
  }

  if (capability === "messages") {
    // Anthropic 非流式
    return reply
      .header("x-request-id", requestId)
      .code(200)
      .send({
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: promptTokens, output_tokens: completionTokens },
      });
  }

  // OpenAI 非流式 chat.completion
  return reply
    .header("x-request-id", requestId)
    .code(200)
    .send({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
};

function responsesStubOutput(
  request: NonNullable<Parameters<PipelineHandler>[0]["body"]["responsesRequest"]>,
  requestId: string,
): unknown[] | undefined {
  const input = Array.isArray(request.input) ? request.input : [];
  const hasToolOutput = input.some((item) => item.type === "function_call_output");
  const tool = request.tools?.find((candidate) => candidate.type === "function");
  if (!tool || hasToolOutput) return undefined;
  const name = typeof tool.name === "string" ? tool.name : "tool";
  return [{
    id: `fc_${requestId}`,
    type: "function_call",
    status: "completed",
    call_id: `call_${requestId}`,
    name,
    arguments: name === "exec_command"
      ? JSON.stringify({ cmd: "printf 'Codex gateway tool call OK\\n'" })
      : "{}",
  }];
}
