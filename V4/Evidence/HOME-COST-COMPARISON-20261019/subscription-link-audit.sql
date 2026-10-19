-- READ ONLY. Execute through the existing production query channel; do not upload this file.
-- Bind :enterprise, :window_start, :window_end as psql variables.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'Asia/Shanghai';
WITH scoped AS (
  SELECT line.* FROM ledger_line line
   WHERE line.enterprise_id=:'enterprise'::uuid AND line.resource_mode='CODING_PLAN'
     AND COALESCE(line.settled_at,line.created_at)>=:'window_start'::timestamptz
     AND COALESCE(line.settled_at,line.created_at)<:'window_end'::timestamptz
     AND line.subscription_period_id IS NULL
)
SELECT line.id AS ledger_line_id, line.enterprise_id, line.provider_resource_id,
       COALESCE(line.settled_at,line.created_at) AS usage_at,
       line.subscription_period_id AS before_subscription_period_id,
       COUNT(period.id) AS matching_period_count,
       CASE WHEN COUNT(period.id)=1 THEN MIN(period.id::text) END AS proposed_period_id,
       md5(to_jsonb(line)::text) AS before_line_hash,
       md5((to_jsonb(line)-'subscription_period_id')::text) AS non_target_hash,
       jsonb_agg(jsonb_build_object('id',period.id,'start',period.period_start,
         'endExclusive',period.period_end_exclusive,'source',period.source,
         'financeEventId',period.finance_event_id,'migrationSourceRecordId',period.migration_source_record_id,
         'reversedByEventId',period.reversed_by_event_id,'fingerprint',md5(to_jsonb(period)::text))
         ORDER BY period.id) FILTER (WHERE period.id IS NOT NULL) AS matching_periods
  FROM scoped line LEFT JOIN provider_subscription_period period
    ON period.enterprise_id=line.enterprise_id AND period.provider_resource_id=line.provider_resource_id
   AND period.reversed_by_event_id IS NULL
   AND period.period_start<=COALESCE(line.settled_at,line.created_at)
   AND period.period_end_exclusive>COALESCE(line.settled_at,line.created_at)
 GROUP BY line.id,line.enterprise_id,line.provider_resource_id,line.settled_at,line.created_at,
          line.subscription_period_id,to_jsonb(line)
 ORDER BY line.id;
ROLLBACK;
