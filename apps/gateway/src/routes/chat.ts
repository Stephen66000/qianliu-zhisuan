/**
 * POST /v1/chat/completions —— OpenAI 兼容 Chat（W05 北向合同；W06/W07 接入 pipeline）。
 *
 * 依据：TRD §6.1、OpenAI Chat Completions 规范、PoC app.mjs 雏形。
 * W05：冻结请求/响应 DTO 形状 + 能力校验（422）+ 鉴权 + request_id。
 * W06：接入 DeepSeek Adapter（Stub）。
 * W07：接入账本（attempt/usage/ledger）。
 * W08：接入 pipeline 编排（committed 边界、双 Attempt）。
 *
 * 本文件 W05 阶段：DTO 校验 + 调用 pipelineHandler（由 server 注入）。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ChatCompletionRequest } from "@qianliu/contracts";
import type { AuthHandler } from "./models.js";

/** 北向能力（chat = OpenAI；messages = Anthropic）。 */
export type NorthboundCapability = "chat" | "messages";

/** pipeline 处理器（W07/W08 注入完整实现）。 */
export interface PipelineHandler {
  (input: {
    request: FastifyRequest;
    reply: FastifyReply;
    body: ChatCompletionRequest;
    capability: NorthboundCapability;
  }): Promise<void>;
}

export function registerChatRoute(
  app: FastifyInstance,
  auth: AuthHandler,
  pipelineHandler: PipelineHandler,
): void {
  app.post(
    "/v1/chat/completions",
    { preHandler: [auth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Partial<ChatCompletionRequest>;
      // 最小校验：model + messages
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

      await pipelineHandler({ request: req, reply, body: body as ChatCompletionRequest, capability: "chat" });
    },
  );
}
