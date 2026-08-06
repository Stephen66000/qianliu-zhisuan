/**
 * Principal Key 路由 —— 下游 Key 生命周期（W03）。
 *
 * 依据：TRD §5.3、PRD §6.3（一次展示）。
 * - POST /principals/:id/key —— 首次生成 Key（WT-02/WT-04 第二步"生成 Key"）。
 *   响应体含明文 key（一次展示）+ 提示"明文不会再次显示"。
 * - POST /principals/:id/key/reset —— 重置 Key，旧 Key 立即失效（WT-09）。
 * - GET /principals/:id/key —— 查看当前 Key 元数据（只返回 prefix，不返回明文）。
 *
 * 安全：明文 key 只在创建/重置响应体出现一次，绝不写日志/DB/Trace。
 */
import type { FastifyInstance } from "fastify";
import { ActiveKeyExistsError, PrincipalNotActiveError } from "@qianliu/database";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const KeyModelAuthorizationSchema = z.object({
  allowed_model_ids: z
    .array(z.string().uuid())
    .max(256)
    .refine((ids) => new Set(ids).size === ids.length, "allowed_model_ids 不能重复"),
});

async function findInvalidModelIds(
  app: FastifyInstance,
  enterpriseId: string,
  modelIds: string[],
): Promise<string[]> {
  if (modelIds.length === 0) return [];
  const models = await app.db
    .selectFrom("unified_model")
    .select("id")
    .where("enterprise_id", "=", enterpriseId)
    .where("status", "=", "ACTIVE")
    .where("id", "in", modelIds)
    .execute();
  const validIds = new Set(models.map((model) => model.id));
  return modelIds.filter((id) => !validIds.has(id));
}

