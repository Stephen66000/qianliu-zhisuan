BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE operating_bill_period DROP CONSTRAINT operating_bill_period_status_check;
ALTER TABLE operating_bill_period
  ADD CONSTRAINT operating_bill_period_status_check
  CHECK (status IN ('DRAFT', 'CHECKING', 'CLOSED', 'REOPENED'));
ALTER TABLE operating_bill_period
  ADD COLUMN timezone varchar(64),
  ADD COLUMN period_start timestamptz,
  ADD COLUMN period_end timestamptz,
  ADD COLUMN check_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN checking_lease_until timestamptz,
  ADD COLUMN last_settlement_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN ledger_watermark_seq bigint,
  ADD COLUMN ledger_watermark_at timestamptz,
  ADD COLUMN ledger_watermark_id uuid,
  ADD COLUMN current_statement_hash char(64),
  ADD CONSTRAINT poc20_period_bounds_check
    CHECK (period_start IS NULL OR period_end IS NULL OR period_end > period_start),
  ADD CONSTRAINT poc20_period_check_attempt_check CHECK (check_attempt >= 0);

CREATE TABLE poc20_period_check (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprise(id),
  period_id uuid NOT NULL REFERENCES operating_bill_period(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  result varchar(16) NOT NULL CHECK (result IN ('RUNNING', 'PASSED', 'FAILED')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (enterprise_id, period_id, attempt)
);

CREATE TABLE poc20_settlement_fact (
  id uuid PRIMARY KEY,
  enterprise_id uuid NOT NULL REFERENCES enterprise(id),
  period_id uuid NOT NULL REFERENCES operating_bill_period(id),
  occurred_at timestamptz NOT NULL,
  settled_at timestamptz,
  status varchar(16) NOT NULL CHECK (status IN ('PENDING', 'SETTLED')),
  settlement_seq bigint,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  api_cost numeric(24, 8) NOT NULL CHECK (api_cost >= 0),
  UNIQUE (enterprise_id, period_id, id),
  UNIQUE (enterprise_id, period_id, settlement_seq),
  CHECK (
    (status = 'PENDING' AND settled_at IS NULL AND settlement_seq IS NULL)
    OR (status = 'SETTLED' AND settled_at IS NOT NULL AND settlement_seq IS NOT NULL)
  )
);

CREATE TABLE poc20_operating_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprise(id),
  period_id uuid NOT NULL REFERENCES operating_bill_period(id),
  version integer NOT NULL CHECK (version > 0),
  ledger_watermark_seq bigint NOT NULL,
  ledger_watermark_at timestamptz,
  ledger_watermark_id uuid,
  transaction_snapshot text NOT NULL,
  fact_count integer NOT NULL CHECK (fact_count >= 0),
  total_input_tokens numeric(30, 0) NOT NULL,
  total_output_tokens numeric(30, 0) NOT NULL,
  total_api_cost numeric(24, 8) NOT NULL,
  payload jsonb NOT NULL,
  statement_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (enterprise_id, period_id, version),
  UNIQUE (enterprise_id, period_id, statement_hash)
);

CREATE TABLE poc20_period_command (
  enterprise_id uuid NOT NULL REFERENCES enterprise(id),
  period_id uuid NOT NULL REFERENCES operating_bill_period(id),
  action varchar(16) NOT NULL CHECK (action IN ('CLOSE', 'REOPEN')),
  idempotency_key varchar(128) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (enterprise_id, period_id, action, idempotency_key)
);

CREATE FUNCTION poc20_statement_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P3008', MESSAGE = 'operating statement is immutable';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER poc20_statement_immutable_trigger
BEFORE UPDATE OR DELETE ON poc20_operating_statement
FOR EACH ROW EXECUTE FUNCTION poc20_statement_immutable();

CREATE FUNCTION poc20_period_lock(p_enterprise_id uuid, p_period_id uuid) RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('qianliu:v2-period:' || p_enterprise_id::text || ':' || p_period_id::text, 0)
  );
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION poc20_begin_check(
  p_enterprise_id uuid,
  p_period_id uuid,
  p_expected_version integer,
  p_now timestamptz,
  p_lease_seconds integer
) RETURNS integer AS $$
DECLARE
  current_period operating_bill_period%ROWTYPE;
  next_attempt integer;
