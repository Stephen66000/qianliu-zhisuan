/**
 * POST /v1/messages —— Anthropic 兼容 Messages（W05 北向合同）。
 *
 * 依据：TRD §6.2、Anthropic Messages 规范、PoC app.mjs 雏形。
 * Claude Code 通过此端点接入。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { MessageRequest } from "@qianliu/contracts";
import type { AuthHandler } from "./models.js";
import type { PipelineHandler } from "./chat.js";

export function registerMessagesRoute(
  app: FastifyInstance,
  auth: AuthHandler,
  pipelineHandler: PipelineHandler,
): void {
  app.post(
    "/v1/messages",
    { preHandler: [auth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Partial<MessageRequest>;
      if (!body?.model || typeof body.model !== "string") {
        return reply.code(400).send({
          error: {
            message: "model is required",
            type: "invalid_request_error",
            code: "missing_model",
            param: "model",
            retryable: false,
            request_id: req.requestId,
          },
        });
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({
          error: {
            message: "messages must be a non-empty array",
            type: "invalid_request_error",
            code: "missing_messages",
            param: "messages",
            retryable: false,
            request_id: req.requestId,
          },
        });
      }

      // messages capability 复用 chat pipeline（内部规范化）
      await pipelineHandler({
        request: req,
        reply,
        body: body as unknown as Parameters<PipelineHandler>[0]["body"],
        capability: "messages",
      });
    },
  );
}
