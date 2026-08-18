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
import { z } from "zod";
import { encryptCredential, credentialFingerprint } from "@qianliu/provider-adapters";
import { AdminRecoverNotFoundError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  OperatingSnapshotSchema,
  operatingSnapshotModeError,
  toOperatingSnapshotInput,
} from "../providers/contracts.js";
import type { ResourceViewInput } from "./types.js";

/** 单调版本号乐观锁（P2-01）：前端携带读取时的 version，期间被改则 409 conflict。 */
const ExpectedVersion = z.number().int().positive();

/** 额度值（P2-02）：先字符串正则校验非负整数，再转 BigInt；拒绝 abc/1.5/-1（此前会变 500 或接受负值）。 */
const QuotaValue = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((v) => /^\d+$/.test(v), { message: "额度必须是非负整数" })
  .transform((v) => BigInt(v));

const UpdateResourceSchema = z.object({
  expected_version: ExpectedVersion,
  name: z.string().min(1).max(255).optional(),
  concurrency_limit: z.number().int().positive().nullable().optional(),
  upstream_models: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  operating_snapshot: OperatingSnapshotSchema.optional(),
  monthly_budget_amount: z.string().regex(/^\d+(?:\.\d{1,8})?$/).nullable().optional(), monthly_budget_currency: z.string().regex(/^[A-Z]{3,8}$/).nullable().optional(),
}).superRefine((value, ctx) => {
  const amountSet = value.monthly_budget_amount !== undefined, currencySet = value.monthly_budget_currency !== undefined;
  if (amountSet !== currencySet) ctx.addIssue({ code: "custom", path: ["monthly_budget_amount"], message: "预算金额与币种必须同时提交" });
});

