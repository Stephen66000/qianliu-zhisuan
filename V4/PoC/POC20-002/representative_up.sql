BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- POC20-002 代表性迁移，不是正式 0045。先审计，后 DDL；任一歧义整单回滚。
DO $$
DECLARE
  target_enterprise_id uuid;
  enterprise_count integer;
  mismatch_count bigint;
BEGIN
  target_enterprise_id := nullif(current_setting('poc20.target_enterprise_id', true), '')::uuid;

  IF target_enterprise_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P2000',
      MESSAGE = 'POC20-002 target enterprise manifest is required; migration aborted before DDL';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM enterprise WHERE id = target_enterprise_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P2001',
      MESSAGE = format('POC20-002 target enterprise does not exist: %s', target_enterprise_id);
  END IF;

  SELECT count(*) INTO enterprise_count FROM enterprise;

  SELECT
      (SELECT count(*) FROM principal_key child JOIN principal parent ON parent.id = child.principal_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM principal_grant child JOIN principal parent ON parent.id = child.principal_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM ai_request child JOIN principal parent ON parent.id = child.principal_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM ai_request child JOIN principal_key parent ON parent.id = child.principal_key_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM upstream_attempt child JOIN ai_request parent ON parent.id = child.ai_request_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM usage_event child JOIN ai_request parent ON parent.id = child.ai_request_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM usage_event child JOIN upstream_attempt parent ON parent.id = child.upstream_attempt_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM ledger_line child JOIN ai_request parent ON parent.id = child.ai_request_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM ledger_line child JOIN usage_event parent ON parent.id = child.usage_event_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    + (SELECT count(*) FROM ledger_transaction child JOIN ai_request parent ON parent.id = child.ai_request_id
        WHERE child.enterprise_id <> parent.enterprise_id)
    INTO mismatch_count;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P2002',
      MESSAGE = format('POC20-002 cross-enterprise references=%s; migration aborted before DDL', mismatch_count);
  END IF;

  IF enterprise_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P2001',
      MESSAGE = format('POC20-002 standard deployment must contain exactly one enterprise; found=%s', enterprise_count);
  END IF;

END $$;

LOCK TABLE
  admin_session,
  employee_login,
  quota_counter,
  person,
  person_external_identity,
  availability_rule,
  availability_rule_version,
  availability_event,
  notification_endpoint,
  notification_delivery
IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE admin_session ADD COLUMN enterprise_id uuid;
ALTER TABLE employee_login ADD COLUMN enterprise_id uuid;
ALTER TABLE quota_counter ADD COLUMN enterprise_id uuid;
ALTER TABLE person ADD COLUMN enterprise_id uuid;
ALTER TABLE person_external_identity ADD COLUMN enterprise_id uuid;
ALTER TABLE availability_rule ADD COLUMN enterprise_id uuid;
ALTER TABLE availability_rule_version ADD COLUMN enterprise_id uuid;
ALTER TABLE availability_event ADD COLUMN enterprise_id uuid;
ALTER TABLE notification_endpoint ADD COLUMN enterprise_id uuid;
ALTER TABLE notification_delivery ADD COLUMN enterprise_id uuid;

UPDATE admin_session child
   SET enterprise_id = parent.enterprise_id
  FROM admin_user parent
 WHERE child.admin_user_id = parent.id;

UPDATE employee_login child
   SET enterprise_id = parent.enterprise_id
  FROM principal parent
 WHERE child.principal_id = parent.id;

UPDATE quota_counter child
   SET enterprise_id = parent.enterprise_id
  FROM principal_grant parent
 WHERE child.grant_id = parent.id;

UPDATE person
   SET enterprise_id = current_setting('poc20.target_enterprise_id')::uuid;

UPDATE person_external_identity child
   SET enterprise_id = parent.enterprise_id
  FROM person parent
 WHERE child.person_id = parent.id;

UPDATE availability_rule child
   SET enterprise_id = COALESCE(parent.enterprise_id, current_setting('poc20.target_enterprise_id')::uuid)
  FROM admin_user parent
 WHERE child.created_by = parent.id;
UPDATE availability_rule
   SET enterprise_id = current_setting('poc20.target_enterprise_id')::uuid
 WHERE enterprise_id IS NULL;

UPDATE availability_rule_version child
   SET enterprise_id = parent.enterprise_id
  FROM availability_rule parent
 WHERE child.availability_rule_id = parent.id;

UPDATE availability_event child
   SET enterprise_id = parent.enterprise_id
  FROM availability_rule_version parent
 WHERE child.rule_version_id = parent.id;

UPDATE notification_endpoint
   SET enterprise_id = current_setting('poc20.target_enterprise_id')::uuid;

UPDATE notification_delivery child
   SET enterprise_id = parent.enterprise_id
  FROM notification_endpoint parent
 WHERE child.notification_endpoint_id = parent.id;

DO $$
DECLARE
  missing_count bigint;
BEGIN
  SELECT
      (SELECT count(*) FROM admin_session WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM employee_login WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM quota_counter WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM person WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM person_external_identity WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM availability_rule WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM availability_rule_version WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM availability_event WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM notification_endpoint WHERE enterprise_id IS NULL)
    + (SELECT count(*) FROM notification_delivery WHERE enterprise_id IS NULL)
    INTO missing_count;

  IF missing_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P2003',
      MESSAGE = format('POC20-002 unresolved enterprise ownership rows=%s; migration aborted', missing_count);
  END IF;
END $$;

ALTER TABLE admin_session ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE employee_login ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE quota_counter ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE person ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE person_external_identity ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE availability_rule ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE availability_rule_version ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE availability_event ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE notification_endpoint ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE notification_delivery ALTER COLUMN enterprise_id SET NOT NULL;

ALTER TABLE admin_session ADD CONSTRAINT poc20_admin_session_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE employee_login ADD CONSTRAINT poc20_employee_login_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE quota_counter ADD CONSTRAINT poc20_quota_counter_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE person ADD CONSTRAINT poc20_person_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE person_external_identity ADD CONSTRAINT poc20_person_identity_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE availability_rule ADD CONSTRAINT poc20_rule_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE availability_event ADD CONSTRAINT poc20_availability_event_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE notification_endpoint ADD CONSTRAINT poc20_endpoint_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE notification_delivery ADD CONSTRAINT poc20_delivery_enterprise_fk FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);

