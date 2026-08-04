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
import { sql } from "kysely";

/** preHandler 类型：从 principal-auth 注入。 */
export type AuthHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerModelsRoute(app: FastifyInstance, db: Kysely<Database>, auth: AuthHandler): void {
  app.get<{ Querystring: { client_version?: string } }>(
    "/v1/models",
    { preHandler: [auth] },
    async (req): Promise<ListModelsResponse | { models: Array<Record<string, unknown>> }> => {
    let query = db
      .selectFrom("unified_model")
      .select(["alias", "display_name"])
      .where("enterprise_id", "=", req.principal!.enterpriseId)
      .where("status", "=", "ACTIVE");
    const allowed = req.principal!.allowedModelIds;
    if (allowed.length === 0) {
      return req.query.client_version ? { models: [] } : { object: "list", data: [] };
    }
    query = query.where("id", "in", allowed);
    const now = new Date();
    query = query.where(({ exists, selectFrom }) => exists(
      selectFrom("principal_grant")
        .select(sql`1`.as("one"))
        .whereRef("principal_grant.enterprise_id", "=", "unified_model.enterprise_id")
        .where("principal_grant.principal_id", "=", req.principal!.principalId)
        .whereRef("principal_grant.model_alias", "=", "unified_model.alias")
        .where("principal_grant.status", "=", "ACTIVE")
        .where("principal_grant.valid_from", "<=", now)
        .where((grantEb) => grantEb.or([
          grantEb("principal_grant.valid_until", "is", null),
          grantEb("principal_grant.valid_until", ">", now),
        ])),
    ));
    const models = await query.execute();

    // 官方 Codex CLI 会带 client_version，并使用 Codex model manifest（{models:[...]}）。
    // 其他 OpenAI-compatible 客户端继续得到标准 {object:"list",data:[...]}。
    if (req.query.client_version) {
      return {
        models: models.map((model, index) => codexModelInfo(model.alias, model.display_name, index)),
      };
    }
    return {
      object: "list",
      data: models.map((m) => ({
        id: m.alias,
        object: "model" as const,
        owned_by: "qianliu",
      })),
    };
    },
  );
}

function codexModelInfo(alias: string, displayName: string, index: number): Record<string, unknown> {
  return {
    slug: alias,
    display_name: displayName,
    description: "仟流智算 Gateway 授权模型",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "较快" },
      { effort: "medium", description: "平衡" },
      { effort: "high", description: "较深" },
    ],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 100 - index,
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    support_verbosity: true,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 100_000 },
    supports_parallel_tool_calls: true,
    context_window: 100_000,
    experimental_supported_tools: [],
  };
}
