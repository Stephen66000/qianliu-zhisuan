import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const UpdateSettings = z.object({
  expected_version: z.number().int().positive(),
  name: z.string().trim().min(1).max(255).optional(),
  management_contact: z.union([z.string().trim().max(128), z.null()]).optional(),
  contact_email: z.union([z.string().trim().email().max(320), z.literal(""), z.null()]).optional(),
  timezone: z.string().trim().min(1).max(64).refine(isTimezone, "无效的 IANA 时区").optional(),
  default_currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).refine((value) => value.name !== undefined || value.management_contact !== undefined ||
  value.contact_email !== undefined || value.timezone !== undefined ||
  value.default_currency !== undefined, {
  message: "至少修改一个字段",
});

interface EnterpriseSettingsRow {
  id: string;
  name: string;
  management_contact: string | null;
  contact_email: string | null;
  timezone: string;
  default_currency: string;
  version: number;
  updated_at: Date;
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function view(row: EnterpriseSettingsRow) {
  return { ...row, updated_at: row.updated_at.toISOString() };
}

export function registerEnterpriseSettingsRoutes(app: FastifyInstance): void {
  app.get("/enterprise-settings", { preHandler: [requireAuth] }, async (req, reply) => {
    const result = await sql<EnterpriseSettingsRow>`
      SELECT id, name, management_contact, contact_email, timezone, default_currency, version, updated_at
        FROM enterprise WHERE id = ${req.admin!.enterpriseId}::uuid
    `.execute(app.db);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { settings: view(row) };
  });

  app.patch("/enterprise-settings", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = UpdateSettings.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const { expected_version: expectedVersion, ...patch } = parsed.data;
    const beforeResult = await sql<EnterpriseSettingsRow>`
      SELECT id, name, management_contact, contact_email, timezone, default_currency, version, updated_at
        FROM enterprise WHERE id = ${req.admin!.enterpriseId}::uuid
    `.execute(app.db);
    const before = beforeResult.rows[0];
    if (!before) return reply.code(404).send({ error: "not_found" });
    const result = await sql<EnterpriseSettingsRow>`
      UPDATE enterprise SET
        name = coalesce(${patch.name ?? null}, name),
        management_contact = CASE WHEN ${patch.management_contact !== undefined}
          THEN ${patch.management_contact || null} ELSE management_contact END,
        contact_email = CASE WHEN ${patch.contact_email !== undefined}
          THEN ${patch.contact_email || null} ELSE contact_email END,
        timezone = coalesce(${patch.timezone ?? null}, timezone),
        default_currency = coalesce(${patch.default_currency ?? null}, default_currency),
        version = version + 1,
        updated_at = now()
       WHERE id = ${req.admin!.enterpriseId}::uuid AND version = ${expectedVersion}
       RETURNING id, name, management_contact, contact_email, timezone, default_currency, version, updated_at
    `.execute(app.db);
    const updated = result.rows[0];
    if (!updated) {
      return reply.code(409).send({ error: "conflict", message: "企业设置已被其他管理员修改" });
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
      action: "enterprise_settings.update", target_type: "enterprise", target_id: updated.id,
      change_summary: { before: view(before), after: view(updated) }, result: "SUCCESS",
    });
    return { settings: view(updated) };
  });
}
