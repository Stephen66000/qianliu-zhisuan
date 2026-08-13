import { sql, type Kysely, type Selectable } from "kysely";
import type { Database, DirectorySourceTable } from "../kysely.js";
import {
  DirectoryRepositoryError,
  type CreateDirectoryRunInput,
  type DirectoryImportRun,
  type DirectorySource,
  type DirectorySourceView,
  type UpsertDirectorySourceInput,
} from "./directory-repository-types.js";

function json(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(value) as unknown as Record<string, unknown>;
}

export function directorySourceView(source: DirectorySource): DirectorySourceView {
  const { config_ciphertext, ...safe } = source;
  void config_ciphertext;
  return { ...safe, configured: true };
}

async function assertAdmin(
  db: Kysely<Database>, enterpriseId: string, adminUserId: string,
): Promise<void> {
  const admin = await db.selectFrom("admin_user").select("id")
    .where("enterprise_id", "=", enterpriseId).where("id", "=", adminUserId)
    .where("status", "=", "ACTIVE").executeTakeFirst();
  if (!admin) throw new DirectoryRepositoryError("CONFLICT", "管理员不存在、已停用或不属于当前企业");
}

export async function upsertDirectorySource(
  db: Kysely<Database>, input: UpsertDirectorySourceInput,
): Promise<DirectorySourceView> {
  await assertAdmin(db, input.enterpriseId, input.actorAdminUserId);
  if ((input.configCiphertext === undefined) !== (input.configFingerprint === undefined)) {
    throw new DirectoryRepositoryError("INVALID_REQUEST", "配置密文与指纹必须同时提供");
  }
  return db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom("directory_source").selectAll()
      .where("enterprise_id", "=", input.enterpriseId).where("type", "=", input.type)
      .forUpdate().executeTakeFirst();
    let source: Selectable<DirectorySourceTable>;
    if (!current) {
      if (!input.configCiphertext || !input.configFingerprint) {
        throw new DirectoryRepositoryError("INVALID_REQUEST", "首次配置必须提供加密配置与指纹");
      }
      source = await trx.insertInto("directory_source").values({
        enterprise_id: input.enterpriseId, type: input.type,
        config_ciphertext: input.configCiphertext, config_fingerprint: input.configFingerprint,
        config_key_version: input.configKeyVersion ?? 1,
        connector_version: input.connectorVersion ?? "v1", status: input.status ?? "ACTIVE",
      }).returningAll().executeTakeFirstOrThrow();
    } else {
      if (input.expectedVersion === undefined || input.expectedVersion !== current.version) {
        throw new DirectoryRepositoryError("CONFLICT", "通讯录来源已被其他操作修改");
      }
      source = await trx.updateTable("directory_source").set({
        ...(input.configCiphertext === undefined ? {} : {
          config_ciphertext: input.configCiphertext,
          config_fingerprint: input.configFingerprint!,
          config_key_version: input.configKeyVersion ?? current.config_key_version,
        }),
        ...(input.connectorVersion === undefined ? {} : { connector_version: input.connectorVersion }),
        ...(input.status === undefined ? {} : { status: input.status }),
        version: sql`version + 1`, updated_at: new Date(),
      }).where("enterprise_id", "=", input.enterpriseId).where("id", "=", current.id)
        .where("version", "=", current.version).returningAll().executeTakeFirstOrThrow();
    }
    await trx.insertInto("operation_log").values({
      enterprise_id: input.enterpriseId, admin_user_id: input.actorAdminUserId,
      action: current ? "directory_source.update" : "directory_source.create",
      target_type: "directory_source", target_id: source.id,
      change_summary: json({
        type: source.type, status: source.status, version: source.version,
        config_fingerprint: source.config_fingerprint,
        secret_rotated: current ? input.configCiphertext !== undefined : true,
      }), result: "SUCCESS", failure_reason: null,
    }).execute();
    return directorySourceView(source);
  });
}

export async function createDirectoryRun(
  db: Kysely<Database>, input: CreateDirectoryRunInput,
): Promise<{ run: DirectoryImportRun; replayed: boolean }> {
  await assertAdmin(db, input.enterpriseId, input.createdByAdminUserId);
  if (!input.idempotencyKey || !input.requestHash) {
    throw new DirectoryRepositoryError("INVALID_REQUEST", "缺少幂等键或请求摘要");
  }
  try {
    return await db.transaction().execute(async (trx) => {
      const prior = await trx.selectFrom("directory_import_run").selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (prior) {
        if (prior.request_hash !== input.requestHash) {
          throw new DirectoryRepositoryError("IDEMPOTENCY_CONFLICT", "该幂等键已用于不同导入请求");
        }
        return { run: prior, replayed: true };
      }
      let source: Selectable<DirectorySourceTable> | undefined;
      if (input.mode === "SYNC") {
        if (!input.directorySourceId) throw new DirectoryRepositoryError("INVALID_REQUEST", "接口同步缺少来源");
        source = await trx.selectFrom("directory_source").selectAll()
          .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.directorySourceId)
          .executeTakeFirst();
        if (!source) throw new DirectoryRepositoryError("NOT_FOUND", "通讯录来源不存在");
        if (source.status !== "ACTIVE") throw new DirectoryRepositoryError("SOURCE_INACTIVE", "通讯录来源未启用");
      } else if (!input.templateVersion || !input.contentSha256) {
        throw new DirectoryRepositoryError("INVALID_REQUEST", "Excel 导入缺少模板版本或文件摘要");
      }
      const run = await trx.insertInto("directory_import_run").values({
        enterprise_id: input.enterpriseId,
        directory_source_id: input.mode === "SYNC" ? input.directorySourceId! : null,
        mode: input.mode,
        job_type: input.mode === "SYNC" ? "DIRECTORY_SYNC" : "DIRECTORY_IMPORT_APPLY",
        template_version: input.mode === "EXCEL" ? input.templateVersion! : null,
        connector_version: input.mode === "SYNC" ? input.connectorVersion ?? source!.connector_version : null,
        source_snapshot_id: input.sourceSnapshotId ?? null,
        content_sha256: input.contentSha256 ?? null,
        request_hash: input.requestHash, idempotency_key: input.idempotencyKey,
        created_by_admin_user_id: input.createdByAdminUserId, source_data_at: input.sourceDataAt ?? null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({
        enterprise_id: input.enterpriseId, admin_user_id: input.createdByAdminUserId,
        action: input.mode === "SYNC" ? "directory_sync_run.create" : "directory_excel_run.create",
        target_type: "directory_import_run", target_id: run.id,
        change_summary: json({ mode: run.mode, source_id: run.directory_source_id, status: run.status }),
        result: "SUCCESS", failure_reason: null,
      }).execute();
      return { run, replayed: false };
    });
  } catch (error) {
    const conflict = typeof error === "object" && error !== null
      && "code" in error && (error as { code?: string }).code === "23505"
      && "constraint" in error
      && (error as { constraint?: string }).constraint === "directory_import_run_idempotency_uq";
    if (!conflict) throw error;
    const prior = await db.selectFrom("directory_import_run").selectAll()
      .where("enterprise_id", "=", input.enterpriseId)
      .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
    if (!prior || prior.request_hash !== input.requestHash) {
      throw new DirectoryRepositoryError("IDEMPOTENCY_CONFLICT", "该幂等键已用于不同导入请求");
    }
    return { run: prior, replayed: true };
  }
}
