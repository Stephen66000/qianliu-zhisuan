/** POOL-033：单主体接入配置编排端点 —— 单人页唯一写入通道。
 *
 * 依据：设计草案 v2 §3。GET 装配读模型，PUT 单事务完成全部写入。
 * 单人页不再调用 PATCH /principals/:id/key 直写白名单，也不再调用 POST /principals/:id/grants
 * 直建 Grant——权限与额度统一经本端点进入规则引擎。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  PrincipalAccessConfigError,
  type PoolSpec,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const PoolSchema = z.object({
  provider_code: z.string().trim().min(1).max(32),
  quota_value: z.string().regex(/^\d+$/, "额度必须是非负整数字符串").transform((v) => BigInt(v)),
  allow_overage: z.boolean().default(false),
  valid_until: z.coerce.date().nullable().default(null),
  enabled_model_ids: z.array(z.string().uuid()).default([]),
});

const PutSchema = z.object({
  expected_version: z.number().int().positive(),
  idempotency_key: z.string().trim().min(8).max(128),
  providers: z.array(PoolSchema).default([]),
});

function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T;
}

function sendError(reply: FastifyReply, error: PrincipalAccessConfigError) {
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "INVALID_STATE" || error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409
    : error.code === "NOT_READY" ? 422
    : 400;
  return reply.code(status).send({
    error: error.code.toLowerCase(), message: error.message, detail: error.detail,
  });
}

export function registerPrincipalAccessConfigRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/principals/:id/access-configuration",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      try {
        const config = await app.principalAccessConfigRepo.read(
          req.admin!.enterpriseId,
          req.params.id,
        );
        return serialize(config);
      } catch (error) {
        if (error instanceof PrincipalAccessConfigError) return sendError(reply, error);
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/principals/:id/access-configuration",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = PutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const pools: PoolSpec[] = parsed.data.providers.map((p) => ({
        provider_code: p.provider_code,
        quota_value: p.quota_value,
        allow_overage: p.allow_overage,
        valid_until: p.valid_until,
        enabled_model_ids: p.enabled_model_ids,
      }));
      try {
        const result = await app.principalAccessConfigRepo.put({
          enterpriseId: req.admin!.enterpriseId,
          principalId: req.params.id,
          adminUserId: req.admin!.adminUserId,
          expectedVersion: parsed.data.expected_version,
          idempotencyKey: parsed.data.idempotency_key,
          pools,
        });
        return serialize(result);
      } catch (error) {
        if (error instanceof PrincipalAccessConfigError) return sendError(reply, error);
        throw error;
      }
    },
  );
}
