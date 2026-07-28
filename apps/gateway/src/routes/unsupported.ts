/**
 * 未支持能力拒绝路由（W05，WT-14；W23 冻结启用集）。
 *
 * 依据：TRD §6 行 383「协议未启用时必须返回明确错误」、§6.3 行 426、WT-14（422 + capability_not_supported）。
 * Responses/Embeddings/count_tokens 等未启用端点在访问上游前返回 422。
 * 拒绝路径列表从 contracts CAPABILITY_MATRIX 派生（单一事实源），避免与矩阵漂移。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthHandler } from "./models.js";
import { fromClassification } from "../plugins/error-envelope.js";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";
import { UNSUPPORTED_POST_PATHS } from "@qianliu/contracts";

export function registerUnsupportedRoutes(app: FastifyInstance, auth: AuthHandler): void {
  for (const path of UNSUPPORTED_POST_PATHS) {
    app.post(path, { preHandler: [auth] }, async (req: FastifyRequest, reply: FastifyReply) => {
      const err = fromClassification(
        ERROR_CLASSIFICATION.CAPABILITY_UNSUPPORTED,
        "capability_not_supported",
        `能力 ${path} 一期未启用`,
        req.requestId,
      );
      return reply
        .code(err.status) // 422
        .header("x-request-id", req.requestId)
        .send({
          error: {
            message: err.message,
            type: err.type,
            code: err.code,
            param: null,
            retryable: err.retryable, // false
            request_id: req.requestId,
            provider: null,
            capability: path.replace("/v1/", ""),
          },
        });
    });
  }
}
