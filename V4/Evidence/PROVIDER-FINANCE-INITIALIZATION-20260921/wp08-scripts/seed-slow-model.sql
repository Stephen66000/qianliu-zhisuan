-- WP08 本地一次性合成数据：新增一条"慢响应"模型路由，用于演练在途请求排空。
-- 仅作用于本地一次性容器库；上游 upstream_model 触发 stub 的延迟应答分支。
DO $$
DECLARE
  v_ent uuid := '11111111-1111-4111-8111-111111111111';
  v_res uuid := '66666666-6666-4666-8666-666666666666';
  v_model uuid;
  v_key_id uuid;
BEGIN
  SELECT id INTO v_key_id FROM principal_key WHERE enterprise_id = v_ent LIMIT 1;

  INSERT INTO unified_model (enterprise_id, alias, display_name, status)
  VALUES (v_ent, 'wp08-synthetic-slow', 'WP08 合成慢模型', 'ACTIVE')
  RETURNING id INTO v_model;

  INSERT INTO model_route (enterprise_id, unified_model_id, provider_resource_id, upstream_model, enabled)
  VALUES (v_ent, v_model, v_res, 'wp08-slow-model', true);

  INSERT INTO billing_rule (enterprise_id, provider_resource_id, upstream_model, rule_type,
                            rule_version, effective_from, cache_miss_price)
  VALUES (v_ent, v_res, 'wp08-slow-model', 'API_PRICE', 'wp08-local', to_timestamp(0), '0.000001');

  UPDATE principal_key
     SET allowed_model_ids = allowed_model_ids || to_jsonb(v_model)
   WHERE id = v_key_id;

  INSERT INTO principal_grant (enterprise_id, principal_id, provider, model_alias, quota_value, status)
  SELECT v_ent, principal_id, 'deepseek', 'wp08-synthetic-slow', 1000000, 'ACTIVE'
    FROM principal_key WHERE id = v_key_id;
END $$;

SELECT 'slow_model_id=' || id::text FROM unified_model WHERE alias = 'wp08-synthetic-slow';
SELECT 'routes=' || count(*)::text FROM model_route
 WHERE enterprise_id = '11111111-1111-4111-8111-111111111111';
