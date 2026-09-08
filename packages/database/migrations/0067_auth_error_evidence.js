/**
 * 允许 401/403 使用既有脱敏诊断列。证据仍受应用层白名单、JSON 大小和成对约束保护，
 * 不保存上游原始 message、请求正文或凭证明文。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    ALTER TABLE upstream_attempt
      DROP CONSTRAINT upstream_attempt_diagnostic_status_check,
      ADD CONSTRAINT upstream_attempt_diagnostic_status_check
        CHECK (
          upstream_error_evidence IS NULL
          OR upstream_error_evidence ->> 'httpStatus' IN ('400', '401', '403')
        ) NOT VALID
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const authEvidence = await sql`
    SELECT 1 FROM upstream_attempt
    WHERE upstream_error_evidence ->> 'httpStatus' IN ('401', '403')
    LIMIT 1
  `.execute(db);
  if (authEvidence.rows.length > 0) {
    throw new Error("0067 down refused: 401/403 diagnostic evidence exists");
  }
  await sql`
    ALTER TABLE upstream_attempt
      DROP CONSTRAINT upstream_attempt_diagnostic_status_check,
      ADD CONSTRAINT upstream_attempt_diagnostic_status_check
        CHECK (
          upstream_error_evidence IS NULL
          OR upstream_error_evidence ->> 'httpStatus' = '400'
        ) NOT VALID
  `.execute(db);
}
