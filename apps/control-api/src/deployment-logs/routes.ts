import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DeploymentLogImmutableError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const StatusSchema = z.enum(["IN_PROGRESS", "SUCCEEDED", "FAILED", "ROLLED_BACK"]);
export const DeploymentManifestSchema = z.object({
  deploymentId: z.string().min(1).max(128),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().optional(),
  status: StatusSchema,
  fromVersion: z.string().max(128).nullable().optional(),
  toVersion: z.string().max(128).nullable().optional(),
  gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/i).nullable().optional(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  migrationFrom: z.string().max(128).nullable().optional(),
  migrationTo: z.string().max(128).nullable().optional(),
  releaseId: z.string().max(128).nullable().optional(),
  actor: z.string().min(1).max(128),
  summary: z.string().min(1).max(4000),
  poolRefs: z.array(z.string().regex(/^POOL-\d{3}$/)).max(100).default([]),
  backupRef: z.string().max(256).nullable().optional(),
  rollbackTarget: z.string().max(128).nullable().optional(),
  healthSummary: z.record(z.string(), z.unknown()).nullable().optional(),
  smokeSummary: z.record(z.string(), z.unknown()).nullable().optional(),
  evidenceRefs: z.array(z.string().max(256)).max(100).default([]),
  failureClassification: z.string().max(64).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status !== "IN_PROGRESS" && !value.finishedAt) {
    ctx.addIssue({ code: "custom", message: "终态升级记录必须提供 finishedAt", path: ["finishedAt"] });
  }
});

export function registerDeploymentLogRoutes(app: FastifyInstance): void {
  app.get("/deployment-logs", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
      status: StatusSchema.optional(),
      version: z.string().max(128).optional(),
      pool_ref: z.string().regex(/^POOL-\d{3}$/).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", message: "升级日志筛选条件无效" });
    return app.deploymentLogRepo.list(req.admin!.enterpriseId, {
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      status: parsed.data.status,
      version: parsed.data.version,
      poolRef: parsed.data.pool_ref,
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      to: parsed.data.to ? new Date(parsed.data.to) : undefined,
    });
  });

  app.get<{ Params: { id: string } }>(
    "/deployment-logs/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const result = await app.deploymentLogRepo.get(req.admin!.enterpriseId, req.params.id);
      return result ?? reply.code(404).send({ error: "not_found", message: "升级记录不存在" });
    },
  );

  app.post("/deployment-logs/import", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = DeploymentManifestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_manifest", message: "升级 Manifest 格式无效" });
    if (!isSafeDeploymentManifest(parsed.data)) {
      return reply.code(400).send({ error: "sensitive_manifest", message: "Manifest 含敏感信息或未批准的本机路径" });
    }
    try {
      const deployment = await app.deploymentLogRepo.importManifest(
        req.admin!.enterpriseId,
        {
          ...parsed.data,
          startedAt: new Date(parsed.data.startedAt),
          finishedAt: parsed.data.finishedAt ? new Date(parsed.data.finishedAt) : null,
        },
      );
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "IMPORT_DEPLOYMENT_MANIFEST",
        target_type: "DEPLOYMENT_LOG",
        target_id: deployment.id,
        change_summary: {
          deploymentId: deployment.deployment_id,
          status: deployment.status,
          poolRefs: deployment.pool_refs,
        },
        result: "SUCCESS",
      });
      return { deployment };
    } catch (cause) {
      if (cause instanceof DeploymentLogImmutableError) {
        return reply.code(409).send({ error: "deployment_immutable", message: cause.message });
      }
      throw cause;
    }
  });
}

export function isSafeDeploymentManifest(value: unknown): boolean {
  const visit = (input: unknown, key = ""): boolean => {
    if (/secret|password|cookie|authorization|api.?key|database.?url/i.test(key)) return false;
    if (typeof input === "string") {
      return !/(?:Bearer\s+[A-Za-z0-9._-]+|\bqlk_[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]+|\.env\b|\/Users\/|DATABASE_URL=)/i.test(input);
    }
    if (Array.isArray(input)) return input.every((item) => visit(item, key));
    if (input && typeof input === "object") {
      return Object.entries(input).every(([childKey, child]) => visit(child, childKey));
    }
    return true;
  };
  return visit(value);
}
