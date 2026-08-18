/**
 * Principal Grant 路由 —— 主体授权与额度（W03）。
 *
 * 依据：TRD §5.5、PRD §6.1（员工四步第三步"分配模型与额度"）、§8（额度）。
 * - GET /principals/:id/grants —— 列表
 * - POST /principals/:id/grants —— 创建授权（WT-02/WT-04 第三步）
 *
 * @deprecated POST 直建路径自 POOL-033 起仅为旧客户端保留；新 UI 走编排端点
 * PUT /principals/:id/access-configuration。GET 列表仍为有效读路径。
 *
 * 一期 quota_unit 固定 TOKEN。
 */
import type { FastifyInstance } from "fastify";
import { PrincipalNotActiveError } from "@qianliu/database";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const CreateGrantSchema = z.object({
  provider: z.enum(["deepseek", "zhipu", "kimi"]),
  model_alias: z.string().min(1).max(64),
  quota_value: z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((value) => /^\d+$/.test(value), { message: "额度必须是非负整数" })
    .transform((v) => BigInt(v)),
  allow_overage: z.boolean().optional(),
  valid_until: z.string().datetime().optional(),
});

export function registerGrantRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/principals/:id/grants",
    { preHandler: [requireAuth] },
    async (req) => {
      const grants = await app.grantRepo.listByPrincipal(
        req.admin!.enterpriseId,
        req.params.id,
      );
      return { grants };
    },
  );

  // @deprecated POOL-033：直建 Grant 路径仅为旧客户端保留。新 UI 一律走编排端点
  // PUT /principals/:id/access-configuration（池 Grant 由单事务统一创建/调整）。
  app.post<{ Params: { id: string } }>(
    "/principals/:id/grants",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      void reply.header("Deprecation", "true")
        .header("Sunset", "Wed, 30 Sep 2026 00:00:00 GMT")
        .header("Link", '</principals/:id/access-configuration>; rel="successor-version"');
      const parsed = CreateGrantSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;
      const principal = await app.principalRepo.findById(ent, req.params.id);
      if (!principal) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      if (principal.status !== "ACTIVE" || principal.archived_at !== null) {
        return reply.code(409).send({
          error: "invalid_state",
          message: "主体已停用或归档，不能创建额度授权",
        });
      }
      const archivedModel = await app.db.selectFrom("unified_model").select("id")
        .where("enterprise_id", "=", ent)
        .where("alias", "=", parsed.data.model_alias)
        .where("archived_at", "is not", null)
        .executeTakeFirst();
      if (archivedModel) {
        return reply.code(409).send({
          error: "archived_reference",
          message: "已归档统一模型不能被新授权引用",
        });
      }

      let grant;
      try {
        grant = await app.grantRepo.create({
          enterprise_id: ent,
          principal_id: req.params.id,
          provider: parsed.data.provider,
          model_alias: parsed.data.model_alias,
          quota_value: parsed.data.quota_value,
          allow_overage: parsed.data.allow_overage,
          valid_until: parsed.data.valid_until ? new Date(parsed.data.valid_until) : null,
        });
      } catch (error) {
        if (error instanceof PrincipalNotActiveError) {
          return reply.code(409).send({
            error: "invalid_state",
            message: "主体已停用或归档，不能创建额度授权",
          });
        }
        throw error;
      }

      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "grant.create",
        target_type: "principal_grant",
        target_id: grant.id,
        change_summary: {
          principal_id: req.params.id,
          provider: grant.provider,
          model_alias: grant.model_alias,
          quota_value: grant.quota_value.toString(),
          allow_overage: grant.allow_overage,
        },
        result: "SUCCESS",
      });

      return reply.code(201).send({ grant });
    },
  );
}
