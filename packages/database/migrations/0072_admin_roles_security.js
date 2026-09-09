import { sql } from "kysely";
export async function up(db) {
  await sql`ALTER TABLE admin_user ADD COLUMN role_code text NOT NULL DEFAULT 'SUPER_ADMIN'
    CHECK(role_code IN ('SUPER_ADMIN','CUSTOM'))`.execute(db);
  await sql`CREATE TABLE admin_role (
    enterprise_id uuid PRIMARY KEY REFERENCES enterprise(id),
    name varchar(128) NOT NULL CHECK(length(trim(name)) > 0),
    permissions jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`ALTER TABLE enterprise
    ADD COLUMN session_minutes integer NOT NULL DEFAULT 480 CHECK(session_minutes BETWEEN 15 AND 1440),
    ADD COLUMN login_max_failures integer NOT NULL DEFAULT 5 CHECK(login_max_failures BETWEEN 3 AND 10),
    ADD COLUMN login_lock_minutes integer NOT NULL DEFAULT 5 CHECK(login_lock_minutes BETWEEN 5 AND 60),
    ADD COLUMN force_initial_password_change boolean NOT NULL DEFAULT true,
    ADD COLUMN security_version integer NOT NULL DEFAULT 1`.execute(db);
  await sql`ALTER TABLE admin_session ADD COLUMN user_agent varchar(512),
    ADD COLUMN ip_address varchar(64), ADD COLUMN last_seen_at timestamptz`.execute(db);
  await sql`ALTER TABLE operation_log ADD COLUMN actor_source text NOT NULL DEFAULT 'UNKNOWN'
    CHECK(actor_source IN ('ADMIN','SYSTEM','UNKNOWN'))`.execute(db);
}
export async function down(db) {
  const used = await sql`SELECT 1 WHERE EXISTS(SELECT 1 FROM admin_role)
    OR EXISTS(SELECT 1 FROM admin_user WHERE role_code = 'CUSTOM')
    OR EXISTS(SELECT 1 FROM enterprise WHERE security_version > 1)`.execute(db);
  if (used.rows.length) throw new Error('0072 down refused: role or security configuration exists');
  await sql`ALTER TABLE operation_log DROP COLUMN actor_source`.execute(db);
  await sql`ALTER TABLE admin_session DROP COLUMN user_agent, DROP COLUMN ip_address, DROP COLUMN last_seen_at`.execute(db);
  await sql`ALTER TABLE enterprise DROP COLUMN session_minutes, DROP COLUMN login_max_failures,
    DROP COLUMN login_lock_minutes, DROP COLUMN force_initial_password_change, DROP COLUMN security_version`.execute(db);
  await sql`DROP TABLE admin_role`.execute(db);
  await sql`ALTER TABLE admin_user DROP COLUMN role_code`.execute(db);
}
