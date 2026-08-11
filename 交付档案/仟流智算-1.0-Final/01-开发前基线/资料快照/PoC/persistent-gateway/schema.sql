CREATE TABLE IF NOT EXISTS gateway_requests (
  request_id text PRIMARY KEY,
  principal_id text NOT NULL,
  model text NOT NULL,
  capability text NOT NULL,
  session_hash text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS gateway_attempts (
  request_id text NOT NULL REFERENCES gateway_requests(request_id),
  attempt_no integer NOT NULL,
  resource_id text NOT NULL,
  status integer NOT NULL,
  committed boolean NOT NULL,
  error_code text,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cache_tokens bigint NOT NULL,
  usage_quality text NOT NULL,
  api_cost numeric(20, 8) NOT NULL,
  PRIMARY KEY (request_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS gateway_settlements (
  request_id text PRIMARY KEY REFERENCES gateway_requests(request_id),
  status text NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cache_tokens bigint NOT NULL,
  usage_quality text NOT NULL,
  api_cost numeric(20, 8) NOT NULL,
  deduction numeric(20, 8) NOT NULL,
  overage boolean NOT NULL,
  attempt_count integer NOT NULL,
  saving text NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_dispatches (
  request_id text PRIMARY KEY REFERENCES gateway_requests(request_id),
  action text NOT NULL,
  reason_code text NOT NULL,
  baseline_resource_id text,
  candidates jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS gateway_requests_principal_created_idx
  ON gateway_requests (principal_id, created_at DESC);

COMMENT ON TABLE gateway_requests IS
  'Only request metadata. Prompt, code, files and model response bodies are forbidden.';
