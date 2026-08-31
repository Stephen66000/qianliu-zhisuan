-- ============================================================
-- 仟流智算 · Kimi 429 诊断脚本
-- 用法: psql "$DATABASE_URL" -f V3/tools/diagnose-kimi-429.sql
-- 说明: 只读查询，不修改任何数据
-- ============================================================

\echo '\n========== 第 1 步：Kimi 资源当前状态（必现 429 的头号嫌疑）=========='

-- 如果某行 status=RATE_LIMITED 且 cooldown_until > now()，说明资源正卡在冷却态，
-- 冷却期内所有 Kimi 请求必失败 → Codex 重试耗尽 → "exceeded retry limit, last status: 429"
SELECT
    pr.name                                   AS 资源名,
    pr.mode                                   AS 模式,
    pr.status                                 AS 资源状态,
    pr.concurrency_limit                      AS 并发上限,
    pr.consecutive_failures                   AS 连续失败次数,
    pr.credential_refresh_status              AS 凭证刷新状态,
    CASE WHEN pr.cooldown_until > now()
         THEN '⛔ 冷却中(剩余 ' || round(extract(epoch from (pr.cooldown_until - now()))::numeric) || ' 秒)'
         ELSE '✅ 未冷却'
    END                                       AS 冷却情况,
    pr.cooldown_until                         AS 冷却到期时间,
    pr.last_probe_at                          AS 最近探测时间,
    pr.resource_pool_id                       AS 资源池
FROM provider_resource pr
JOIN provider p ON p.id = pr.provider_id
WHERE p.code = 'kimi'
ORDER BY pr.created_at;
