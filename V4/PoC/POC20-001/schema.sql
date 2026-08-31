\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS poc20 CASCADE;
DROP ROLE IF EXISTS ql_poc_app;

CREATE ROLE ql_poc_app LOGIN PASSWORD 'poc20_local_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE SCHEMA poc20 AUTHORIZATION postgres;

CREATE TABLE poc20.enterprise (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE poc20.principal (
  enterprise_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (enterprise_id, id),
  CONSTRAINT principal_enterprise_fk
    FOREIGN KEY (enterprise_id) REFERENCES poc20.enterprise (id)
);

CREATE TABLE poc20.provider_resource (
  enterprise_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (enterprise_id, id),
  CONSTRAINT provider_resource_enterprise_fk
    FOREIGN KEY (enterprise_id) REFERENCES poc20.enterprise (id)
);

CREATE TABLE poc20.usage_event (
  enterprise_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  provider_resource_id uuid NOT NULL,
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enterprise_id, id),
  CONSTRAINT usage_principal_fk
    FOREIGN KEY (enterprise_id, principal_id)
    REFERENCES poc20.principal (enterprise_id, id),
  CONSTRAINT usage_resource_fk
    FOREIGN KEY (enterprise_id, provider_resource_id)
    REFERENCES poc20.provider_resource (enterprise_id, id)
);

CREATE INDEX usage_event_enterprise_created_idx
  ON poc20.usage_event (enterprise_id, created_at DESC, id);

CREATE TABLE poc20.support_export (
  enterprise_id uuid NOT NULL,
  id uuid NOT NULL,
  requested_by uuid NOT NULL,
  object_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (enterprise_id, id),
  CONSTRAINT support_export_enterprise_fk
    FOREIGN KEY (enterprise_id) REFERENCES poc20.enterprise (id)
);

INSERT INTO poc20.enterprise (id, name) VALUES
  ('00000000-0000-0000-0000-00000000000a', '企业 A'),
  ('00000000-0000-0000-0000-00000000000b', '企业 B');

INSERT INTO poc20.principal (enterprise_id, id, name) VALUES
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'A 员工'),
  ('00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'B 员工');

INSERT INTO poc20.provider_resource (enterprise_id, id, name) VALUES
  ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'A 资源'),
  ('00000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b', 'B 资源');

INSERT INTO poc20.usage_event (
  enterprise_id,
  id,
  principal_id,
  provider_resource_id,
  total_tokens
) VALUES
  (
    '00000000-0000-0000-0000-00000000000a',
    '30000000-0000-0000-0000-00000000000a',
    '10000000-0000-0000-0000-00000000000a',
    '20000000-0000-0000-0000-00000000000a',
    100
  ),
  (
    '00000000-0000-0000-0000-00000000000b',
    '30000000-0000-0000-0000-00000000000b',
    '10000000-0000-0000-0000-00000000000b',
    '20000000-0000-0000-0000-00000000000b',
    200
  );

INSERT INTO poc20.support_export (
  enterprise_id,
  id,
  requested_by,
  object_key,
  expires_at
) VALUES
  (
    '00000000-0000-0000-0000-00000000000a',
    '40000000-0000-0000-0000-00000000000a',
    '10000000-0000-0000-0000-00000000000a',
    'enterprise/a/export.csv',
    clock_timestamp() + interval '30 minutes'
  ),
  (
    '00000000-0000-0000-0000-00000000000b',
    '40000000-0000-0000-0000-00000000000b',
    '10000000-0000-0000-0000-00000000000b',
    'enterprise/b/export.csv',
    clock_timestamp() + interval '30 minutes'
  );

ALTER TABLE poc20.enterprise ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc20.enterprise FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_tenant_policy ON poc20.enterprise
  USING (
    id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  );

ALTER TABLE poc20.principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc20.principal FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_tenant_policy ON poc20.principal
  USING (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  )
  WITH CHECK (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  );

ALTER TABLE poc20.provider_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc20.provider_resource FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_resource_tenant_policy ON poc20.provider_resource
  USING (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  )
  WITH CHECK (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  );

ALTER TABLE poc20.usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc20.usage_event FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_event_tenant_policy ON poc20.usage_event
  USING (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  )
  WITH CHECK (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  );

ALTER TABLE poc20.support_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc20.support_export FORCE ROW LEVEL SECURITY;
CREATE POLICY support_export_tenant_policy ON poc20.support_export
  USING (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  )
  WITH CHECK (
    enterprise_id = nullif(current_setting('app.enterprise_id', true), '')::uuid
  );

GRANT USAGE ON SCHEMA poc20 TO ql_poc_app;
GRANT SELECT ON poc20.enterprise TO ql_poc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  poc20.principal,
  poc20.provider_resource,
  poc20.usage_event,
  poc20.support_export
TO ql_poc_app;

ANALYZE poc20.enterprise;
ANALYZE poc20.principal;
ANALYZE poc20.provider_resource;
ANALYZE poc20.usage_event;
ANALYZE poc20.support_export;
