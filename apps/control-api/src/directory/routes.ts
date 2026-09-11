import { createHash } from "node:crypto";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { DirectoryRepository, DirectoryRepositoryError } from "@qianliu/database";
import { credentialFingerprint, encryptCredential } from "@qianliu/provider-adapters";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";
import { MemberQuery, RunItemsQuery, SaveSourceBody, SourceType, TEMPLATE_VERSION } from "./contracts.js";
import {
  buildDirectoryTemplate, DirectoryExcelError, MAX_EXCEL_BYTES, parseActivationListExcel, parseDirectoryExcel,
} from "./excel.js";

const ActivateMembersSchema = z.object({
  person_ids: z.array(z.string().uuid()).min(1).max(1000),
});

const ActivateByListSchema = z.object({
  identifiers: z.array(z.string().trim().max(128)).min(1).max(1000),
});

interface DirectorySourceRow { id: string; type: "WECOM" | "FEISHU"; config_fingerprint: string; cursor: string | null; status: string; version: number; last_successful_sync_at: Date | null; last_error_code: string | null; updated_at: Date }

function sourceView(row: DirectorySourceRow) {
  return { ...row, last_successful_sync_at: row.last_successful_sync_at?.toISOString() ?? null, updated_at: row.updated_at.toISOString() };
}

