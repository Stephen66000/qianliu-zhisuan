-- Kimi k3/k3-256k 计价规则 + 启用 route + 激活 unified_model + 停用旧笼统别名
-- CODING_PLAN 套餐模式，用 MODEL_TIER（倍率）。倍率为初始估值，后续按官方 Coding Plan 倍率调整。
-- enterprise_id 与 resource_id 已内联（从生产数据库查得）。
-- 用法：psql ... -f configure-kimi-k3.sql

-- 1. 建 k3 计价规则（MODEL_TIER 倍率 1，基础档）
INSERT INTO billing_rule (enterprise_id, provider_resource_id, upstream_model, rule_type, rule_version, effective_from, multiplier, currency, priority, enabled, source)
VALUES
  ('77967fc2-93a5-44e9-889f-e52fce509616', 'e75fe982-c83b-46a7-9fcb-c7876754e5a9', 'k3', 'MODEL_TIER', 'kimi-k3-base-v1', now(),
   1, 'CNY', 100, true, 'Kimi Coding Plan 初始倍率，待按官方计价调整'),
  ('77967fc2-93a5-44e9-889f-e52fce509616', 'e75fe982-c83b-46a7-9fcb-c7876754e5a9', 'k3-256k', 'MODEL_TIER', 'kimi-k3-256k-base-v1', now(),
   2, 'CNY', 100, true, 'Kimi Coding Plan 初始倍率（256k长上下文2倍），待按官方计价调整');

-- 2. 启用 k3/k3-256k 的 model_route
UPDATE model_route SET enabled = true, updated_at = now()
WHERE upstream_model IN ('k3', 'k3-256k');

-- 3. 激活 k3/k3-256k 的 unified_model 状态
UPDATE unified_model SET status = 'ACTIVE'
WHERE alias IN ('qianliu-kimi-k3', 'qianliu-kimi-k3-256k');

-- 4. 停用旧笼统别名 Kimi 的 route（upstream_model = K3）
UPDATE model_route SET enabled = false, updated_at = now()
WHERE upstream_model = 'K3';
