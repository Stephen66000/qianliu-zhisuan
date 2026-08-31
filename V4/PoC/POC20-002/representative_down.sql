BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 回滚只撤销本 PoC 的代表性 2.0 结构；旧运行角色保持只读，避免回滚窗口误写。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM poc20_schema_contract WHERE writer_cutover) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P2004',
      MESSAGE = 'POC20-002 schema down is forbidden after 2.0 writer cutover';
  END IF;
END $$;

DROP TABLE poc20_schema_contract;

ALTER TABLE operating_bill_event DROP CONSTRAINT poc20_bill_event_admin_fk;
ALTER TABLE operating_bill_event DROP CONSTRAINT poc20_bill_event_period_fk;
ALTER TABLE operating_bill_version DROP CONSTRAINT poc20_version_admin_fk;
ALTER TABLE operating_bill_version DROP CONSTRAINT poc20_version_period_fk;
ALTER TABLE operating_bill_request_project_assignment DROP CONSTRAINT poc20_assignment_admin_fk;
ALTER TABLE operating_bill_request_project_assignment DROP CONSTRAINT poc20_assignment_project_fk;
ALTER TABLE operating_bill_request_project_assignment DROP CONSTRAINT poc20_assignment_request_fk;
ALTER TABLE operating_bill_value_item DROP CONSTRAINT poc20_value_confirmed_fk;
ALTER TABLE operating_bill_value_item DROP CONSTRAINT poc20_value_submitted_fk;
ALTER TABLE operating_bill_value_item DROP CONSTRAINT poc20_value_principal_fk;
ALTER TABLE operating_bill_value_item DROP CONSTRAINT poc20_value_period_fk;
ALTER TABLE operating_bill_period DROP CONSTRAINT poc20_period_admin_fk;

ALTER TABLE alert_event DROP CONSTRAINT poc20_alert_availability_event_fk;
ALTER TABLE notification_delivery DROP CONSTRAINT poc20_delivery_identity_fk;
ALTER TABLE notification_delivery DROP CONSTRAINT poc20_delivery_person_fk;
ALTER TABLE notification_delivery DROP CONSTRAINT poc20_delivery_endpoint_fk;
ALTER TABLE notification_delivery DROP CONSTRAINT poc20_delivery_event_fk;
ALTER TABLE availability_event DROP CONSTRAINT poc20_event_principal_fk;
ALTER TABLE availability_event DROP CONSTRAINT poc20_event_request_fk;
ALTER TABLE availability_event DROP CONSTRAINT poc20_event_resource_fk;
ALTER TABLE availability_event DROP CONSTRAINT poc20_event_rule_version_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_published_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_created_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_model_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_resource_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_provider_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_rule_fk;
ALTER TABLE availability_rule DROP CONSTRAINT poc20_rule_admin_fk;
ALTER TABLE person_external_identity DROP CONSTRAINT poc20_identity_person_fk;

ALTER TABLE ledger_transaction DROP CONSTRAINT poc20_tx_principal_fk;
ALTER TABLE ledger_transaction DROP CONSTRAINT poc20_tx_request_fk;
ALTER TABLE ledger_line DROP CONSTRAINT poc20_line_principal_fk;
ALTER TABLE ledger_line DROP CONSTRAINT poc20_line_resource_fk;
ALTER TABLE ledger_line DROP CONSTRAINT poc20_line_attempt_fk;
ALTER TABLE ledger_line DROP CONSTRAINT poc20_line_usage_fk;
ALTER TABLE ledger_line DROP CONSTRAINT poc20_line_request_fk;
ALTER TABLE usage_event DROP CONSTRAINT poc20_usage_resource_fk;
ALTER TABLE usage_event DROP CONSTRAINT poc20_usage_attempt_fk;
ALTER TABLE usage_event DROP CONSTRAINT poc20_usage_request_fk;
ALTER TABLE upstream_attempt DROP CONSTRAINT poc20_attempt_resource_fk;
ALTER TABLE upstream_attempt DROP CONSTRAINT poc20_attempt_request_fk;
ALTER TABLE route_candidate DROP CONSTRAINT poc20_candidate_resource_fk;
ALTER TABLE route_candidate DROP CONSTRAINT poc20_candidate_request_fk;
ALTER TABLE ai_request DROP CONSTRAINT poc20_request_key_fk;
ALTER TABLE ai_request DROP CONSTRAINT poc20_request_principal_fk;
ALTER TABLE principal DROP CONSTRAINT poc20_principal_owner_person_fk;
ALTER TABLE principal DROP CONSTRAINT poc20_principal_person_fk;
ALTER TABLE principal_grant DROP CONSTRAINT poc20_grant_principal_fk;
ALTER TABLE principal_key DROP CONSTRAINT poc20_key_principal_fk;
ALTER TABLE quota_counter DROP CONSTRAINT poc20_counter_grant_fk;
ALTER TABLE employee_login DROP CONSTRAINT poc20_login_principal_fk;
ALTER TABLE admin_session DROP CONSTRAINT poc20_session_admin_fk;

