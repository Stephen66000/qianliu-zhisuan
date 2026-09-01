/** Grant 手工归档：扩展状态约束；归档只隐藏日常列表，不删除历史关联。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`ALTER TABLE principal_grant DROP CONSTRAINT IF EXISTS principal_grant_status_check`.execute(db);
  await sql`
    ALTER TABLE principal_grant
    ADD CONSTRAINT principal_grant_status_check
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'DISABLED', 'ARCHIVED'))
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM principal_grant WHERE status = 'ARCHIVED') THEN
        RAISE EXCEPTION 'cannot remove Grant archive status while archived records exist';
      END IF;
    END $$
  `.execute(db);
  await sql`ALTER TABLE principal_grant DROP CONSTRAINT IF EXISTS principal_grant_status_check`.execute(db);
  await sql`
    ALTER TABLE principal_grant
    ADD CONSTRAINT principal_grant_status_check
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'DISABLED'))
  `.execute(db);
}
