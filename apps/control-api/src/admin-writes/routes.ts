/**
 * W19 管理写操作路由 —— 更新/停用/凭证恢复（六要素补全）。
 *
 * TRD §11.2 六要素：requireAuth（已登录管理员）、zod 校验 + 对象状态校验、
 * 成功返回最新结果、失败返回明确原因、写操作日志、并发修改乐观锁（409 conflict）。
 *
 * 并发语义：单调 version 乐观锁（P2-01）——前端携带读取时的 version，
 * 期间被他人修改则 409 conflict（W19 DoD「并发修改测试」的落点）。
 */
import type { FastifyInstance } from "fastify";
import { encryptCredential, credentialFingerprint } from "@qianliu/provider-adapters";
import { AdminRecoverNotFoundError, ModelRouteNotReadyError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  RecoverResourceSchema, UpdateBillingRuleSchema, UpdateGrantSchema,
  UpdateModelRouteSchema, UpdateUnifiedModelSchema, resourceView,
} from "./contracts.js";
import { registerAdminArchiveRoutes } from "./archive-routes.js";
import { registerAdminResourceUpdateRoute } from "./resource-route.js";

export function registerAdminWriteRoutes(app: FastifyInstance): void {
  registerAdminArchiveRoutes(app);
  registerAdminResourceUpdateRoute(app);

  // ===== 统一模型：更新 / 停用 =====
  app.patch<{ Params: { id: string } }>(
    "/unified-models/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UpdateUnifiedModelSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;
      const before = (await app.providerRepo.listUnifiedModels(ent)).find(
        (m) => m.id === req.params.id,
      );
      if (!before) {
        return reply.code(404).send({ error: "not_found", message: "统一模型不存在" });
      }
      const updated = await app.adminWriteRepo.updateUnifiedModel(
        ent,
        req.params.id,
        parsed.data.expected_version,
        { display_name: parsed.data.display_name, status: parsed.data.status },
      );
      if (!updated) {
        return reply
          .code(409)
          .send({ error: "conflict", message: "该模型刚被其他管理员修改，请刷新后重试" });
      }
      const action =
        parsed.data.status === "DISABLED"
          ? "unified_model.disable"
          : "unified_model.update";
      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action,
        target_type: "unified_model",
        target_id: updated.id,
        change_summary: {
          before: { display_name: before.display_name, status: before.status },
          after: { display_name: updated.display_name, status: updated.status },
        },
        result: "SUCCESS",
      });
      return { model: updated };
    },
  );

  // ===== 模型路由：启用/停用/优先级/权重 =====
  app.patch<{ Params: { id: string } }>(
    "/model-routes/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UpdateModelRouteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;
      let updated;
      try {
        updated = await app.adminWriteRepo.updateModelRoute(
          ent,
          req.params.id,
          parsed.data.expected_version,
          {
            priority: parsed.data.priority,
            weight: parsed.data.weight,
            enabled: parsed.data.enabled,
          },
        );
      } catch (error) {
        if (error instanceof ModelRouteNotReadyError) {
          return reply.code(409).send({
            error: "model_route_validation_required",
            message: "真实验证通过后才能启用该 Model Route",
          });
        }
        throw error;
      }
      if (!updated) {
        // 乐观锁 0 命中：不存在或期间被修改；区分 404/409 需先读
        const exists = await app.db
          .selectFrom("model_route")
          .select("id")
          .where("id", "=", req.params.id)
          .where("enterprise_id", "=", ent)
          .executeTakeFirst();
        if (!exists) {
          return reply.code(404).send({ error: "not_found", message: "路由不存在" });
        }
        return reply
          .code(409)
          .send({ error: "conflict", message: "该路由刚被其他管理员修改，请刷新后重试" });
      }
      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "model_route.update",
        target_type: "model_route",
        target_id: updated.id,
        change_summary: {
          after: {
            priority: updated.priority,
            weight: updated.weight,
            enabled: updated.enabled,
          },
        },
        result: "SUCCESS",
      });
      return { route: updated };
    },
  );

  // ===== 主体额度：调额 / 允许超额 / 停用 =====
  // @deprecated POOL-033（GLM 评审 P0-1）：直改 Grant 路径仅为旧客户端保留。
  // 新 UI 一律走编排端点 PUT /principals/:id/access-configuration（池额度单事务调整）。
  app.patch<{ Params: { id: string } }>(
    "/grants/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      void reply.header("Deprecation", "true")
        .header("Sunset", "Wed, 30 Sep 2026 00:00:00 GMT")
        .header("Link", '</principals/:id/access-configuration>; rel="successor-version"');
      const parsed = UpdateGrantSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;
      const owner = await app.db
        .selectFrom("principal_grant")
        .innerJoin("principal", "principal.id", "principal_grant.principal_id")
        .select([
          "principal_grant.id",
          "principal.status as principal_status",
          "principal.archived_at",
        ])
        .where("principal_grant.id", "=", req.params.id)
        .where("principal_grant.enterprise_id", "=", ent)
        .where("principal.enterprise_id", "=", ent)
        .executeTakeFirst();
      if (!owner) {
        return reply.code(404).send({ error: "not_found", message: "额度授权不存在" });
      }
      if (owner.archived_at !== null) {
        return reply.code(409).send({
          error: "principal_archived",
          message: "已归档主体的额度授权只读，不能重新启用或修改",
        });
      }
      const updated = await app.adminWriteRepo.updateGrant(
        ent,
        req.params.id,
        parsed.data.expected_version,
        {
          quota_value: parsed.data.quota_value,
          allow_overage: parsed.data.allow_overage,
          valid_until:
            parsed.data.valid_until === undefined
              ? undefined
              : parsed.data.valid_until === null
                ? null
                : new Date(parsed.data.valid_until),
          status: parsed.data.status,
        },
      );
      if (!updated) {
        const exists = await app.db
          .selectFrom("principal_grant")
          .select("id")
          .where("id", "=", req.params.id)
          .where("enterprise_id", "=", ent)
          .executeTakeFirst();
        if (!exists) {
          return reply.code(404).send({ error: "not_found", message: "额度授权不存在" });
        }
        return reply
          .code(409)
          .send({ error: "conflict", message: "该额度刚被其他管理员修改，请刷新后重试" });
      }
      const action =
        parsed.data.status === "DISABLED" ? "grant.disable" : "grant.update";
      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action,
        target_type: "principal_grant",
        target_id: updated.id,
        change_summary: {
          after: {
            quota_value: updated.quota_value.toString(),
            allow_overage: updated.allow_overage,
            status: updated.status,
          },
        },
        result: "SUCCESS",
      });
      return { grant: updated };
    },
  );

  // ===== 计价规则：价格 / 优先级 / 启停 =====
  app.patch<{ Params: { id: string } }>(
    "/billing-rules/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UpdateBillingRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;
      const before = await app.db
        .selectFrom("billing_rule")
        .selectAll()
        .where("id", "=", req.params.id)
        .where("enterprise_id", "=", ent)
        .executeTakeFirst();
      if (!before) {
        return reply.code(404).send({ error: "not_found", message: "计价规则不存在" });
      }
      const updated = await app.adminWriteRepo.updateBillingRule(
        ent,
        req.params.id,
        parsed.data.expected_version,
        {
          effective_to:
            parsed.data.effective_to === undefined
              ? undefined
              : parsed.data.effective_to === null
                ? null
                : new Date(parsed.data.effective_to),
          enabled: parsed.data.enabled,
        },
      );
      if (!updated) {
        return reply
          .code(409)
          .send({ error: "conflict", message: "该规则刚被其他管理员修改，请刷新后重试" });
      }
      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "billing_rule.update",
        target_type: "billing_rule",
        target_id: updated.id,
        change_summary: {
          after: {
            enabled: updated.enabled,
            effective_to: updated.effective_to,
          },
        },
        result: "SUCCESS",
      });
      return { rule: updated };
    },
  );

  // ===== 凭证恢复（WT-19 受控恢复，可选同时轮换凭证） =====
  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/recover",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = RecoverResourceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;

      const rotation = parsed.data.credential_plaintext
        ? {
            credential_encrypted: encryptCredential(
              parsed.data.credential_plaintext,
              app.credentialKek,
            ),
            credential_fingerprint: credentialFingerprint(parsed.data.credential_plaintext),
          }
        : undefined;

      try {
        const recovered = await app.adminWriteRepo.adminRecoverResource(
          ent,
          req.params.id,
          rotation,
        );
        if (!recovered) {
          return reply.code(409).send({
            error: "invalid_state",
            message: "该资源当前不在隔离状态（凭证失效/耗尽/过期/不可用），无需恢复",
          });
        }
        await app.auditRepo.write({
          enterprise_id: ent,
          admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.recover",
          target_type: "provider_resource",
          target_id: recovered.id,
          change_summary: {
            rotated_credential: rotation !== undefined,
            credential_fingerprint: recovered.credential_fingerprint,
            credential_version: recovered.credential_version,
            to_status: recovered.status,
          },
          result: "SUCCESS",
        });
        return { resource: resourceView(recovered) };
      } catch (error) {
        if (error instanceof AdminRecoverNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: "资源不存在" });
        }
        throw error;
      }
    },
  );
}