ALTER TABLE operating_bill_period DROP CONSTRAINT poc20_period_enterprise_id_uq;
ALTER TABLE notification_endpoint DROP CONSTRAINT poc20_endpoint_enterprise_id_uq;
ALTER TABLE availability_event DROP CONSTRAINT poc20_event_enterprise_id_uq;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_event_ref_uq;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_enterprise_id_uq;
ALTER TABLE availability_rule DROP CONSTRAINT poc20_rule_enterprise_id_uq;
ALTER TABLE person_external_identity DROP CONSTRAINT poc20_identity_enterprise_id_uq;
ALTER TABLE person DROP CONSTRAINT poc20_person_enterprise_id_uq;
ALTER TABLE usage_event DROP CONSTRAINT poc20_usage_enterprise_id_uq;
ALTER TABLE upstream_attempt DROP CONSTRAINT poc20_attempt_enterprise_id_uq;
ALTER TABLE ai_request DROP CONSTRAINT poc20_request_enterprise_id_uq;
ALTER TABLE principal_grant DROP CONSTRAINT poc20_principal_grant_enterprise_id_uq;
ALTER TABLE principal_key DROP CONSTRAINT poc20_principal_key_enterprise_id_uq;
ALTER TABLE principal DROP CONSTRAINT poc20_principal_enterprise_id_uq;
ALTER TABLE admin_user DROP CONSTRAINT poc20_admin_user_enterprise_id_uq;

ALTER TABLE notification_delivery DROP CONSTRAINT poc20_delivery_enterprise_fk;
ALTER TABLE notification_endpoint DROP CONSTRAINT poc20_endpoint_enterprise_fk;
ALTER TABLE availability_event DROP CONSTRAINT poc20_availability_event_enterprise_fk;
ALTER TABLE availability_rule_version DROP CONSTRAINT poc20_rule_version_enterprise_fk;
ALTER TABLE availability_rule DROP CONSTRAINT poc20_rule_enterprise_fk;
ALTER TABLE person_external_identity DROP CONSTRAINT poc20_person_identity_enterprise_fk;
ALTER TABLE person DROP CONSTRAINT poc20_person_enterprise_fk;
ALTER TABLE quota_counter DROP CONSTRAINT poc20_quota_counter_enterprise_fk;
ALTER TABLE employee_login DROP CONSTRAINT poc20_employee_login_enterprise_fk;
ALTER TABLE admin_session DROP CONSTRAINT poc20_admin_session_enterprise_fk;

ALTER TABLE notification_delivery DROP COLUMN enterprise_id;
ALTER TABLE notification_endpoint DROP COLUMN enterprise_id;
ALTER TABLE availability_event DROP COLUMN enterprise_id;
ALTER TABLE availability_rule_version DROP COLUMN enterprise_id;
ALTER TABLE availability_rule DROP COLUMN enterprise_id;
ALTER TABLE person_external_identity DROP COLUMN enterprise_id;
ALTER TABLE person DROP COLUMN enterprise_id;
ALTER TABLE quota_counter DROP COLUMN enterprise_id;
ALTER TABLE employee_login DROP COLUMN enterprise_id;
ALTER TABLE admin_session DROP COLUMN enterprise_id;

COMMIT;
