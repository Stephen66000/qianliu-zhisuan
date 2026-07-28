/**
 * Provider/Resource/Model/Route 路由（W04）。
 *
 * 依据：TRD §5.4、§11.2（/providers /provider-resources /unified-models /model-routes）。
 * WT-01：登记资源账号（凭证加密存储，列表只返回指纹）。
 * WT-10：统一模型路由详情（候选、优先级、权重）。
 *
 * 安全：上游凭证明文绝不入 DB、绝不返回 API。createResource 接收明文 → 加密 → 存密文+指纹。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { encryptCredential, credentialFingerprint } from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";

const CreateProviderSchema = z.object({
  code: z.enum(["deepseek", "zhipu", "kimi"]),
  name: z.string().min(1).max(128),
  adapter_type: z.string().min(1).max(32),
  supported_protocols: z.array(z.string()).optional(),
  capability_set: z.record(z.string(), z.unknown()).optional(),
});

const CreateResourceSchema = z.object({
  provider_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_type: z.enum(["API_KEY", "OAUTH", "SUBSCRIPTION_SESSION"]),
  /** 上游凭证明文（一次接收，立即加密，绝不入库）。 */
  credential_plaintext: z.string().min(1),
  upstream_models: z.array(z.string()).optional(),
  concurrency_limit: z.number().int().positive().optional(),
});

const CreateUnifiedModelSchema = z.object({
  alias: z.string().min(1).max(64),
  display_name: z.string().min(1).max(128),
  required_capabilities: z.array(z.string()).optional(),
});

const CreateRouteSchema = z.object({
  unified_model_id: z.string().uuid(),
  provider_resource_id: z.string().uuid(),
  upstream_model: z.string().min(1).max(128),
  priority: z.number().int().optional(),
  weight: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

export function registerProviderRoutes(app: FastifyInstance): void {
  // ===== Provider =====
  app.get("/providers", { preHandler: [requireAuth] }, async (req) => {
    return { providers: await app.providerRepo.listProviders(req.admin!.enterpriseId) };
  });

  app.post("/providers", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const provider = await app.providerRepo.createProvider({
      enterprise_id: req.admin!.enterpriseId,
      ...parsed.data,
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider.create",
      target_type: "provider",
      target_id: provider.id,
      change_summary: { code: provider.code, name: provider.name },
      result: "SUCCESS",
    });
    return reply.code(201).send({ provider });
  });

  // ===== Provider Resource（凭证加密存储）=====
  app.get("/provider-resources", { preHandler: [requireAuth] }, async (req) => {
    const resources = await app.providerRepo.listResources(req.admin!.enterpriseId);
    // 列表只返回指纹，绝不返回密文/明文
    return {
      resources: resources.map((r) => ({
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
        created_at: r.created_at,
      })),
    };
  });

  app.post("/provider-resources", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const { credential_plaintext, ...rest } = parsed.data;

    // 立即加密明文（绝不入库明文）
    const encrypted = encryptCredential(credential_plaintext, app.credentialKek);
    const fingerprint = credentialFingerprint(credential_plaintext);

    const resource = await app.providerRepo.createResource({
      enterprise_id: req.admin!.enterpriseId,
      credential_encrypted: encrypted,
      credential_fingerprint: fingerprint,
      ...rest,
    });

    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.create",
      target_type: "provider_resource",
      target_id: resource.id,
      change_summary: { name: resource.name, mode: resource.mode, credential_fingerprint: fingerprint },
      result: "SUCCESS",
    });

    // 响应只返回指纹（明文不回显）
    return reply.code(201).send({
      resource: {
        id: resource.id,
        name: resource.name,
        mode: resource.mode,
        credential_type: resource.credential_type,
        credential_fingerprint: resource.credential_fingerprint,
        status: resource.status,
      },
    });
  });

  // ===== Unified Model =====
  app.get("/unified-models", { preHandler: [requireAuth] }, async (req) => {
    return { models: await app.providerRepo.listUnifiedModels(req.admin!.enterpriseId) };
  });

  app.post("/unified-models", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateUnifiedModelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const model = await app.providerRepo.createUnifiedModel(
      req.admin!.enterpriseId,
      parsed.data.alias,
      parsed.data.display_name,
      parsed.data.required_capabilities ?? null,
    );
    // W19 补齐：创建统一模型写操作日志（六要素 §11.2）
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "unified_model.create",
      target_type: "unified_model",
      target_id: model.id,
      change_summary: { alias: model.alias, display_name: model.display_name },
      result: "SUCCESS",
    });
    return reply.code(201).send({ model });
  });

  // ===== Model Route（WT-10 路由详情）=====
  app.post("/model-routes", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateRouteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const route = await app.providerRepo.createRoute(
      req.admin!.enterpriseId,
      parsed.data.unified_model_id,
      parsed.data.provider_resource_id,
      parsed.data.upstream_model,
      { priority: parsed.data.priority, weight: parsed.data.weight, enabled: parsed.data.enabled },
    );
    // W19 补齐：创建模型路由写操作日志（六要素 §11.2）
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "model_route.create",
      target_type: "model_route",
      target_id: route.id,
      change_summary: {
        unified_model_id: route.unified_model_id,
        provider_resource_id: route.provider_resource_id,
        upstream_model: route.upstream_model,
        priority: route.priority,
        weight: route.weight,
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({ route });
  });

  // 路由详情：候选、优先级、权重（WT-10）
  app.get<{ Params: { modelId: string } }>(
    "/unified-models/:modelId/routes",
    { preHandler: [requireAuth] },
    async (req) => {
      const routes = await app.providerRepo.listRoutesByModel(
        req.admin!.enterpriseId,
        req.params.modelId,
      );
      return { routes };
    },
  );
}
