/** Owner-scoped recorded-cost accounting; immutable usage and funding facts stay intact. */
import { sql } from "kysely";

export async function up(db) {
  await sql`
    CREATE TABLE provider_finance_recorded_cost_policy (
      enterprise_id uuid NOT NULL,
      provider_resource_id uuid NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      authorized_by_admin_user_id uuid NOT NULL,
      reason text NOT NULL CHECK (length(btrim(reason))>0),
      evidence_ref text NOT NULL CHECK (length(btrim(evidence_ref))>0),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (enterprise_id,provider_resource_id),
      FOREIGN KEY (enterprise_id,provider_resource_id) REFERENCES provider_resource(enterprise_id,id),
      FOREIGN KEY (enterprise_id,authorized_by_admin_user_id) REFERENCES admin_user(enterprise_id,id)
    );
    CREATE FUNCTION provider_finance_unrecorded_cancel_applies(tenant uuid,line_id uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM ledger_line line
        JOIN provider_finance_recorded_cost_policy policy
          ON policy.enterprise_id=line.enterprise_id AND policy.provider_resource_id=line.provider_resource_id AND policy.enabled
        JOIN ai_request request ON request.enterprise_id=line.enterprise_id AND request.id=line.ai_request_id
        JOIN upstream_attempt attempt ON attempt.enterprise_id=line.enterprise_id AND attempt.id=line.upstream_attempt_id
          AND attempt.ai_request_id=request.id AND attempt.provider_resource_id=line.provider_resource_id
        JOIN usage_event usage ON usage.enterprise_id=line.enterprise_id AND usage.id=line.usage_event_id
          AND usage.ai_request_id=request.id AND usage.upstream_attempt_id=attempt.id
          AND usage.provider_resource_id=line.provider_resource_id
        JOIN ledger_transaction transaction ON transaction.enterprise_id=line.enterprise_id AND transaction.ai_request_id=request.id
        WHERE line.enterprise_id=tenant AND line.id=line_id
          AND request.status IN ('FAILED','CANCELLED') AND request.error_code='client_cancelled' AND request.finished_at IS NOT NULL
          AND attempt.error_code='client_cancelled' AND attempt.finished_at IS NOT NULL
          AND line.resource_mode='API' AND line.api_cost_status='UNKNOWN_COST'
          AND line.api_cost IS NULL AND line.api_cost_currency IS NULL AND line.legacy_cost_resolution_id IS NULL
          AND line.settled_at>=policy.created_at AND request.started_at>=policy.created_at
          AND line.raw_input_tokens=0 AND line.raw_output_tokens=0 AND line.raw_cache_tokens=0 AND line.raw_reasoning_tokens=0
          AND usage.input_tokens=0 AND usage.output_tokens=0 AND usage.cache_tokens=0 AND usage.reasoning_tokens=0
          AND usage.upstream_usage_id IS NULL
          AND transaction.status='SETTLED' AND transaction.api_cost_status='UNKNOWN_COST' AND transaction.attempt_count=1
          AND (transaction.total_api_cost IS NULL OR transaction.total_api_cost=0)
          AND transaction.total_input_tokens=0 AND transaction.total_output_tokens=0
          AND transaction.total_cache_tokens=0 AND transaction.total_reasoning_tokens=0
          AND (line.billing_rule_snapshot->>'apiCost' IS NULL OR line.billing_rule_snapshot->>'apiCost' ~ '^[+]?0+([.]0+)?$')
          AND NOT provider_finance_line_has_recorded_cost(line)
          AND NOT EXISTS (SELECT 1 FROM dispatch_decision d WHERE d.enterprise_id=tenant AND d.ai_request_id=request.id
            AND d.actual_cost IS NOT NULL AND d.actual_cost<>0)
          AND NOT EXISTS (SELECT 1 FROM upstream_attempt a WHERE a.enterprise_id=tenant AND a.ai_request_id=request.id AND a.id<>attempt.id)
          AND NOT EXISTS (SELECT 1 FROM usage_event u WHERE u.enterprise_id=tenant AND u.ai_request_id=request.id AND u.id<>usage.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_line l WHERE l.enterprise_id=tenant AND l.ai_request_id=request.id AND l.id<>line.id)
      )
    $$;
    CREATE FUNCTION provider_finance_explicit_cost_exclusion_applies(tenant uuid,line_id uuid) RETURNS boolean
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
    CREATE OR REPLACE FUNCTION provider_finance_usage_cost_exclusion_applies(tenant uuid,line_id uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT provider_finance_explicit_cost_exclusion_applies(tenant,line_id)
        OR provider_finance_unrecorded_cancel_applies(tenant,line_id)
    $$;
    COMMENT ON FUNCTION provider_finance_usage_cost_exclusion_applies(uuid,uuid) IS
      'Owner-authorized recorded-cost accounting: explicit decisions or terminal single-attempt cancellations with zero recorded usage and no recorded fees. Original facts are preserved; never a claim of zero supplier charge.';
  `.execute(db);
}

export async function down(db) {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_recorded_cost_policy WHERE enabled) THEN
        RAISE EXCEPTION 'Disable and audit active recorded-cost policies before rollback';
      END IF;
    END $$;
    CREATE OR REPLACE FUNCTION provider_finance_usage_cost_exclusion_applies(tenant uuid,line_id uuid) RETURNS boolean
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
    DROP FUNCTION provider_finance_explicit_cost_exclusion_applies(uuid,uuid);
    DROP FUNCTION provider_finance_unrecorded_cancel_applies(uuid,uuid);
    DROP TABLE provider_finance_recorded_cost_policy;
  `.execute(db);
}
