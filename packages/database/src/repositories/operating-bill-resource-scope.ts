import { sql } from "kysely";

/**
 * Archiving stops a resource from creating new empty monthly obligations. It does
 * not remove a month in which it was available, recorded facts, or carried funds.
 * Shared by the legacy bill and finance projections so their rows/gaps agree.
 * Legacy opening/snapshot evidence only preserves scope; it does not create a
 * finance account or substitute for the finance ledger's opening balance.
 */
export function operatingBillResourceScope(
  resourceAlias: string,
  providerAlias: string,
  start: Date,
  end: Date,
) {
  const resourceId = sql.ref(`${resourceAlias}.id`);
  const enterpriseId = sql.ref(`${resourceAlias}.enterprise_id`);
  const mode = sql.ref(`${resourceAlias}.mode`);
  const resourceArchivedAt = sql.ref(`${resourceAlias}.archived_at`);
  const providerArchivedAt = sql.ref(`${providerAlias}.archived_at`);
  return sql<boolean>`(
    ((${resourceArchivedAt} IS NULL OR ${resourceArchivedAt} >= ${start})
      AND (${providerArchivedAt} IS NULL OR ${providerArchivedAt} >= ${start}))
    OR EXISTS (
      SELECT 1 FROM ledger_line scope_line
       WHERE scope_line.enterprise_id = ${enterpriseId}
         AND scope_line.provider_resource_id = ${resourceId}
         AND ((scope_line.created_at >= ${start} AND scope_line.created_at < ${end})
           OR (scope_line.settled_at >= ${start} AND scope_line.settled_at < ${end}))
    )
    OR EXISTS (
      SELECT 1 FROM provider_finance_event scope_event
       WHERE scope_event.enterprise_id = ${enterpriseId}
         AND scope_event.provider_resource_id = ${resourceId}
         AND scope_event.occurred_at < ${end}
         AND (scope_event.occurred_at >= ${start}
           OR scope_event.event_type = 'API_OPENING_BALANCE')
    )
    OR EXISTS (
      SELECT 1 FROM resource_purchase_record scope_purchase
       WHERE scope_purchase.enterprise_id = ${enterpriseId}
         AND scope_purchase.provider_resource_id = ${resourceId}
         AND scope_purchase.purchased_at >= ${start}
         AND scope_purchase.purchased_at < ${end}
    )
    OR EXISTS (
      SELECT 1 FROM provider_subscription_period scope_period
       WHERE scope_period.enterprise_id = ${enterpriseId}
         AND scope_period.provider_resource_id = ${resourceId}
         AND scope_period.reversed_by_event_id IS NULL
         AND scope_period.period_start < ${end}
         AND scope_period.period_end_exclusive > ${start}
    )
    OR EXISTS (
      SELECT 1 FROM provider_resource_operating_snapshot scope_snapshot
       WHERE scope_snapshot.enterprise_id = ${enterpriseId}
         AND scope_snapshot.provider_resource_id = ${resourceId}
         AND scope_snapshot.collected_at < ${end}
         AND ((${mode} = 'API' AND scope_snapshot.current_balance IS NOT NULL
             AND scope_snapshot.currency IS NOT NULL)
           OR (${mode} = 'CODING_PLAN' AND scope_snapshot.package_cost IS NOT NULL
             AND scope_snapshot.effective_from < ${end}
             AND scope_snapshot.effective_until > ${start}))
    )
    OR EXISTS (
      SELECT 1 FROM operating_bill_opening_balance scope_opening
       JOIN operating_bill_period scope_bill
         ON scope_bill.enterprise_id = scope_opening.enterprise_id
        AND scope_bill.id = scope_opening.period_id
       WHERE scope_opening.enterprise_id = ${enterpriseId}
         AND scope_opening.provider_resource_id = ${resourceId}
         AND scope_bill.period_month < (${end} AT TIME ZONE 'Asia/Shanghai')::date
    )
  )`;
}
