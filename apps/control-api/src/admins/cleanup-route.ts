import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminMustBeDisabledError,
  AdminNotFoundError,
  SelfCleanupError,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const IdSchema = z.string().uuid();

function knownCleanupError(error: unknown): {
  code: "self_cleanup_forbidden" | "admin_must_be_disabled" | "not_found";
  status: 404 | 409;
  message: string;
} | null {
  if (error instanceof SelfCleanupError) {
    return {
      code: "self_cleanup_forbidden",
      status: 409,
      message: error.message,
    };
  }
  if (error instanceof AdminMustBeDisabledError) {
    return {
      code: "admin_must_be_disabled",
      status: 409,
      message: error.message,
    };
  }
  if (error instanceof AdminNotFoundError) {
    return { code: "not_found", status: 404, message: error.message };
  }
  return null;
}

async function auditFailure(
  app: FastifyInstance,
  req: FastifyRequest,
  targetId: string | null,
  reason: string,
): Promise<void> {
  await app.auditRepo.write({
    enterprise_id: req.admin!.enterpriseId,
    admin_user_id: req.admin!.adminUserId,
    action: "admin.cleanup",
    target_type: "admin_user",
    target_id: targetId,
    result: "FAILURE",
    failure_reason: reason,
  });
}

export function registerAdminCleanupRoute(app: FastifyInstance): void {
  app.delete(
    "/admins/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const id = IdSchema.safeParse((req.params as { id?: unknown }).id);
      if (!id.success) {
        await auditFailure(app, req, null, "invalid_request");
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "管理员 ID 不合法" });
      }
      try {
        await app.adminRepo.cleanup({
          enterpriseId: req.admin!.enterpriseId,
          actorAdminId: req.admin!.adminUserId,
          targetAdminId: id.data,
        });
        return reply.code(204).send();
      } catch (error) {
        const known = knownCleanupError(error);
        if (!known) throw error;
        await auditFailure(app, req, id.data, known.code);
        return reply.code(known.status).send({
          error: known.code,
          message: known.message,
        });
      }
    },
  );
}
