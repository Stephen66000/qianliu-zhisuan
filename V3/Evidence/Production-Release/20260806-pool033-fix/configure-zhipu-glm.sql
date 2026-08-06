-- 智谱 glm-4.6/4.7/5.2 计价规则 + 启用 route + 激活 unified_model + 停用旧笼统别名
-- CODING_PLAN 套餐模式，用 MODEL_TIER（倍率 1，基础档）。
-- glm-5.2 已有 TIME_WINDOW 高峰规则（倍率 3）保留，此处补 MODEL_TIER base 让 catalog 判就绪。
-- glm-4.6/4.7 完全新建。
-- 用法：psql ... -f configure-zhipu-glm.sql

-- 1. 建 MODEL_TIER base 计价规则（倍率 1）
INSERT INTO billing_rule (enterprise_id, provider_resource_id, upstream_model, rule_type, rule_version, effective_from, multiplier, currency, priority, enabled, source)
VALUES
  ('77967fc2-93a5-44e9-889f-e52fce509616', '74f8cb60-1702-4125-9a2b-c81ce69988c9', 'glm-4.6', 'MODEL_TIER', 'zhipu-glm46-base-v1', now(),
   1, 'CNY', 100, true, '智谱 Coding Plan 套餐制，倍率 1'),
  ('77967fc2-93a5-44e9-889f-e52fce509616', '74f8cb60-1702-4125-9a2b-c81ce69988c9', 'glm-4.7', 'MODEL_TIER', 'zhipu-glm47-base-v1', now(),
   1, 'CNY', 100, true, '智谱 Coding Plan 套餐制，倍率 1'),
  ('77967fc2-93a5-44e9-889f-e52fce509616', '74f8cb60-1702-4125-9a2b-c81ce69988c9', 'glm-5.2', 'MODEL_TIER', 'zhipu-glm52-base-v1', now(),
   1, 'CNY', 100, true, '智谱 Coding Plan 套餐制，倍率 1（高峰 TIME_WINDOW 倍率 3 保留）');

-- 2. 启用 glm-4.6/4.7/5.2 的 model_route
UPDATE model_route SET enabled = true, updated_at = now()
WHERE upstream_model IN ('glm-4.6', 'glm-4.7', 'glm-5.2')
-- 只启用新型号的 route（zhipu 笼统别名的 upstream_model 也是 glm-5.2，但它在别的 unified_model 上）
AND unified_model_id IN (
  SELECT id FROM unified_model WHERE alias IN ('qianliu-zhipu-glm-4-6','qianliu-zhipu-glm-4-7','qianliu-zhipu-glm-5-2')
);

-- 3. 激活 glm-4.6/4.7/5.2 的 unified_model 状态
UPDATE unified_model SET status = 'ACTIVE'
WHERE alias IN ('qianliu-zhipu-glm-4-6', 'qianliu-zhipu-glm-4-7', 'qianliu-zhipu-glm-5-2');

-- 4. 停用旧笼统别名 zhipu 的 route
UPDATE model_route SET enabled = false, updated_at = now()
WHERE unified_model_id = (SELECT id FROM unified_model WHERE alias = 'zhipu');
