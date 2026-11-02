/** Additive employee monthly accounting; legacy counters and financial facts remain untouched. */
import { sql } from "kysely";
export async function up(db) {
  await sql`
    ALTER TABLE enterprise ADD COLUMN IF NOT EXISTS employee_quota_monthly_from timestamptz;
    ALTER TABLE principal_grant ADD COLUMN IF NOT EXISTS quota_basis text CHECK (quota_basis IN ('RAW_TOKEN','PLAN_QUOTA'));
    CREATE UNIQUE INDEX IF NOT EXISTS principal_grant_enterprise_id_id_idx ON principal_grant(enterprise_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS upstream_attempt_enterprise_id_id_idx ON upstream_attempt(enterprise_id,id);
    CREATE TABLE IF NOT EXISTS principal_quota_period (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL,
      principal_id uuid NOT NULL, provider text NOT NULL, period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
      period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
      timezone text NOT NULL, quota_basis text NOT NULL CHECK (quota_basis IN ('RAW_TOKEN','PLAN_QUOTA')),
      limit_value bigint NOT NULL CHECK(limit_value>=0), allow_overage boolean NOT NULL, used_value bigint NOT NULL DEFAULT 0 CHECK(used_value>=0),
      reserved_value bigint NOT NULL DEFAULT 0 CHECK(reserved_value>=0), quality text NOT NULL DEFAULT 'COMPLETE' CHECK(quality IN ('COMPLETE','UNKNOWN')),
      open_grant_version integer NOT NULL, limit_updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(enterprise_id,principal_id,provider,period_key), UNIQUE(enterprise_id,id), CHECK(period_end>period_start),
      FOREIGN KEY(enterprise_id,principal_id) REFERENCES principal(enterprise_id,id)
    );
    CREATE TABLE IF NOT EXISTS principal_quota_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL,
      request_id uuid NOT NULL, attempt_no integer NOT NULL CHECK(attempt_no>0), upstream_attempt_id uuid,
      period_id uuid NOT NULL, grant_id uuid NOT NULL, grant_version integer NOT NULL,
      quota_basis text NOT NULL CHECK(quota_basis IN ('RAW_TOKEN','PLAN_QUOTA')),
      estimate bigint NOT NULL CHECK(estimate>=0), actual bigint CHECK(actual>=0),
      status text NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','SETTLED','RELEASED','UNKNOWN')),
      usage_quality text NOT NULL DEFAULT 'UNKNOWN', created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
      UNIQUE(enterprise_id,request_id,attempt_no), UNIQUE(upstream_attempt_id), UNIQUE(enterprise_id,id),
      FOREIGN KEY(enterprise_id,period_id) REFERENCES principal_quota_period(enterprise_id,id),
      FOREIGN KEY(enterprise_id,request_id) REFERENCES ai_request(enterprise_id,id),
      FOREIGN KEY(enterprise_id,grant_id) REFERENCES principal_grant(enterprise_id,id),
      FOREIGN KEY(enterprise_id,upstream_attempt_id) REFERENCES upstream_attempt(enterprise_id,id),
      CHECK((status IN ('SETTLED','RELEASED') AND actual IS NOT NULL AND settled_at IS NOT NULL) OR (status IN ('RESERVED','UNKNOWN') AND actual IS NULL AND settled_at IS NULL))
    );
    CREATE INDEX IF NOT EXISTS principal_quota_usage_period_idx ON principal_quota_usage(enterprise_id,period_id,created_at);
  `.execute(db);
}
// Data-preserving rollback: older readers ignore the additive structures.
export async function down(_db) {}