BEGIN
  PERFORM poc20_period_lock(p_enterprise_id, p_period_id);
  SELECT * INTO current_period
    FROM operating_bill_period
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P3000', MESSAGE = 'period not found';
  END IF;
  IF current_period.status NOT IN ('DRAFT', 'REOPENED') THEN
    RAISE EXCEPTION USING ERRCODE = 'P3001', MESSAGE = 'period cannot enter CHECKING from current state';
  END IF;
  IF current_period.current_version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P3013', MESSAGE = 'period expected version conflict';
  END IF;
  IF p_lease_seconds <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P3009', MESSAGE = 'checking lease must be positive';
  END IF;

  next_attempt := current_period.check_attempt + 1;
  UPDATE operating_bill_period
     SET status = 'CHECKING',
         check_attempt = next_attempt,
         checking_lease_until = p_now + make_interval(secs => p_lease_seconds),
         updated_at = p_now
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id;
  INSERT INTO poc20_period_check(
    enterprise_id, period_id, attempt, result, items, started_at
  ) VALUES (
    p_enterprise_id, p_period_id, next_attempt, 'RUNNING', '[]'::jsonb, p_now
  );
  RETURN next_attempt;
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION poc20_fail_check(
  p_enterprise_id uuid,
  p_period_id uuid,
  p_attempt integer,
  p_items jsonb,
  p_now timestamptz
) RETURNS void AS $$
BEGIN
  PERFORM poc20_period_lock(p_enterprise_id, p_period_id);
  PERFORM 1 FROM operating_bill_period
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id
     AND status = 'CHECKING' AND check_attempt = p_attempt
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P3010', MESSAGE = 'active checking attempt not found';
  END IF;
  UPDATE poc20_period_check
     SET result = 'FAILED', items = p_items, completed_at = p_now
   WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
     AND attempt = p_attempt AND result = 'RUNNING';
  UPDATE operating_bill_period
     SET status = 'DRAFT', checking_lease_until = NULL, updated_at = p_now
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id;
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION poc20_recover_stale_check(
  p_enterprise_id uuid,
  p_period_id uuid,
  p_now timestamptz
) RETURNS boolean AS $$
DECLARE
  current_attempt integer;
BEGIN
  PERFORM poc20_period_lock(p_enterprise_id, p_period_id);
  SELECT check_attempt INTO current_attempt
    FROM operating_bill_period
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id
     AND status = 'CHECKING' AND checking_lease_until < p_now
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE poc20_period_check
     SET result = 'FAILED',
         items = '[{"code":"CHECK_LEASE_EXPIRED","retryable":true}]'::jsonb,
         completed_at = p_now
   WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
     AND attempt = current_attempt AND result = 'RUNNING';
  UPDATE operating_bill_period
     SET status = 'DRAFT', checking_lease_until = NULL, updated_at = p_now
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id;
  RETURN true;
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION poc20_record_settlement(
  p_enterprise_id uuid,
  p_period_id uuid,
  p_id uuid,
  p_occurred_at timestamptz,
  p_settled_at timestamptz,
  p_status varchar,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_api_cost numeric
) RETURNS void AS $$
DECLARE
  current_period operating_bill_period%ROWTYPE;
  existing_fact poc20_settlement_fact%ROWTYPE;
  next_settlement_seq bigint;
