\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT name AS migration_head FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;

-- No credential, prompt, response text or personal identity is selected.
SELECT p.code AS provider_code, r.name AS resource, r.mode, b.id AS rule_id,
       b.rule_type, b.rule_version, b.enabled, b.effective_from, b.effective_to,
       b.time_windows, b.multiplier, b.cache_hit_price, b.cache_miss_price,
       b.output_price, b.currency, b.priority
  FROM billing_rule b JOIN provider_resource r ON r.id = b.provider_resource_id AND r.enterprise_id = b.enterprise_id
  JOIN provider p ON p.id = r.provider_id AND p.enterprise_id = r.enterprise_id
 WHERE b.enabled AND b.archived_at IS NULL
 ORDER BY p.code, r.name, b.priority, b.effective_from DESC;

-- Existing multiplier policies may start matching after the runtime fix.
SELECT id, policy_version, match_unified_model, match_resource_mode, match_provider_resource_id,
       match_timezone, match_days_of_week, match_start_time, match_end_time,
       match_price_multiplier_min, action, priority
  FROM dispatch_policy WHERE status = 'PUBLISHED' ORDER BY priority, id;

SELECT resource_mode, usage_quality, api_cost_status, COUNT(*) AS line_count,
       SUM(raw_input_tokens + raw_output_tokens)::text AS true_tokens,
       SUM(deducted_quota)::text AS deducted_quota, api_cost_currency,
       SUM(api_cost)::text AS known_api_cost
  FROM ledger_line WHERE created_at >= now() - INTERVAL '7 days'
 GROUP BY resource_mode, usage_quality, api_cost_status, api_cost_currency
 ORDER BY resource_mode, usage_quality, api_cost_status;

SELECT ai_request_id, upstream_attempt_id, provider_resource_id, raw_input_tokens,
       raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens, api_cost, api_cost_status,
       api_cost_currency, deducted_quota, rule_version, multiplier, settled_at
  FROM ledger_line ORDER BY created_at DESC LIMIT 20;
COMMIT;
