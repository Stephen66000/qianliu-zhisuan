BEGIN;
INSERT INTO enterprise(id, name) VALUES
  ('53000000-0000-4000-8000-000000000001', '未声明目标企业 A'),
  ('53000000-0000-4000-8000-000000000002', '未声明目标企业 B');
INSERT INTO person(id, name, status) VALUES
  ('53000000-0000-4000-8000-000000000011', '无父链人员', 'ACTIVE');
INSERT INTO notification_endpoint(id, provider, corp_id, agent_id, secret_ciphertext, secret_fingerprint, status) VALUES
  ('53000000-0000-4000-8000-000000000012', 'WECOM_APP', 'ambiguous-corp', 'ambiguous-agent', 'synthetic', 'synthetic', 'ACTIVE');
COMMIT;
