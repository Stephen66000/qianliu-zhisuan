/**
 * POST /v1/responses —— OpenAI Responses API / 官方 Codex 北向入口。
 *
 * 路由只负责最小校验与内存规范化；鉴权、模型门禁在 pipeline 前完成，
 * 路由/Attempt/usage/账本仍复用 real-pipeline。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ResponsesRequest } from "@qianliu/contracts";
import type { AuthHandler } from "./models.js";
import type { GatewayPipelineBody, PipelineHandler } from "./chat.js";

export function registerResponsesRoute(
  app: FastifyInstance,
  auth: AuthHandler,
  authorizeModel: AuthHandler,
  pipelineHandler: PipelineHandler,
): void {
  app.post(
    "/v1/responses",
    { preHandler: [auth, authorizeModel] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Partial<ResponsesRequest>;
      if (!body?.model || typeof body.model !== "string") {
        return invalidRequest(reply, req.requestId, "model is required", "missing_model", "model");
      }
      if (
        typeof body.input !== "string"
        && (!Array.isArray(body.input) || body.input.length === 0)
      ) {
        return invalidRequest(
          reply,
          req.requestId,
          "input must be a string or non-empty array",
          "missing_input",
          "input",
        );
      }
      if (body.tools !== undefined && !Array.isArray(body.tools)) {
        return invalidRequest(reply, req.requestId, "tools must be an array", "invalid_tools", "tools");
      }

      const responsesRequest = body as ResponsesRequest;
      const normalized: GatewayPipelineBody = {
        model: responsesRequest.model,
        messages: [{
          role: "user",
          content: typeof responsesRequest.input === "string"
            ? responsesRequest.input
            : JSON.stringify(responsesRequest.input),
        }],
        stream: responsesRequest.stream ?? false,
        tools: responsesRequest.tools,
        tool_choice: responsesRequest.tool_choice,
        responsesRequest,
      };
      await pipelineHandler({
        request: req,
        reply,
        body: normalized,
        capability: "responses",
      });
    },
  );
}

function invalidRequest(
  reply: FastifyReply,
  requestId: string,
  message: string,
  code: string,
  param: string,
) {
  return reply.code(400).send({
    error: {
      message,
      type: "invalid_request_error",
      code,
      param,
      retryable: false,
      request_id: requestId,
    },
  });
}
