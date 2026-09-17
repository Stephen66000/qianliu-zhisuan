import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`ALTER TABLE provider_resource ADD COLUMN archived_at timestamptz`.execute(db);
  await sql`ALTER TABLE provider ADD COLUMN archived_at timestamptz`.execute(db);
  await sql`CREATE INDEX provider_resource_archive_idx ON provider_resource (enterprise_id, archived_at)`.execute(db);
  await sql`CREATE INDEX provider_archive_idx ON provider (enterprise_id, archived_at)`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`DROP INDEX IF EXISTS provider_resource_archive_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS provider_archive_idx`.execute(db);
  await sql`ALTER TABLE provider_resource DROP COLUMN IF EXISTS archived_at`.execute(db);
  await sql`ALTER TABLE provider DROP COLUMN IF EXISTS archived_at`.execute(db);
}
