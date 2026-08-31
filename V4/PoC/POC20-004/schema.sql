CREATE TABLE poc20_capacity_principal (
  id integer PRIMARY KEY,
  enterprise_id uuid NOT NULL,
  principal_type varchar(16) NOT NULL CHECK (principal_type IN ('EMPLOYEE', 'PROJECT')),
  team_id integer NOT NULL,
  cost_center_id integer NOT NULL
);

CREATE TABLE poc20_capacity_ledger_line (
  id bigint PRIMARY KEY,
  enterprise_id uuid NOT NULL,
  period_month date NOT NULL,
  principal_id integer NOT NULL REFERENCES poc20_capacity_principal(id),
  project_id integer,
  occurred_at timestamptz NOT NULL,
  settled_at timestamptz NOT NULL,
  settlement_seq bigint NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  api_cost numeric(24, 8) NOT NULL CHECK (api_cost >= 0)
);

CREATE TABLE poc20_capacity_monthly_rollup (
  enterprise_id uuid NOT NULL,
  period_month date NOT NULL,
  principal_id integer NOT NULL,
  request_count bigint NOT NULL,
  input_tokens numeric(30, 0) NOT NULL,
  output_tokens numeric(30, 0) NOT NULL,
  api_cost numeric(30, 8) NOT NULL,
  PRIMARY KEY (enterprise_id, period_month, principal_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poc20_capacity_runtime') THEN
    CREATE ROLE poc20_capacity_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO poc20_capacity_runtime;
GRANT SELECT ON poc20_capacity_ledger_line, poc20_capacity_monthly_rollup TO poc20_capacity_runtime;

ALTER TABLE poc20_capacity_ledger_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc20_capacity_ledger_line FORCE ROW LEVEL SECURITY;
CREATE POLICY poc20_capacity_tenant_policy ON poc20_capacity_ledger_line
  FOR SELECT TO poc20_capacity_runtime
  USING (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  );
