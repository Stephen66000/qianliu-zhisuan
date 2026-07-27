/**
 * GET /v1/models —— 列出统一模型别名（W05）。
 *
 * 依据：TRD §6.1 行 387、§6.4 行 432-439（客户端只看到 qianliu-* 别名）。
 * OpenAI 兼容：{ object:"list", data:[{id,object:"model",owned_by:"qianliu"}] }。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import type { ListModelsResponse } from "@qianliu/contracts";

/** preHandler 类型：从 principal-auth 注入。 */
export type AuthHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerModelsRoute(app: FastifyInstance, db: Kysely<Database>, auth: AuthHandler): void {
  app.get("/v1/models", { preHandler: [auth] }, async (req): Promise<ListModelsResponse> => {
    const models = await db
      .selectFrom("unified_model")
      .select(["alias", "display_name"])
      .where("enterprise_id", "=", req.principal!.enterpriseId)
      .where("status", "=", "ACTIVE")
      .execute();

    return {
      object: "list",
      data: models.map((m) => ({
        id: m.alias,
        object: "model" as const,
        owned_by: "qianliu",
      })),
    };
  });
}