BEGIN
  PERFORM poc20_period_lock(p_enterprise_id, p_period_id);
  SELECT * INTO current_period
    FROM operating_bill_period
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P3000', MESSAGE = 'period not found';
  END IF;
  IF current_period.status IN ('CHECKING', 'CLOSED') THEN
    RAISE EXCEPTION USING ERRCODE = 'P3003', MESSAGE = 'fenced period rejects settlement';
  END IF;
  IF p_occurred_at < current_period.period_start OR p_occurred_at >= current_period.period_end THEN
    RAISE EXCEPTION USING ERRCODE = 'P3005', MESSAGE = 'settlement outside period bounds';
  END IF;
  IF p_status NOT IN ('PENDING', 'SETTLED') OR (p_status = 'SETTLED' AND p_settled_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'P3011', MESSAGE = 'invalid settlement state';
  END IF;

  SELECT * INTO existing_fact FROM poc20_settlement_fact
   WHERE id = p_id FOR UPDATE;
  IF FOUND THEN
    IF existing_fact.enterprise_id <> p_enterprise_id
      OR existing_fact.period_id <> p_period_id
      OR existing_fact.occurred_at <> p_occurred_at
      OR existing_fact.input_tokens <> p_input_tokens
      OR existing_fact.output_tokens <> p_output_tokens
      OR existing_fact.api_cost <> p_api_cost THEN
      RAISE EXCEPTION USING ERRCODE = 'P3012', MESSAGE = 'settlement idempotency conflict';
    END IF;
    IF existing_fact.status = 'PENDING' AND p_status = 'SETTLED' THEN
      UPDATE operating_bill_period
         SET last_settlement_seq = last_settlement_seq + 1
       WHERE id = p_period_id AND enterprise_id = p_enterprise_id
       RETURNING last_settlement_seq INTO next_settlement_seq;
      UPDATE poc20_settlement_fact
         SET status = 'SETTLED', settled_at = p_settled_at,
             settlement_seq = next_settlement_seq
       WHERE id = p_id;
    ELSIF existing_fact.status <> p_status THEN
      RAISE EXCEPTION USING ERRCODE = 'P3012', MESSAGE = 'settlement terminal conflict';
    END IF;
    RETURN;
  END IF;

  IF p_status = 'SETTLED' THEN
    UPDATE operating_bill_period
       SET last_settlement_seq = last_settlement_seq + 1
     WHERE id = p_period_id AND enterprise_id = p_enterprise_id
     RETURNING last_settlement_seq INTO next_settlement_seq;
  ELSE
    next_settlement_seq := NULL;
  END IF;

  INSERT INTO poc20_settlement_fact(
    id, enterprise_id, period_id, occurred_at, settled_at, status, settlement_seq,
    input_tokens, output_tokens, api_cost
  ) VALUES (
    p_id, p_enterprise_id, p_period_id, p_occurred_at, p_settled_at, p_status, next_settlement_seq,
    p_input_tokens, p_output_tokens, p_api_cost
  );
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION poc20_close_period(
  p_enterprise_id uuid,
  p_period_id uuid,
  p_expected_version integer,
  p_command_key varchar,
  p_now timestamptz
) RETURNS TABLE(version integer, statement_hash char(64), fact_count integer) AS $$
DECLARE
  current_period operating_bill_period%ROWTYPE;
  existing_command jsonb;
  next_version integer;
  watermark_seq bigint;
  watermark_at timestamptz;
  watermark_id uuid;
  fact_total integer;
  input_total numeric(30, 0);
  output_total numeric(30, 0);
  cost_total numeric(24, 8);
  facts jsonb;
  statement_payload jsonb;
  computed_hash char(64);
  captured_snapshot text;
BEGIN
  PERFORM poc20_period_lock(p_enterprise_id, p_period_id);
  SELECT result INTO existing_command
    FROM poc20_period_command
   WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
     AND action = 'CLOSE' AND idempotency_key = p_command_key;
  IF FOUND THEN
    RETURN QUERY SELECT
      (existing_command->>'version')::integer,
      (existing_command->>'statement_hash')::char(64),
      (existing_command->>'fact_count')::integer;
    RETURN;
  END IF;

  SELECT * INTO current_period
    FROM operating_bill_period
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P3000', MESSAGE = 'period not found';
  END IF;
  IF current_period.status <> 'CHECKING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P3006', MESSAGE = 'period must be CHECKING before close';
  END IF;
  IF current_period.current_version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P3013', MESSAGE = 'period expected version conflict';
  END IF;
  IF EXISTS (
    SELECT 1 FROM poc20_settlement_fact
     WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
       AND status = 'PENDING'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P3002', MESSAGE = 'pending settlement blocks close';
  END IF;

  watermark_seq := current_period.last_settlement_seq;
  captured_snapshot := pg_current_snapshot()::text;

  SELECT
    count(*)::integer,
    coalesce(sum(input_tokens), 0),
    coalesce(sum(output_tokens), 0),
    coalesce(sum(api_cost), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'settlement_seq', settlement_seq,
      'occurred_at', occurred_at,
      'settled_at', settled_at,
      'input_tokens', input_tokens,
      'output_tokens', output_tokens,
      'api_cost', api_cost
    ) ORDER BY settlement_seq), '[]'::jsonb)
  INTO fact_total, input_total, output_total, cost_total, facts
  FROM poc20_settlement_fact
  WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
    AND status = 'SETTLED' AND settlement_seq <= watermark_seq;

  SELECT settled_at, id INTO watermark_at, watermark_id
    FROM poc20_settlement_fact
   WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
     AND status = 'SETTLED'
     AND settlement_seq <= watermark_seq
   ORDER BY settlement_seq DESC LIMIT 1;

  next_version := current_period.current_version + 1;
  statement_payload := jsonb_build_object(
    'enterprise_id', p_enterprise_id,
    'period_id', p_period_id,
    'version', next_version,
    'period_start', current_period.period_start,
    'period_end', current_period.period_end,
    'timezone', current_period.timezone,
    'watermark_seq', watermark_seq,
    'watermark_at', watermark_at,
    'watermark_id', watermark_id,
    'transaction_snapshot', captured_snapshot,
    'fact_count', fact_total,
    'total_input_tokens', input_total,
    'total_output_tokens', output_total,
    'total_api_cost', cost_total,
    'facts', facts,
    'generated_at', p_now
  );
  computed_hash := encode(digest(convert_to(statement_payload::text, 'UTF8'), 'sha256'), 'hex')::char(64);

  INSERT INTO poc20_operating_statement(
    enterprise_id, period_id, version, ledger_watermark_seq,
    ledger_watermark_at, ledger_watermark_id, transaction_snapshot,
    fact_count, total_input_tokens, total_output_tokens, total_api_cost,
    payload, statement_hash, created_at
  ) VALUES (
    p_enterprise_id, p_period_id, next_version, watermark_seq,
    watermark_at, watermark_id, captured_snapshot,
    fact_total, input_total, output_total, cost_total,
    statement_payload, computed_hash, p_now
  );
  UPDATE poc20_period_check
     SET result = 'PASSED', items = '[]'::jsonb, completed_at = p_now
   WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
     AND attempt = current_period.check_attempt AND result = 'RUNNING';
  UPDATE operating_bill_period
     SET status = 'CLOSED', current_version = next_version,
         checking_lease_until = NULL,
         ledger_watermark_seq = watermark_seq,
         ledger_watermark_at = watermark_at,
         ledger_watermark_id = watermark_id,
         current_statement_hash = computed_hash,
         updated_at = p_now
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id;
  INSERT INTO poc20_period_command(
    enterprise_id, period_id, action, idempotency_key, result, created_at
  ) VALUES (
    p_enterprise_id, p_period_id, 'CLOSE', p_command_key,
    jsonb_build_object('version', next_version, 'statement_hash', computed_hash, 'fact_count', fact_total),
    p_now
  );
  RETURN QUERY SELECT next_version, computed_hash, fact_total;
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION poc20_reopen_period(
  p_enterprise_id uuid,
  p_period_id uuid,
  p_expected_version integer,
  p_command_key varchar,
  p_now timestamptz
) RETURNS integer AS $$
DECLARE
  current_period operating_bill_period%ROWTYPE;
  existing_command jsonb;
