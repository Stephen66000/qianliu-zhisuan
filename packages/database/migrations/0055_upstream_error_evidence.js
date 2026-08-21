/**
 * POOL20-048：上游错误脱敏证据与请求形状摘要。
 *
 * 两列只保存允许字段、稳定分类、计数和 Schema 关键字；
 * 不保存请求正文、工具名、属性名、参数值或上游原始错误正文。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("upstream_attempt")
    .addColumn("upstream_error_evidence", "jsonb")
    .addColumn("request_shape_summary", "jsonb")
    .execute();
  await sql`
    ALTER TABLE upstream_attempt
      ADD CONSTRAINT upstream_attempt_error_evidence_object_check
        CHECK (
          upstream_error_evidence IS NULL
          OR (
            jsonb_typeof(upstream_error_evidence) = 'object'
            AND pg_column_size(upstream_error_evidence) <= 4096
          )
        ) NOT VALID,
      ADD CONSTRAINT upstream_attempt_request_shape_object_check
        CHECK (
          request_shape_summary IS NULL
          OR (
            jsonb_typeof(request_shape_summary) = 'object'
            AND pg_column_size(request_shape_summary) <= 4096
          )
        ) NOT VALID,
      ADD CONSTRAINT upstream_attempt_diagnostic_pair_check
        CHECK (
          (upstream_error_evidence IS NULL) = (request_shape_summary IS NULL)
        ) NOT VALID,
      ADD CONSTRAINT upstream_attempt_diagnostic_status_check
        CHECK (
          upstream_error_evidence IS NULL
          OR upstream_error_evidence ->> 'httpStatus' = '400'
        ) NOT VALID
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM upstream_attempt
         WHERE upstream_error_evidence IS NOT NULL
            OR request_shape_summary IS NOT NULL
      ) THEN
        RAISE EXCEPTION '0055 contains diagnostic evidence; destructive down is disabled';
      END IF;
    END;
    $$
  `.execute(db);
  await db.schema.alterTable("upstream_attempt")
    .dropColumn("request_shape_summary")
    .dropColumn("upstream_error_evidence")
    .execute();
}
