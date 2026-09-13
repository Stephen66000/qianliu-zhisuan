import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`CREATE TABLE runtime_notification_recipient (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text NOT NULL CHECK(category IN ('SYSTEM_FAILURE', 'UPSTREAM_RESOURCE', 'FINANCE_SECURITY', 'PERSONNEL_ACCOUNT')),
    person_id uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(category, person_id)
  )`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`DROP TABLE IF EXISTS runtime_notification_recipient`.execute(db);
}
