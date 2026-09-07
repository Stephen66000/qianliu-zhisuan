import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PrincipalAccountingError,
  previewPrincipalAttributionBackfill,
  confirmPrincipalAttributionBackfill,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = new Date(`${value}T00:00:00+08:00`).getTime();
    return (
      Number.isFinite(time) &&
      new Date(time + 8 * 3600000).toISOString().slice(0, 10) === value
    );
  });
const body = z.object({
  from: day,
  to: day,
  department_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export function registerAttributionBackfillRoutes(app: FastifyInstance) {
  for (const preview of [true, false])
    app.post<{ Params: { id: string } }>(
      `/principals/:id/attribution-backfill${preview ? "/preview" : ""}`,
      { preHandler: [requireAuth] },
      async (req, reply) => {
        const parsed = body.safeParse(req.body);
        if (
          !z.string().uuid().safeParse(req.params.id).success ||
          !parsed.success ||
          (!preview && !parsed.data.fingerprint)
        )
          return reply
            .code(400)
            .send({
              error: "invalid_request",
              message: "请填写有效的日期、部门与确认依据，并先预览",
            });
        const input = {
          enterpriseId: req.admin!.enterpriseId,
          principalId: req.params.id,
          departmentId: parsed.data.department_id,
          from: new Date(`${parsed.data.from}T00:00:00+08:00`),
          until: new Date(
            new Date(`${parsed.data.to}T00:00:00+08:00`).getTime() + 86400000,
          ),
        };
        try {
          return preview
            ? await previewPrincipalAttributionBackfill(app.db, input)
            : await confirmPrincipalAttributionBackfill(app.db, {
                ...input,
                adminId: req.admin!.adminUserId,
                reason: parsed.data.reason,
                fingerprint: parsed.data.fingerprint!,
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
