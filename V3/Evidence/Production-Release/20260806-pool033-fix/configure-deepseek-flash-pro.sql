-- DeepSeek flash/pro 计价规则 + 启用 route + 停用旧笼统别名
-- 基于官方计价 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
-- enterprise_id 与 resource_id 已内联（从生产数据库查得）。
-- 用法：psql ... -f configure-deepseek-flash-pro.sql

-- 1. 建 flash 计价规则（base + peak 两档）
INSERT INTO billing_rule (enterprise_id, provider_resource_id, upstream_model, rule_type, rule_version, effective_from, cache_hit_price, cache_miss_price, output_price, currency, priority, enabled, source)
VALUES
  ('77967fc2-93a5-44e9-889f-e52fce509616', '73201575-c856-4931-8c8b-09f1b2fc25c4', 'deepseek-v4-flash', 'API_PRICE', 'deepseek-flash-base-v1', now(),
   0.00000002, 0.000001, 0.000002, 'CNY', 100, true, 'DeepSeek 官方计价 https://api-docs.deepseek.com/zh-cn/quick_start/pricing'),
  ('77967fc2-93a5-44e9-889f-e52fce509616', '73201575-c856-4931-8c8b-09f1b2fc25c4', 'deepseek-v4-flash', 'API_PRICE', 'deepseek-flash-peak-v1', now(),
   0.00000004, 0.000002, 0.000004, 'CNY', 200, true, 'DeepSeek 官方计价（高峰2倍）');

-- 2. 建 pro 计价规则（base + peak 两档）
INSERT INTO billing_rule (enterprise_id, provider_resource_id, upstream_model, rule_type, rule_version, effective_from, cache_hit_price, cache_miss_price, output_price, currency, priority, enabled, source)
VALUES
  ('77967fc2-93a5-44e9-889f-e52fce509616', '73201575-c856-4931-8c8b-09f1b2fc25c4', 'deepseek-v4-pro', 'API_PRICE', 'deepseek-pro-base-v1', now(),
   0.000000025, 0.000003, 0.000006, 'CNY', 100, true, 'DeepSeek 官方计价 https://api-docs.deepseek.com/zh-cn/quick_start/pricing'),
  ('77967fc2-93a5-44e9-889f-e52fce509616', '73201575-c856-4931-8c8b-09f1b2fc25c4', 'deepseek-v4-pro', 'API_PRICE', 'deepseek-pro-peak-v1', now(),
   0.00000005, 0.000006, 0.000012, 'CNY', 200, true, 'DeepSeek 官方计价（高峰2倍）');

-- 3. 启用 flash/pro 的 model_route
UPDATE model_route SET enabled = true, updated_at = now()
WHERE upstream_model IN ('deepseek-v4-flash', 'deepseek-v4-pro');

-- 4. 停用旧笼统别名 qianliu-deepseek 的 route（upstream_model = deepseek-chat）
UPDATE model_route SET enabled = false, updated_at = now()
WHERE upstream_model = 'deepseek-chat';
