import { sql } from "kysely";

/** Auth failures have an independent generation: quota sync must never overwrite it. */
export async function up(db) {
  await sql`ALTER TABLE provider_resource ADD COLUMN auth_failure_id uuid,
    ADD COLUMN auth_failure_model text, ADD COLUMN auth_failure_config_hash text`.execute(db);
  // Historical recovery is possible only with a nearby, recorded Chat auth failure.
  await sql`UPDATE provider_resource r SET auth_failure_id = a.id, auth_failure_model = a.upstream_model
    FROM upstream_attempt a WHERE r.status = 'CREDENTIAL_INVALID' AND a.id = (
      SELECT x.id FROM upstream_attempt x
      WHERE x.provider_resource_id = r.id AND x.enterprise_id = r.enterprise_id
        AND x.error_classification = 'UPSTREAM_CREDENTIAL_INVALID' AND x.http_status IN (401,403)
        AND EXISTS (SELECT 1 FROM resource_status_event e WHERE e.provider_resource_id = r.id
          AND e.id = (SELECT newest.id FROM resource_status_event newest
            WHERE newest.provider_resource_id = r.id ORDER BY newest.created_at DESC,newest.id DESC LIMIT 1)
          AND e.to_status = 'CREDENTIAL_INVALID' AND e.reason = 'CREDENTIAL_REJECTED'
          AND e.created_at BETWEEN COALESCE(x.finished_at,x.started_at) - interval '5 seconds'
            AND COALESCE(x.finished_at,x.started_at) + interval '60 seconds')
      ORDER BY x.started_at DESC,x.id DESC LIMIT 1)`.execute(db);
  await sql`CREATE TABLE credential_chat_probe (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL REFERENCES enterprise(id),
    provider_resource_id uuid NOT NULL REFERENCES provider_resource(id), actor_admin_id uuid NOT NULL REFERENCES admin_user(id),
    idempotency_key uuid NOT NULL, failure_id uuid NOT NULL, upstream_model text NOT NULL,
    credential_version integer, credential_digest text NOT NULL, config_hash text NOT NULL,
    status text NOT NULL CHECK(status IN ('RUNNING','RECOVERED','FAILED','STALE','CANCELLED','EXPIRED')),
    http_status integer, error_code text, evidence jsonb,
    usage jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    expires_at timestamptz NOT NULL, retry_at timestamptz NOT NULL,
    UNIQUE(enterprise_id,provider_resource_id,idempotency_key),
    CHECK(evidence IS NULL OR (jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=4096)))`.execute(db);
  await sql`CREATE UNIQUE INDEX credential_chat_probe_running ON credential_chat_probe(provider_resource_id)
    WHERE status='RUNNING'`.execute(db);
}

export async function down(db) {
  const existing = await sql`SELECT 1 FROM credential_chat_probe LIMIT 1`.execute(db);
  if (existing.rows.length) throw new Error("0073 contains probe evidence; rollback refused");
  await sql`DROP TABLE credential_chat_probe`.execute(db);
  await sql`ALTER TABLE provider_resource DROP COLUMN auth_failure_id, DROP COLUMN auth_failure_model,
    DROP COLUMN auth_failure_config_hash`.execute(db);
}