BEGIN
  PERFORM poc20_period_lock(p_enterprise_id, p_period_id);
  SELECT result INTO existing_command
    FROM poc20_period_command
   WHERE enterprise_id = p_enterprise_id AND period_id = p_period_id
     AND action = 'REOPEN' AND idempotency_key = p_command_key;
  IF FOUND THEN RETURN (existing_command->>'version')::integer; END IF;

  SELECT * INTO current_period
    FROM operating_bill_period
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P3000', MESSAGE = 'period not found';
  END IF;
  IF current_period.status <> 'CLOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P3007', MESSAGE = 'only CLOSED period can reopen';
  END IF;
  IF current_period.current_version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P3013', MESSAGE = 'period expected version conflict';
  END IF;
  UPDATE operating_bill_period
     SET status = 'REOPENED', updated_at = p_now
   WHERE id = p_period_id AND enterprise_id = p_enterprise_id;
  INSERT INTO poc20_period_command(
    enterprise_id, period_id, action, idempotency_key, result, created_at
  ) VALUES (
    p_enterprise_id, p_period_id, 'REOPEN', p_command_key,
    jsonb_build_object('version', current_period.current_version), p_now
  );
  RETURN current_period.current_version;
END
$$ LANGUAGE plpgsql;

COMMIT;