export function registerDirectoryRoutes(app: FastifyInstance): void {
  const repository = new DirectoryRepository(app.db);
  void app.register(multipart, {
    limits: { files: 1, fields: 2, fileSize: MAX_EXCEL_BYTES, parts: 3 },
    throwFileSizeLimit: true,
  });

  app.get("/organization-units", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await sql<{ id: string; parent_id: string | null; name: string; status: string; version: number; external_unit_id: string | null }>`
      WITH RECURSIVE tree AS (
        SELECT id, parent_id, name, status, version, external_unit_id, name::text AS path, ARRAY[id] AS ancestors
          FROM organization_unit WHERE enterprise_id = ${req.admin!.enterpriseId}::uuid AND parent_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, child.status, child.version, child.external_unit_id,
               tree.path || '/' || child.name, tree.ancestors || child.id
          FROM organization_unit child JOIN tree ON child.parent_id = tree.id
         WHERE child.enterprise_id = ${req.admin!.enterpriseId}::uuid AND NOT child.id = ANY(tree.ancestors)
      ) SELECT id, parent_id, name, status, version, external_unit_id, path FROM tree
        WHERE ${parsed.data.status ?? null}::text IS NULL OR status = ${parsed.data.status ?? null}
        ORDER BY path, id
    `.execute(app.db);
    return { units: result.rows };
  });

  app.get("/directory-members", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = MemberQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const q = parsed.data; const pattern = `%${q.search ?? ""}%`;
    const result = await sql<{ person_id: string; principal_id: string | null; name: string; employee_number: string | null; mobile: string | null; department_id: string | null; department_name: string | null; source_type: "WECOM" | "FEISHU" | "EXCEL" | null; external_member_id: string | null; person_status: string; principal_status: string | null; access_config_status: "CONFIGURED" | "PENDING" | "MISSING"; total_count: string }>`
      SELECT p.id AS person_id, pr.id AS principal_id, p.name, p.employee_number, p.mobile,
             ou.id AS department_id, ou.name AS department_name,
             coalesce(latest_identity.type, latest_item.source_type, m.source) AS source_type,
             coalesce(latest_identity.provider_user_id, latest_item.external_member_id) AS external_member_id,
             p.status AS person_status, pr.status AS principal_status,
             CASE WHEN ac.principal_id IS NOT NULL THEN 'CONFIGURED'
                  WHEN pr.id IS NOT NULL THEN 'PENDING' ELSE 'MISSING' END AS access_config_status,
             count(*) OVER()::text AS total_count
        FROM person p
        LEFT JOIN principal pr ON pr.enterprise_id = p.enterprise_id AND pr.person_id = p.id AND pr.type = 'EMPLOYEE' AND pr.archived_at IS NULL
        LEFT JOIN organization_membership m ON m.enterprise_id = p.enterprise_id AND m.person_id = p.id AND m.is_primary AND m.valid_until IS NULL
        LEFT JOIN organization_unit ou ON ou.enterprise_id = p.enterprise_id AND ou.id = m.organization_unit_id
        LEFT JOIN LATERAL (
          SELECT identity.provider_user_id, coalesce(ds.type, identity.provider) AS type
            FROM person_external_identity identity
            LEFT JOIN directory_source ds
              ON ds.enterprise_id = identity.enterprise_id AND ds.id = identity.directory_source_id
           WHERE identity.enterprise_id = p.enterprise_id AND identity.person_id = p.id
             AND identity.status = 'ACTIVE'
           ORDER BY identity.updated_at DESC, identity.id DESC
           LIMIT 1
        ) latest_identity ON TRUE
        LEFT JOIN LATERAL (
          SELECT item.external_member_id, ds.type AS source_type
            FROM directory_import_item item
            JOIN directory_import_run r ON r.id = item.run_id AND r.enterprise_id = item.enterprise_id
            LEFT JOIN directory_source ds ON ds.id = r.directory_source_id AND ds.enterprise_id = r.enterprise_id
           WHERE item.enterprise_id = p.enterprise_id AND item.person_id = p.id
           ORDER BY item.updated_at DESC, item.id DESC
           LIMIT 1
        ) latest_item ON TRUE
        LEFT JOIN principal_access_config_state ac ON ac.enterprise_id = p.enterprise_id AND ac.principal_id = pr.id
       WHERE p.enterprise_id = ${req.admin!.enterpriseId}::uuid
         AND (${q.search ?? ""} = '' OR p.name ILIKE ${pattern} OR coalesce(p.employee_number, '') ILIKE ${pattern} OR coalesce(p.mobile, '') ILIKE ${pattern} OR coalesce(latest_identity.provider_user_id, '') ILIKE ${pattern} OR coalesce(latest_item.external_member_id, '') ILIKE ${pattern})
         AND (${q.department_id ?? null}::uuid IS NULL OR ou.id = ${q.department_id ?? null}::uuid)
         AND (${q.status ?? null}::text IS NULL OR p.status = ${q.status ?? null})
       ORDER BY p.name, p.id LIMIT ${q.limit} OFFSET ${q.offset}
    `.execute(app.db);
    return { items: result.rows.map(({ total_count: _, ...row }) => row), total: Number(result.rows[0]?.total_count ?? 0), limit: q.limit, offset: q.offset };
  });

  app.delete<{ Params: { personId: string } }>(
    "/directory-members/:personId",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const personId = req.params.personId;
      const enterpriseId = req.admin!.enterpriseId;

      const activePrincipal = await sql<{ id: string; name: string }>`
        SELECT id, name FROM principal
        WHERE enterprise_id = ${enterpriseId}::uuid
          AND person_id = ${personId}::uuid
          AND archived_at IS NULL
          AND status = 'ACTIVE'
        LIMIT 1
      `.execute(app.db);

      if (activePrincipal.rows.length > 0) {
        return reply.code(409).send({
          error: "active_principal_exists",
          message: `该人员已开通 AI 员工主体「${activePrincipal.rows[0]?.name ?? ""}」，请先停用或归档主体后再清理通讯录`,
        });
      }

      const person = await sql<{ id: string; name: string }>`
        SELECT id, name FROM person
        WHERE enterprise_id = ${enterpriseId}::uuid AND id = ${personId}::uuid
      `.execute(app.db);

      if (!person.rows.length) {
        return reply.code(404).send({ error: "not_found", message: "未找到指定通讯录人员" });
      }

      await app.db.transaction().execute(async (trx) => {
        await sql`
          UPDATE directory_import_item SET person_id = NULL
          WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ${personId}::uuid
        `.execute(trx);
        await sql`
          DELETE FROM notification_delivery
          WHERE recipient_person_id = ${personId}::uuid
        `.execute(trx);
        await sql`
          DELETE FROM person_external_identity
          WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ${personId}::uuid
        `.execute(trx);
        await sql`
          DELETE FROM organization_membership
          WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ${personId}::uuid
        `.execute(trx);
        await sql`
          UPDATE project_department_assignment SET owner_person_id_at_assignment = NULL
          WHERE enterprise_id = ${enterpriseId}::uuid AND owner_person_id_at_assignment = ${personId}::uuid
        `.execute(trx);
        await sql`
          UPDATE principal SET person_id = NULL
          WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ${personId}::uuid
        `.execute(trx);
        await sql`
          UPDATE principal SET owner_person_id = NULL
          WHERE enterprise_id = ${enterpriseId}::uuid AND owner_person_id = ${personId}::uuid
        `.execute(trx);
        await sql`
          DELETE FROM person
          WHERE enterprise_id = ${enterpriseId}::uuid AND id = ${personId}::uuid
        `.execute(trx);
      });

      await app.auditRepo.write({
        enterprise_id: enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "directory_members.delete",
        target_type: "person",
        target_id: personId,
        change_summary: { name: person.rows[0]?.name ?? "" },
        result: "SUCCESS",
      });

      return { ok: true, person_id: personId };
    },
  );

  app.post("/directory-members/batch-delete", { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z.object({ person_ids: z.array(z.string().uuid()).min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: body.error.message });
    const enterpriseId = req.admin!.enterpriseId;
    const ids = body.data.person_ids;

    const activePrincipals = await sql<{ person_id: string }>`
      SELECT person_id FROM principal
      WHERE enterprise_id = ${enterpriseId}::uuid
        AND person_id = ANY(${ids}::uuid[])
        AND archived_at IS NULL
        AND status = 'ACTIVE'
    `.execute(app.db);

    const activeSet = new Set(activePrincipals.rows.map((r) => r.person_id));
    const deletableIds = ids.filter((id) => !activeSet.has(id));

    if (deletableIds.length === 0) {
      return reply.code(409).send({
        error: "all_members_active",
        message: "所选人员均已开通活跃 AI 员工主体，无法直接清理",
      });
    }

    await app.db.transaction().execute(async (trx) => {
      await sql`
        UPDATE directory_import_item SET person_id = NULL
        WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        DELETE FROM notification_delivery
        WHERE recipient_person_id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        DELETE FROM person_external_identity
        WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        DELETE FROM organization_membership
        WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        UPDATE project_department_assignment SET owner_person_id_at_assignment = NULL
        WHERE enterprise_id = ${enterpriseId}::uuid AND owner_person_id_at_assignment = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        UPDATE principal SET person_id = NULL
        WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        UPDATE principal SET owner_person_id = NULL
        WHERE enterprise_id = ${enterpriseId}::uuid AND owner_person_id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
      await sql`
        DELETE FROM person
        WHERE enterprise_id = ${enterpriseId}::uuid AND id = ANY(${deletableIds}::uuid[])
      `.execute(trx);
    });

    await app.auditRepo.write({
      enterprise_id: enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "directory_members.batch_delete",
      target_type: "person",
      target_id: null,
      change_summary: { requested_count: ids.length, deleted_count: deletableIds.length, skipped_active_count: activeSet.size },
      result: "SUCCESS",
    });

    return { deleted_count: deletableIds.length, skipped_active_count: activeSet.size };
  });

  app.post("/directory-members/activate", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ActivateMembersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    try {
      const result = await repository.activateMembers(
        req.admin!.enterpriseId, parsed.data.person_ids, req.admin!.adminUserId,
      );
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "directory_members.activate",
        target_type: "person",
        target_id: null,
        change_summary: {
          requested_count: parsed.data.person_ids.length,
          activated_count: result.activatedCount,
          already_active_count: result.alreadyActiveCount,
        },
        result: "SUCCESS",
      });
      return {
        activated_count: result.activatedCount,
        already_active_count: result.alreadyActiveCount,
        items: result.results.map((item) => ({
          person_id: item.personId, principal_id: item.principalId, status: item.status,
        })),
      };
    } catch (error) {
      if (error instanceof DirectoryRepositoryError) {
        if (error.code === "NOT_FOUND") {
          return reply.code(404).send({ error: "person_not_found", message: "名单中包含不存在或无权限开通的人员" });
        }
        return reply.code(400).send({ error: error.code.toLowerCase(), message: error.message });
      }
      throw error;
    }
  });

  app.post("/directory-members/activate-by-list", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ActivateByListSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    try {
      const result = await repository.activateMembersByIdentifiers(
        req.admin!.enterpriseId, parsed.data.identifiers, req.admin!.adminUserId,
      );
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "directory_members.activate_by_list",
        target_type: "person",
        target_id: null,
        change_summary: {
          identifier_count: parsed.data.identifiers.length,
          activated_count: result.activatedCount,
          already_active_count: result.alreadyActiveCount,
          not_found_count: result.notFound.length,
        },
        result: "SUCCESS",
      });
      return {
        activated_count: result.activatedCount,
        already_active_count: result.alreadyActiveCount,
        not_found: result.notFound,
      };
    } catch (error) {
      if (error instanceof DirectoryRepositoryError) {
        return reply.code(400).send({ error: error.code.toLowerCase(), message: error.message });
      }
      throw error;
    }
  });

  app.post("/directory-members/activate-list-preview", { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const data = await req.file({ limits: { fileSize: MAX_EXCEL_BYTES, files: 1 } });
      if (!data || !data.filename.toLowerCase().endsWith(".xlsx")) return reply.code(400).send({ error: "invalid_file_type" });
      const identifiers = await parseActivationListExcel(await data.toBuffer());
      return { identifiers };
    } catch (error) {
      if (error instanceof DirectoryExcelError) return reply.code(400).send({ error: error.code, message: error.message });
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "FILE_TOO_LARGE" });
      throw error;
    }
  });

  app.get<{ Params: { type: string } }>("/directory-sources/:type", { preHandler: [requireAuth] }, async (req, reply) => {
    const type = SourceType.safeParse(req.params.type); if (!type.success) return reply.code(400).send({ error: "invalid_request" });
    const source = await repository.getSource(req.admin!.enterpriseId, type.data);
    return { source: source ? sourceView(source) : null };
  });

  app.put<{ Params: { type: string } }>("/directory-sources/:type", { preHandler: [requireAuth] }, async (req, reply) => {
    const type = SourceType.safeParse(req.params.type); const body = SaveSourceBody.safeParse(req.body);
    if (!type.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: body.success ? "来源类型无效" : body.error.message });
    const required = type.data === "WECOM" ? ["corp_id", "corp_secret"] : ["app_id", "app_secret"];
    if (required.some((key) => !body.data.config[key])) {
      return reply.code(400).send({ error: "invalid_request", message: `${type.data} 连接参数不完整` });
    }
    const plaintext = JSON.stringify(body.data.config);
    try {
      const saved = await repository.upsertSource({
        enterpriseId: req.admin!.enterpriseId,
        actorAdminUserId: req.admin!.adminUserId,
        type: type.data,
        configCiphertext: JSON.stringify(encryptCredential(plaintext, app.credentialKek)),
        configFingerprint: credentialFingerprint(plaintext),
        expectedVersion: body.data.expected_version,
        status: body.data.status,
      });
      return { source: sourceView(saved) };
    } catch (error) {
      if (error instanceof DirectoryRepositoryError && error.code === "CONFLICT") {
        return reply.code(409).send({ error: "conflict", message: error.message });
      }
      throw error;
    }
  });

  app.post("/directory-sync-runs", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ source_id: z.string().uuid(), idempotency_key: z.string().min(8).max(128) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const requestHash = hash({ sourceId: parsed.data.source_id });
    try {
      const created = await repository.createRun({
        enterpriseId: req.admin!.enterpriseId,
        mode: "SYNC",
        directorySourceId: parsed.data.source_id,
        idempotencyKey: parsed.data.idempotency_key,
        requestHash,
        createdByAdminUserId: req.admin!.adminUserId,
      });
      return reply.code(created.replayed ? 200 : 202).send({
        runId: created.run.id, status: created.run.status, replayed: created.replayed,
      });
    } catch (error) {
      if (error instanceof DirectoryRepositoryError) {
        if (error.code === "NOT_FOUND" || error.code === "SOURCE_INACTIVE") {
          return reply.code(404).send({ error: "not_found", message: error.message });
        }
        if (error.code === "IDEMPOTENCY_CONFLICT") {
          return reply.code(409).send({ error: "idempotency_conflict", message: error.message });
        }
      }
      throw error;
    }
  });

  app.get("/directory-excel-template", { preHandler: [requireAuth] }, async (_req, reply) => {
    const template = await buildDirectoryTemplate();
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("content-disposition", `attachment; filename*=UTF-8''qianliu-directory-${TEMPLATE_VERSION}.xlsx`).header("x-template-version", TEMPLATE_VERSION).header("x-content-sha256", template.sha256).send(template.bytes);
  });

  app.post("/directory-excel-imports", { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const data = await req.file({ limits: { fileSize: MAX_EXCEL_BYTES, files: 1 } });
      if (!data || !data.filename.toLowerCase().endsWith(".xlsx")) return reply.code(400).send({ error: "invalid_file_type" });
      const bytes = await data.toBuffer(); const rows = await parseDirectoryExcel(bytes); const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      const idempotencyKey = `excel:${TEMPLATE_VERSION}:${contentSha256}`;
      const requestHash = hash({ contentSha256, templateVersion: TEMPLATE_VERSION });
      const created = await repository.createRun({
        enterpriseId: req.admin!.enterpriseId,
        mode: "EXCEL",
        idempotencyKey,
        requestHash,
        createdByAdminUserId: req.admin!.adminUserId,
        templateVersion: TEMPLATE_VERSION,
        contentSha256,
      });
      if (!created.replayed) {
        await repository.stageRun({
          enterpriseId: req.admin!.enterpriseId,
          runId: created.run.id,
          contentSha256,
          items: rows.map((row) => ({
            rowNumber: row.rowNumber,
            employeeNumber: row.employeeNumber,
            normalizedName: row.name,
            normalizedDepartmentPath: row.departmentPath,
            normalizedEmail: row.email,
            normalizedMobile: row.mobile,
            existingPrincipalId: row.existingPrincipalId,
            reasonCode: row.reasonCode,
          })),
        });
      }
      return reply.code(created.replayed ? 200 : 202).send({
        runId: created.run.id, status: created.run.status, replayed: created.replayed,
      });
    } catch (error) {
      if (error instanceof DirectoryExcelError) return reply.code(400).send({ error: error.code, message: error.message });
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "FILE_TOO_LARGE" });
      if (error instanceof DirectoryRepositoryError) {
        const status = error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
        return reply.code(status).send({ error: error.code.toLowerCase(), message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/directory-import-runs/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id); if (!id.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await sql<Record<string, unknown>>`
      SELECT run.id, coalesce(source.type, 'EXCEL') AS source_type, run.mode AS import_type,
             run.status, run.total_count,
             (run.matched_count + run.created_count + run.updated_count) AS success_count,
             run.conflict_count, run.failed_count, run.failure_reason_code AS error_code,
             run.created_at, run.started_at, run.completed_at AS finished_at
        FROM directory_import_run run
        LEFT JOIN directory_source source
          ON source.enterprise_id = run.enterprise_id AND source.id = run.directory_source_id
       WHERE run.enterprise_id=${req.admin!.enterpriseId}::uuid AND run.id=${id.data}::uuid
    `.execute(app.db);
    if (!result.rows[0]) return reply.code(404).send({ error: "not_found" }); return { run: result.rows[0] };
  });

  app.get<{ Params: { id: string } }>("/directory-import-runs/:id/items", { preHandler: [requireAuth] }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id); const query = RunItemsQuery.safeParse(req.query); if (!id.success || !query.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await sql<Record<string, unknown> & { total_count: string }>`SELECT i.id,i.row_number,i.normalized_name,i.normalized_department_path AS normalized_department,i.status,i.reason_code,i.person_id,i.principal_id,count(*) OVER()::text AS total_count FROM directory_import_item i JOIN directory_import_run r ON r.id=i.run_id AND r.enterprise_id=i.enterprise_id WHERE i.enterprise_id=${req.admin!.enterpriseId}::uuid AND i.run_id=${id.data}::uuid ORDER BY i.row_number LIMIT ${query.data.limit} OFFSET ${query.data.offset}`.execute(app.db);
    if (!result.rows.length) { const exists = await sql`SELECT 1 FROM directory_import_run WHERE enterprise_id=${req.admin!.enterpriseId}::uuid AND id=${id.data}::uuid`.execute(app.db); if (!exists.rows.length) return reply.code(404).send({ error: "not_found" }); }
    return { items: result.rows.map(({ total_count: _, ...item }) => item), total: Number(result.rows[0]?.total_count ?? 0), ...query.data };
  });
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
