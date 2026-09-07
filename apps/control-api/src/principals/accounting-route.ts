import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  readPrincipalAccounting,
  savePrincipalAccounting,
  PrincipalAccountingError,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import { registerAttributionBackfillRoutes } from "./attribution-backfill-route.js";
const params = z.object({ id: z.string().uuid() });
const body = z.object({
  department_id: z.string().uuid().optional(),
  department_name: z.string().trim().min(1).max(255).optional(),
  owner_principal_id: z.string().uuid().optional(),
  expected_version: z.number().int().nonnegative(),
});
export function registerPrincipalAccountingRoutes(app: FastifyInstance) {
  registerAttributionBackfillRoutes(app);
  app.get<{ Params: { id: string } }>(
    "/principals/:id/accounting-profile",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      if (!params.safeParse(req.params).success)
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "主体 ID 不合法" });
      try {
        return await readPrincipalAccounting(
          app.db,
          req.admin!.enterpriseId,
          req.params.id,
        );
      } catch (error) {
        if (error instanceof PrincipalAccountingError)
          return reply
            .code(404)
            .send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );
  app.put<{ Params: { id: string } }>(
    "/principals/:id/accounting-profile",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const value = body.safeParse(req.body);
      if (!params.safeParse(req.params).success || !value.success)
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "归属参数不合法" });
      try {
        return await savePrincipalAccounting(app.db, {
          enterpriseId: req.admin!.enterpriseId,
          principalId: req.params.id,
          adminId: req.admin!.adminUserId,
          departmentId: value.data.department_id,
          departmentName: value.data.department_name,
          ownerPrincipalId: value.data.owner_principal_id,
          expectedVersion: value.data.expected_version,
        });
      } catch (error) {
        if (error instanceof PrincipalAccountingError)
          return reply
            .code(
              error.code === "NOT_FOUND"
                ? 404
                : error.code === "CONFLICT"
                  ? 409
                  : 400,
            )
            .send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );
}
