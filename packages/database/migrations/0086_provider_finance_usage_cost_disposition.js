/**
 * Administrator decisions for exact unpriced ledger rows. This is an accounting
 * exclusion based on server records, never a claim that the provider charged zero.
 * Original ledger, request, attempt, transaction and supplier balance facts are preserved.
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    CREATE TABLE provider_finance_usage_cost_disposition (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES enterprise(id),
      provider_resource_id uuid NOT NULL,
      ledger_line_id uuid NOT NULL REFERENCES ledger_line(id),
      ai_request_id uuid NOT NULL REFERENCES ai_request(id),
      decision varchar(40) NOT NULL CHECK (decision='EXCLUDE_NO_SERVER_COST'),
      original_ledger_fact jsonb NOT NULL CHECK (jsonb_typeof(original_ledger_fact)='object'),
      server_cost_evidence jsonb NOT NULL CHECK (jsonb_typeof(server_cost_evidence)='object'),
      reason text NOT NULL CHECK (length(btrim(reason))>0),
      evidence_ref text NOT NULL CHECK (length(btrim(evidence_ref))>0),
      decided_by_admin_user_id uuid NOT NULL,
      idempotency_key varchar(200) NOT NULL CHECK (length(btrim(idempotency_key))>0),
      request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (enterprise_id, ledger_line_id),
      UNIQUE (enterprise_id, idempotency_key),
      FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id,id),
      FOREIGN KEY (enterprise_id, decided_by_admin_user_id) REFERENCES admin_user(enterprise_id,id)
    );
    CREATE INDEX provider_finance_usage_disposition_request_idx
      ON provider_finance_usage_cost_disposition(enterprise_id,ai_request_id);

    CREATE FUNCTION provider_finance_line_has_recorded_cost(target ledger_line) RETURNS boolean
    LANGUAGE sql STABLE AS $$
      WITH priced AS (
        SELECT COALESCE(SUM(api_cost),0) AS amount, COUNT(DISTINCT api_cost_currency) AS currencies
          FROM ledger_line
         WHERE enterprise_id=(target).enterprise_id AND ai_request_id=(target).ai_request_id
           AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
      ), recorded AS (
        SELECT total_api_cost AS amount FROM ledger_transaction
         WHERE enterprise_id=(target).enterprise_id AND ai_request_id=(target).ai_request_id
           AND api_cost_status='PRICED_USAGE'
        UNION ALL
        SELECT actual_cost AS amount FROM dispatch_decision
         WHERE enterprise_id=(target).enterprise_id AND ai_request_id=(target).ai_request_id
      )
      SELECT COALESCE((target).api_cost>0,false)
        OR CASE WHEN (target).billing_rule_snapshot->>'apiCost' ~ '^[+]?[0-9]+([.][0-9]+)?$'
          THEN ((target).billing_rule_snapshot->>'apiCost')::numeric>0 ELSE false END
        -- Do not exclude unaccounted positive request-level costs. Costs already
        -- represented by other priced attempts remain counted by the original ledger.
        OR EXISTS (SELECT 1 FROM recorded CROSS JOIN priced
          WHERE recorded.amount>0 AND (priced.currencies>1 OR recorded.amount>priced.amount))
    $$;

    CREATE FUNCTION provider_finance_usage_disposition_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE original ledger_line%ROWTYPE;
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'provider finance usage cost dispositions are append-only';
      END IF;
      SELECT * INTO original FROM ledger_line
        WHERE id=NEW.ledger_line_id AND enterprise_id=NEW.enterprise_id FOR UPDATE;
      IF NOT FOUND OR original.provider_resource_id<>NEW.provider_resource_id
         OR original.ai_request_id<>NEW.ai_request_id THEN
        RAISE EXCEPTION 'usage cost disposition ledger identity mismatch';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM upstream_attempt attempt
        WHERE attempt.id=original.upstream_attempt_id AND attempt.enterprise_id=NEW.enterprise_id
          AND attempt.ai_request_id=NEW.ai_request_id AND attempt.provider_resource_id=NEW.provider_resource_id) THEN
        RAISE EXCEPTION 'usage cost disposition attempt identity mismatch';
      END IF;
      IF original.resource_mode<>'API' OR original.api_cost_status IS DISTINCT FROM 'UNKNOWN_COST'
         OR original.api_cost IS NOT NULL OR original.api_cost_currency IS NOT NULL THEN
        RAISE EXCEPTION 'usage cost disposition requires an unpriced API ledger row';
      END IF;
      IF NEW.original_ledger_fact IS DISTINCT FROM to_jsonb(original) THEN
        RAISE EXCEPTION 'usage cost disposition original ledger snapshot mismatch';
      END IF;
      IF provider_finance_line_has_recorded_cost(original) THEN
        RAISE EXCEPTION 'recorded server cost takes precedence over exclusion';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_usage_disposition_guard_trg
      BEFORE INSERT OR UPDATE OR DELETE ON provider_finance_usage_cost_disposition
      FOR EACH ROW EXECUTE FUNCTION provider_finance_usage_disposition_guard();

    CREATE FUNCTION provider_finance_usage_cost_exclusion_applies(tenant uuid, line_id uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM provider_finance_usage_cost_disposition disposition
        JOIN ledger_line line ON line.id=disposition.ledger_line_id AND line.enterprise_id=disposition.enterprise_id
        WHERE disposition.enterprise_id=tenant AND disposition.ledger_line_id=line_id
          AND disposition.decision='EXCLUDE_NO_SERVER_COST'
          AND disposition.provider_resource_id=line.provider_resource_id AND disposition.ai_request_id=line.ai_request_id
          AND line.resource_mode='API' AND line.api_cost_status='UNKNOWN_COST'
          AND line.api_cost IS NULL AND line.api_cost_currency IS NULL
          AND disposition.original_ledger_fact=to_jsonb(line)
          AND NOT provider_finance_line_has_recorded_cost(line)
      )
    $$;
    COMMENT ON FUNCTION provider_finance_usage_cost_exclusion_applies(uuid,uuid) IS
      'Applies to the original ledger period, independent of decision creation time; preserves frozen closed bill snapshots.';
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_usage_cost_disposition) THEN
        RAISE EXCEPTION '0086 rollback blocked: accounting dispositions must be retained';
      END IF;
    END $$;
    DROP FUNCTION provider_finance_usage_cost_exclusion_applies(uuid,uuid);
    DROP TRIGGER provider_finance_usage_disposition_guard_trg ON provider_finance_usage_cost_disposition;
    DROP FUNCTION provider_finance_usage_disposition_guard();
    DROP FUNCTION provider_finance_line_has_recorded_cost(ledger_line);
    DROP TABLE provider_finance_usage_cost_disposition;
  `.execute(db);
}
