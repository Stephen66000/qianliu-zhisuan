/**
 * Principal Key 路由 —— 下游 Key 生命周期（W03）。
 *
 * 依据：TRD §5.3、PRD §6.3（一次展示）。
 * - POST /principals/:id/key —— 首次生成 Key（WT-02/WT-04 第二步"生成 Key"）。
 *   响应体含明文 key（一次展示）+ 提示"明文不会再次显示"。
 * - POST /principals/:id/key/reset —— 重置 Key，旧 Key 5 秒内失效（WT-09）。
 * - GET /principals/:id/key —— 查看当前 Key 元数据（只返回 prefix，不返回明文）。
 *
 * 安全：明文 key 只在创建/重置响应体出现一次，绝不写日志/DB/Trace。
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";

export function registerKeyRoutes(app: FastifyInstance): void {
  // 生成 Key（WT-02/WT-04 第二步）
  app.post<{ Params: { id: string } }>(
    "/principals/:id/key",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id: principalId } = req.params;
      const ent = req.admin!.enterpriseId;

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

      const created = await app.keyRepo.create(ent, principalId);

      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "key.create",
        target_type: "principal_key",
        target_id: created.record.id,
        change_summary: { principal_id: principalId, key_prefix: created.record.key_prefix },
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
        },
      });
    },
  );

  // 重置 Key（WT-09：旧 Key 5 秒内失效）
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

      // 单事务：撤销旧 + 创建新
      const reset = await app.keyRepo.reset(ent, principalId);

      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "key.reset",
        target_type: "principal_key",
        target_id: reset.record.id,
        change_summary: { principal_id: principalId, key_prefix: reset.record.key_prefix },
        result: "SUCCESS",
      });

      return reply.code(200).send({
        key: reset.plaintext,
        key_prefix: reset.record.key_prefix,
        warning: "新 Key 明文仅展示一次。旧 Key 已撤销，5 秒内全局失效。",
      });
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
        })),
      };
    },
  );
}