ALTER TABLE admin_user ADD CONSTRAINT poc20_admin_user_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE principal ADD CONSTRAINT poc20_principal_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE principal_key ADD CONSTRAINT poc20_principal_key_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE principal_grant ADD CONSTRAINT poc20_principal_grant_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE ai_request ADD CONSTRAINT poc20_request_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE upstream_attempt ADD CONSTRAINT poc20_attempt_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE usage_event ADD CONSTRAINT poc20_usage_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE person ADD CONSTRAINT poc20_person_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE person_external_identity ADD CONSTRAINT poc20_identity_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE availability_rule ADD CONSTRAINT poc20_rule_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_event_ref_uq UNIQUE (enterprise_id, id, availability_rule_id, rule_version);
ALTER TABLE availability_event ADD CONSTRAINT poc20_event_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE notification_endpoint ADD CONSTRAINT poc20_endpoint_enterprise_id_uq UNIQUE (enterprise_id, id);
ALTER TABLE operating_bill_period ADD CONSTRAINT poc20_period_enterprise_id_uq UNIQUE (enterprise_id, id);

ALTER TABLE admin_session ADD CONSTRAINT poc20_session_admin_fk FOREIGN KEY (enterprise_id, admin_user_id) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE employee_login ADD CONSTRAINT poc20_login_principal_fk FOREIGN KEY (enterprise_id, principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE quota_counter ADD CONSTRAINT poc20_counter_grant_fk FOREIGN KEY (enterprise_id, grant_id) REFERENCES principal_grant(enterprise_id, id);
ALTER TABLE principal_key ADD CONSTRAINT poc20_key_principal_fk FOREIGN KEY (enterprise_id, principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE principal_grant ADD CONSTRAINT poc20_grant_principal_fk FOREIGN KEY (enterprise_id, principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE principal ADD CONSTRAINT poc20_principal_person_fk FOREIGN KEY (enterprise_id, person_id) REFERENCES person(enterprise_id, id);
ALTER TABLE principal ADD CONSTRAINT poc20_principal_owner_person_fk FOREIGN KEY (enterprise_id, owner_person_id) REFERENCES person(enterprise_id, id);

ALTER TABLE ai_request ADD CONSTRAINT poc20_request_principal_fk FOREIGN KEY (enterprise_id, principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE ai_request ADD CONSTRAINT poc20_request_key_fk FOREIGN KEY (enterprise_id, principal_key_id) REFERENCES principal_key(enterprise_id, id);
ALTER TABLE route_candidate ADD CONSTRAINT poc20_candidate_request_fk FOREIGN KEY (enterprise_id, ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE route_candidate ADD CONSTRAINT poc20_candidate_resource_fk FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id, id);
ALTER TABLE upstream_attempt ADD CONSTRAINT poc20_attempt_request_fk FOREIGN KEY (enterprise_id, ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE upstream_attempt ADD CONSTRAINT poc20_attempt_resource_fk FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id, id);
ALTER TABLE usage_event ADD CONSTRAINT poc20_usage_request_fk FOREIGN KEY (enterprise_id, ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE usage_event ADD CONSTRAINT poc20_usage_attempt_fk FOREIGN KEY (enterprise_id, upstream_attempt_id) REFERENCES upstream_attempt(enterprise_id, id);
ALTER TABLE usage_event ADD CONSTRAINT poc20_usage_resource_fk FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id, id);
ALTER TABLE ledger_line ADD CONSTRAINT poc20_line_request_fk FOREIGN KEY (enterprise_id, ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE ledger_line ADD CONSTRAINT poc20_line_usage_fk FOREIGN KEY (enterprise_id, usage_event_id) REFERENCES usage_event(enterprise_id, id);
ALTER TABLE ledger_line ADD CONSTRAINT poc20_line_attempt_fk FOREIGN KEY (enterprise_id, upstream_attempt_id) REFERENCES upstream_attempt(enterprise_id, id);
ALTER TABLE ledger_line ADD CONSTRAINT poc20_line_resource_fk FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id, id);
ALTER TABLE ledger_line ADD CONSTRAINT poc20_line_principal_fk FOREIGN KEY (enterprise_id, principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE ledger_transaction ADD CONSTRAINT poc20_tx_request_fk FOREIGN KEY (enterprise_id, ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE ledger_transaction ADD CONSTRAINT poc20_tx_principal_fk FOREIGN KEY (enterprise_id, principal_id) REFERENCES principal(enterprise_id, id);

ALTER TABLE person_external_identity ADD CONSTRAINT poc20_identity_person_fk FOREIGN KEY (enterprise_id, person_id) REFERENCES person(enterprise_id, id);
ALTER TABLE availability_rule ADD CONSTRAINT poc20_rule_admin_fk FOREIGN KEY (enterprise_id, created_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_rule_fk FOREIGN KEY (enterprise_id, availability_rule_id) REFERENCES availability_rule(enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_provider_fk FOREIGN KEY (enterprise_id, provider_id) REFERENCES provider(enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_resource_fk FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_model_fk FOREIGN KEY (enterprise_id, unified_model_id) REFERENCES unified_model(enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_created_fk FOREIGN KEY (enterprise_id, created_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE availability_rule_version ADD CONSTRAINT poc20_rule_version_published_fk FOREIGN KEY (enterprise_id, published_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE availability_event ADD CONSTRAINT poc20_event_rule_version_fk FOREIGN KEY (enterprise_id, rule_version_id, availability_rule_id, rule_version) REFERENCES availability_rule_version(enterprise_id, id, availability_rule_id, rule_version);
ALTER TABLE availability_event ADD CONSTRAINT poc20_event_resource_fk FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource(enterprise_id, id);
ALTER TABLE availability_event ADD CONSTRAINT poc20_event_request_fk FOREIGN KEY (enterprise_id, trigger_ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE availability_event ADD CONSTRAINT poc20_event_principal_fk FOREIGN KEY (enterprise_id, trigger_principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE notification_delivery ADD CONSTRAINT poc20_delivery_event_fk FOREIGN KEY (enterprise_id, availability_event_id) REFERENCES availability_event(enterprise_id, id);
ALTER TABLE notification_delivery ADD CONSTRAINT poc20_delivery_endpoint_fk FOREIGN KEY (enterprise_id, notification_endpoint_id) REFERENCES notification_endpoint(enterprise_id, id);
ALTER TABLE notification_delivery ADD CONSTRAINT poc20_delivery_person_fk FOREIGN KEY (enterprise_id, recipient_person_id) REFERENCES person(enterprise_id, id);
ALTER TABLE notification_delivery ADD CONSTRAINT poc20_delivery_identity_fk FOREIGN KEY (enterprise_id, recipient_identity_id) REFERENCES person_external_identity(enterprise_id, id);
ALTER TABLE alert_event ADD CONSTRAINT poc20_alert_availability_event_fk FOREIGN KEY (enterprise_id, availability_event_id) REFERENCES availability_event(enterprise_id, id);

ALTER TABLE operating_bill_period ADD CONSTRAINT poc20_period_admin_fk FOREIGN KEY (enterprise_id, created_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE operating_bill_value_item ADD CONSTRAINT poc20_value_period_fk FOREIGN KEY (enterprise_id, period_id) REFERENCES operating_bill_period(enterprise_id, id);
ALTER TABLE operating_bill_value_item ADD CONSTRAINT poc20_value_principal_fk FOREIGN KEY (enterprise_id, related_principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE operating_bill_value_item ADD CONSTRAINT poc20_value_submitted_fk FOREIGN KEY (enterprise_id, submitted_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE operating_bill_value_item ADD CONSTRAINT poc20_value_confirmed_fk FOREIGN KEY (enterprise_id, confirmed_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE operating_bill_request_project_assignment ADD CONSTRAINT poc20_assignment_request_fk FOREIGN KEY (enterprise_id, ai_request_id) REFERENCES ai_request(enterprise_id, id);
ALTER TABLE operating_bill_request_project_assignment ADD CONSTRAINT poc20_assignment_project_fk FOREIGN KEY (enterprise_id, project_principal_id) REFERENCES principal(enterprise_id, id);
ALTER TABLE operating_bill_request_project_assignment ADD CONSTRAINT poc20_assignment_admin_fk FOREIGN KEY (enterprise_id, assigned_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE operating_bill_version ADD CONSTRAINT poc20_version_period_fk FOREIGN KEY (enterprise_id, period_id) REFERENCES operating_bill_period(enterprise_id, id);
ALTER TABLE operating_bill_version ADD CONSTRAINT poc20_version_admin_fk FOREIGN KEY (enterprise_id, closed_by) REFERENCES admin_user(enterprise_id, id);
ALTER TABLE operating_bill_event ADD CONSTRAINT poc20_bill_event_period_fk FOREIGN KEY (enterprise_id, period_id) REFERENCES operating_bill_period(enterprise_id, id);
ALTER TABLE operating_bill_event ADD CONSTRAINT poc20_bill_event_admin_fk FOREIGN KEY (enterprise_id, actor_admin_id) REFERENCES admin_user(enterprise_id, id);

CREATE TABLE poc20_schema_contract (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version text NOT NULL,
  minimum_writer_version text NOT NULL,
  writer_cutover boolean NOT NULL DEFAULT false,
  migrated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO poc20_schema_contract(singleton, schema_version, minimum_writer_version, writer_cutover)
VALUES (true, '2.0-representative', '2.0', false);

GRANT USAGE ON SCHEMA public TO ql_poc_v1, ql_poc_v2;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ql_poc_v1, ql_poc_v2;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ql_poc_v1;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ql_poc_v2;

COMMIT;
