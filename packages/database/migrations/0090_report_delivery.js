import { sql } from "kysely";

export async function up(db) {
  await sql`CREATE TABLE IF NOT EXISTS report_delivery_bundle (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL REFERENCES enterprise(id),
    report_type text NOT NULL CHECK (report_type IN ('DAILY','COMPANY_WEEKLY','PERSONAL_WEEKLY','COMPANY_MONTHLY','PERSONAL_MONTHLY','TOP1','OVER50')),
    period_key text NOT NULL, recipient_ref text NOT NULL, target_user_id text,
    endpoint_id uuid REFERENCES notification_endpoint(id),
    period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
    window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
    snapshot jsonb NOT NULL, content_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end > period_start), CHECK(window_end > window_start),
    UNIQUE (enterprise_id, report_type, period_key, recipient_ref), UNIQUE(enterprise_id,id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS report_delivery_message (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL,
    bundle_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('IMAGE','TEXT')),
    status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','RETRYABLE_FAILED','PERMANENT_FAILED','UNKNOWN','SKIPPED')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
    version integer NOT NULL DEFAULT 0, lease_until timestamptz,
    next_attempt_at timestamptz, last_attempt_at timestamptz,
    provider_message_id text, error_code text, classification text,
    FOREIGN KEY(enterprise_id,bundle_id) REFERENCES report_delivery_bundle(enterprise_id,id),
    UNIQUE(bundle_id,kind), UNIQUE(enterprise_id,id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS report_delivery_attempt (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL,
    message_id uuid NOT NULL, version integer NOT NULL,
    started_at timestamptz NOT NULL, finished_at timestamptz,
    status text NOT NULL, provider_message_id text, error_code text, classification text,
    token_requests integer NOT NULL DEFAULT 0, media_requests integer NOT NULL DEFAULT 0,
    preparation_requests integer NOT NULL DEFAULT 0, message_requests integer NOT NULL DEFAULT 0,
    FOREIGN KEY(enterprise_id,message_id) REFERENCES report_delivery_message(enterprise_id,id),
    UNIQUE(message_id,version)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS report_delivery_claim (
    enterprise_id uuid NOT NULL REFERENCES enterprise(id), scope text NOT NULL,
    bundle_id uuid NOT NULL, PRIMARY KEY(enterprise_id,scope),
    FOREIGN KEY(enterprise_id,bundle_id) REFERENCES report_delivery_bundle(enterprise_id,id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS report_delivery_action (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL REFERENCES enterprise(id),
    bundle_id uuid NOT NULL, message_id uuid NOT NULL,
    action text NOT NULL, reason text NOT NULL, previous_status text NOT NULL,
    previous_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(enterprise_id,bundle_id) REFERENCES report_delivery_bundle(enterprise_id,id),
    FOREIGN KEY(enterprise_id,message_id) REFERENCES report_delivery_message(enterprise_id,id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS report_delivery_schedule (
    enterprise_id uuid NOT NULL REFERENCES enterprise(id), report_type text NOT NULL,
    schedule_date text NOT NULL, status text NOT NULL, classification text,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(enterprise_id,report_type,schedule_date)
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS report_delivery_due ON report_delivery_message(enterprise_id,status,next_attempt_at)`.execute(db);
}

// Schema and all delivery evidence intentionally survive code rollback. Up is idempotent.
// Release rollback never invokes destructive schema teardown.
export async function down() { /* retained additive schema */ }