const UpdateUnifiedModelSchema = z.object({
  expected_version: ExpectedVersion,
  display_name: z.string().min(1).max(128).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

const UpdateModelRouteSchema = z.object({
  expected_version: ExpectedVersion,
  priority: z.number().int().optional(),
  weight: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

const UpdateGrantSchema = z.object({
  expected_version: ExpectedVersion,
  quota_value: QuotaValue.optional(),
  allow_overage: z.boolean().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

const UpdateBillingRuleSchema = z
  .object({
    expected_version: ExpectedVersion,
    effective_to: z.string().datetime().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  // 价格、倍率、窗口和优先级共同定义规则版本，禁止原地改写。
  // 变更这些字段必须 POST 新 rule_version，并用 effective_from/effective_to 切换。
  .strict();

const ArchiveLifecycleSchema = z.object({ expected_version: ExpectedVersion }).strict();

const RecoverResourceSchema = z.object({
  /** 可选：同时轮换凭证（明文一次接收，立即加密，绝不入库）。 */
  credential_plaintext: z.string().min(1).optional(),
});

/** 资源公开视图（绝不返回密文/明文）。 */
function resourceView(r: ResourceViewInput, operatingSnapshot: unknown = null) {
  return {
    id: r.id,
    provider_id: r.provider_id,
    name: r.name,
    mode: r.mode,
    credential_type: r.credential_type,
    credential_fingerprint: r.credential_fingerprint,
    credential_version: r.credential_version,
    status: r.status,
    upstream_models: r.upstream_models,
    concurrency_limit: r.concurrency_limit,
    version: r.version,
    monthly_budget_amount: r.monthly_budget_amount ?? null, monthly_budget_currency: r.monthly_budget_currency ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    operating_snapshot: operatingSnapshot,
  };
}

export function registerAdminWriteRoutes(app: FastifyInstance): void {
  // ===== 厂商资源：基础信息更新（并发乐观锁） =====
  app.patch<{ Params: { id: string } }>(
    "/provider-resources/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UpdateResourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const ent = req.admin!.enterpriseId;
      const before = (await app.providerRepo.listResources(ent)).find(
        (r) => r.id === req.params.id,
      );
      if (!before) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      if (parsed.data.operating_snapshot) {
        const modeError = operatingSnapshotModeError(
          before.mode,
          parsed.data.operating_snapshot,
        );
        if (modeError) {
          return reply
            .code(400)
            .send({ error: "invalid_operating_mode", message: modeError });
        }
      }
      const updated = await app.adminWriteRepo.updateProviderResource(
        ent,
        req.params.id,
        parsed.data.expected_version,
        {
          name: parsed.data.name,
          concurrency_limit: parsed.data.concurrency_limit,
          upstream_models: parsed.data.upstream_models,
          operating_snapshot: parsed.data.operating_snapshot
            ? toOperatingSnapshotInput(parsed.data.operating_snapshot, before.mode)
            : undefined,
          monthly_budget_amount: parsed.data.monthly_budget_amount, monthly_budget_currency: parsed.data.monthly_budget_currency,
        },
      );
      if (!updated) {
        return reply
          .code(409)
          .send({ error: "conflict", message: "该资源刚被其他管理员修改，请刷新后重试" });
      }
      await app.auditRepo.write({
        enterprise_id: ent,
        admin_user_id: req.admin!.adminUserId,
        action: "provider_resource.update",
        target_type: "provider_resource",
        target_id: updated.id,
        change_summary: {
          before: {
            name: before.name,
            concurrency_limit: before.concurrency_limit,
            upstream_models: before.upstream_models,
            monthly_budget_amount: before.monthly_budget_amount, monthly_budget_currency: before.monthly_budget_currency,
          },
          after: {
            name: updated.name,
            concurrency_limit: updated.concurrency_limit,
            upstream_models: updated.upstream_models,
            monthly_budget_amount: updated.monthly_budget_amount, monthly_budget_currency: updated.monthly_budget_currency,
          },
        },
        result: "SUCCESS",
      });
      const snapshot = parsed.data.operating_snapshot
        ? (await app.providerRepo.listCurrentOperatingSnapshots(ent))
            .find((item) => item.provider_resource_id === updated.id) ?? null
        : null;
      return { resource: resourceView(updated, snapshot) };
    },
  );

  app.post<{ Params: { id: string; action: string } }>(
    "/unified-models/:id/:action",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const action = z.enum(["archive", "unarchive"]).safeParse(req.params.action);
      const parsed = ArchiveLifecycleSchema.safeParse(req.body);
      if (!action.success) return reply.code(404).send({ error: "not_found", message: "未知归档操作" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const archived = action.data === "archive";
      const updated = await app.adminWriteRepo.setUnifiedModelArchived(
        req.admin!.enterpriseId,
        req.params.id,
        parsed.data.expected_version,
        archived,
        req.admin!.adminUserId,
      );
      if (!updated) {
        return reply.code(409).send({
          error: "invalid_state",
          message: archived ? "统一模型必须先停用，且版本未被修改，才能归档" : "统一模型未归档或版本已变化",
        });
      }
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: `unified_model.${action.data}`,
        target_type: "unified_model",
        target_id: updated.id,
        change_summary: { archived_at: updated.archived_at, status: updated.status },
        result: "SUCCESS",
      });
      return { model: updated };
    },
  );

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

  app.post<{ Params: { id: string; action: string } }>(
    "/model-routes/:id/:action",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const action = z.enum(["archive", "unarchive"]).safeParse(req.params.action);
      const parsed = ArchiveLifecycleSchema.safeParse(req.body);
      if (!action.success) return reply.code(404).send({ error: "not_found", message: "未知归档操作" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const archived = action.data === "archive";
      const updated = await app.adminWriteRepo.setModelRouteArchived(
        req.admin!.enterpriseId,
        req.params.id,
        parsed.data.expected_version,
        archived,
        req.admin!.adminUserId,
      );
      if (!updated) {
        return reply.code(409).send({
          error: "invalid_state",
          message: archived ? "Model Route 必须先停用，且版本未被修改，才能归档" : "Model Route 未归档或版本已变化",
        });
      }
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: `model_route.${action.data}`,
        target_type: "model_route",
        target_id: updated.id,
        change_summary: { archived_at: updated.archived_at, enabled: updated.enabled },
        result: "SUCCESS",
      });
      return { route: updated };
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
      const updated = await app.adminWriteRepo.updateModelRoute(
        ent,
        req.params.id,
        parsed.data.expected_version,
        {
          priority: parsed.data.priority,
          weight: parsed.data.weight,
          enabled: parsed.data.enabled,
        },
      );
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

  app.post<{ Params: { id: string; action: string } }>(
    "/billing-rules/:id/:action",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const action = z.enum(["archive", "unarchive"]).safeParse(req.params.action);
      const parsed = ArchiveLifecycleSchema.safeParse(req.body);
      if (!action.success) return reply.code(404).send({ error: "not_found", message: "未知归档操作" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const archived = action.data === "archive";
      const updated = await app.adminWriteRepo.setBillingRuleArchived(
        req.admin!.enterpriseId,
        req.params.id,
        parsed.data.expected_version,
        archived,
        req.admin!.adminUserId,
      );
      if (!updated) {
        return reply.code(409).send({
          error: "invalid_state",
          message: archived ? "计价规则必须先停用，且版本未被修改，才能归档" : "计价规则未归档或版本已变化",
        });
      }
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: `billing_rule.${action.data}`,
        target_type: "billing_rule",
        target_id: updated.id,
        change_summary: { archived_at: updated.archived_at, enabled: updated.enabled },
        result: "SUCCESS",
      });
      return { rule: updated };
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