export function registerKeyRoutes(app: FastifyInstance): void {
  // 生成 Key（WT-02/WT-04 第二步）
  app.post<{ Params: { id: string } }>(
    "/principals/:id/key",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id: principalId } = req.params;
      const ent = req.admin!.enterpriseId;

      const parsed = KeyModelAuthorizationSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "创建 Key 必须显式提交 allowed_model_ids（可为空数组）",
        });
      }
      const invalidModelIds = await findInvalidModelIds(
        app,
        ent,
        parsed.data.allowed_model_ids,
      );
      if (invalidModelIds.length > 0) {
        return reply.code(400).send({
          error: "invalid_model_authorization",
          message: "只能授权本企业的 ACTIVE 模型",
          invalid_model_ids: invalidModelIds,
        });
      }

      // 校验主体存在且 ACTIVE
      const principal = await app.principalRepo.findById(ent, principalId);
      if (!principal) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      if (principal.status !== "ACTIVE") {
        return reply.code(409).send({ error: "invalid_state", message: "主体已停用，不能生成 Key" });
      }

      // 已有有效 Key 时拒绝（每主体默认一把主 Key）
      const existing = await app.keyRepo.findActive(ent, principalId);
      if (existing) {
        return reply.code(409).send({
          error: "key_exists",
          message: "主体已有有效 Key，请使用重置接口",
        });
      }

      let created: Awaited<ReturnType<typeof app.keyRepo.create>>;
      try {
        created = await app.keyRepo.create(ent, principalId, {
          allowedModelIds: parsed.data.allowed_model_ids,
        });
      } catch (error) {
        if (error instanceof ActiveKeyExistsError) {
          return reply.code(409).send({
            error: "key_exists",
            message: "主体已有有效 Key，请使用重置接口",
          });
        }
        if (error instanceof PrincipalNotActiveError) {
          return reply.code(409).send({
            error: "invalid_state",
            message: "主体已停用或归档，不能生成 Key",
          });
        }
        throw error;
      }

      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "key.create",
        target_type: "principal_key",
        target_id: created.record.id,
        change_summary: {
          principal_id: principalId,
          key_prefix: created.record.key_prefix,
          allowed_model_ids: created.record.allowed_model_ids,
        },
        result: "SUCCESS",
      });

      // 一次展示：明文只在此响应体出现，提示不再显示
      return reply.code(201).send({
        key: created.plaintext,
        key_prefix: created.record.key_prefix,
        warning: "此 Key 明文仅展示一次，请立即保存。重置后旧 Key 立即失效。",
        // 返回元数据（不含明文也不含完整 digest）
        metadata: {
          id: created.record.id,
          status: created.record.status,
          created_at: created.record.created_at,
          allowed_model_ids: created.record.allowed_model_ids,
        },
      });
    },
  );

  // 重置 Key（WT-09：旧 Key 立即失效）
  app.post<{ Params: { id: string } }>(
    "/principals/:id/key/reset",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id: principalId } = req.params;
      const ent = req.admin!.enterpriseId;

      const principal = await app.principalRepo.findById(ent, principalId);
      if (!principal) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      if (principal.status !== "ACTIVE" || principal.archived_at !== null) {
        return reply.code(409).send({
          error: "invalid_state",
          message: "主体已停用或归档，不能重置 Key",
        });
      }

      // 单事务：撤销旧 + 创建新
      let reset: Awaited<ReturnType<typeof app.keyRepo.reset>>;
      try {
        reset = await app.keyRepo.reset(ent, principalId);
      } catch (error) {
        if (error instanceof PrincipalNotActiveError) {
          return reply.code(409).send({
            error: "invalid_state",
            message: "主体已停用或归档，不能重置 Key",
          });
        }
        throw error;
      }
      if (!reset) {
        return reply.code(404).send({
          error: "key_not_found",
          message: "主体没有可重置的有效 Key",
        });
      }

      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "key.reset",
        target_type: "principal_key",
        target_id: reset.record.id,
        change_summary: {
          principal_id: principalId,
          key_prefix: reset.record.key_prefix,
          inherited_restrictions: {
            allowed_model_ids: reset.record.allowed_model_ids,
            ip_allowlist: reset.record.ip_allowlist,
            expires_at: reset.record.expires_at,
            quota_limit: reset.record.quota_limit?.toString() ?? null,
            concurrency_limit: reset.record.concurrency_limit,
          },
        },
        result: "SUCCESS",
      });

      return reply.code(200).send({
        key: reset.plaintext,
        key_prefix: reset.record.key_prefix,
        warning: "新 Key 明文仅展示一次。旧 Key 已撤销并立即失效。",
        metadata: {
          id: reset.record.id,
          status: reset.record.status,
          created_at: reset.record.created_at,
          allowed_model_ids: reset.record.allowed_model_ids,
        },
      });
    },
  );

  // 更新当前有效 Key 的模型授权；空数组会立即禁用全部模型调用。
  // @deprecated POOL-033：直写白名单路径仅为旧客户端保留。新 UI 一律走编排端点
  // PUT /principals/:id/access-configuration（单事务完成池+开关+白名单+审计）。
  app.patch<{ Params: { id: string } }>(
    "/principals/:id/key",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      void reply.header("Deprecation", "true")
        .header("Sunset", "Wed, 30 Sep 2026 00:00:00 GMT")
        .header("Link", '</principals/:id/access-configuration>; rel="successor-version"');
      const { id: principalId } = req.params;
      const ent = req.admin!.enterpriseId;
      const parsed = KeyModelAuthorizationSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: parsed.error.message,
        });
      }
      const invalidModelIds = await findInvalidModelIds(
        app,
        ent,
        parsed.data.allowed_model_ids,
      );
      if (invalidModelIds.length > 0) {
        return reply.code(400).send({
          error: "invalid_model_authorization",
          message: "只能授权本企业的 ACTIVE 模型",
          invalid_model_ids: invalidModelIds,
        });
      }

      const principal = await app.principalRepo.findById(ent, principalId);
      if (!principal) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      if (principal.status !== "ACTIVE") {
        return reply.code(409).send({
          error: "invalid_state",
          message: "主体已停用，不能修改 Key 授权",
        });
      }

      const key = await app.keyRepo.updateAllowedModels(
        ent,
        principalId,
        parsed.data.allowed_model_ids,
      );
      if (!key) {
        return reply.code(404).send({
          error: "key_not_found",
          message: "主体没有有效 Key",
        });
      }

      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "key.model_authorization.update",
        target_type: "principal_key",
        target_id: key.id,
        change_summary: {
          principal_id: principalId,
          allowed_model_ids: key.allowed_model_ids,
        },
        result: "SUCCESS",
      });
      return { key: { id: key.id, allowed_model_ids: key.allowed_model_ids } };
    },
  );

  // 查看当前 Key 元数据（不返回明文）
  app.get<{ Params: { id: string } }>(
    "/principals/:id/key",
    { preHandler: [requireAuth] },
    async (req, _reply) => {
      const ent = req.admin!.enterpriseId;
      const keys = await app.keyRepo.listByPrincipal(ent, req.params.id);
      // 只返回掩码元数据
      return {
        keys: keys.map((k) => ({
          id: k.id,
          key_prefix: k.key_prefix,
          status: k.status,
          created_at: k.created_at,
          revoked_at: k.revoked_at,
          last_used_at: k.last_used_at,
          expires_at: k.expires_at,
          allowed_model_ids: k.allowed_model_ids,
        })),
      };
    },
  );
}
