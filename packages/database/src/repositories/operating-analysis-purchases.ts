import { registeredSubscriptionHistory } from "./provider-finance-registered-history.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";

export interface AnalysisPurchaseFact {
  id: string; resource_id: string; provider_code: string; provider_name: string; resource_name: string;
  mode: "API" | "CODING_PLAN"; currency: string; month: string; cash: string | null;
  event_type: string; occurred_at: Date; external_reference: string | null; description: string | null; source: string;
}

/** Confirmed payment records only. Legacy purchases are not inferred from recurring prices or expiry dates.
 * A later non-overlapping confirmed subscription period is a renewal; source identifies system sync versus manual entry.
 * A migrated legacy ID is excluded so the same payment cannot appear in both ledgers.
 */
export async function loadAnalysisPurchases(db: Kysely<Database>, enterpriseId: string, selectedMonth: string, now: Date) {
  const selected = operatingBillMonthRange(selectedMonth);
  const start = new Date(`${selectedMonth.slice(0, 4)}-01-01T00:00:00+08:00`);
  const until = new Date(Math.min(now.getTime(), selected.end.getTime() - 1));
  const result = await sql<AnalysisPurchaseFact>`WITH payments AS (
    SELECT event.id::text AS id,event.provider_resource_id,event.event_type::text,event.account_currency AS currency,
      event.cash_paid_cny AS cash,event.occurred_at,event.external_reference,event.description,event.source::text
    FROM provider_finance_event event
    WHERE event.enterprise_id=${enterpriseId}::uuid
      AND event.event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
      AND event.cash_paid_cny IS NOT NULL AND event.cash_paid_cny<>0
      AND event.occurred_at>=${start} AND event.occurred_at<=${until}
    UNION ALL
    SELECT ('legacy:'||purchase.id::text),purchase.provider_resource_id,CASE WHEN purchase.purchase_type='PACKAGE_PURCHASE' THEN
        CASE WHEN purchase.service_period_start IS NOT NULL AND EXISTS (
          SELECT 1 FROM resource_purchase_record prior
          WHERE prior.enterprise_id=purchase.enterprise_id AND prior.provider_resource_id=purchase.provider_resource_id
            AND prior.purchase_type='PACKAGE_PURCHASE' AND prior.service_period_end<purchase.service_period_start
            AND prior.purchased_at<purchase.purchased_at
        ) THEN 'CODING_PLAN_RENEWAL' ELSE 'CODING_PLAN_PURCHASE' END
        ELSE purchase.purchase_type::text END,purchase.currency,
      CASE WHEN purchase.currency='CNY' THEN purchase.amount ELSE NULL END,purchase.purchased_at,
      purchase.evidence_ref,purchase.description,purchase.source::text
    FROM resource_purchase_record purchase
    WHERE purchase.enterprise_id=${enterpriseId}::uuid AND purchase.amount<>0
      AND purchase.purchased_at>=${start} AND purchase.purchased_at<=${until}
      AND NOT EXISTS (SELECT 1 FROM provider_finance_event migrated
        WHERE migrated.enterprise_id=purchase.enterprise_id AND migrated.provider_resource_id=purchase.provider_resource_id
          AND migrated.external_reference=('legacy-purchase:'||purchase.id::text))
  ) SELECT payments.*,resource.id AS resource_id,provider.code AS provider_code,provider.name AS provider_name,
    resource.name AS resource_name,resource.mode,to_char(payments.occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month
    FROM payments JOIN provider_resource resource ON resource.enterprise_id=${enterpriseId}::uuid AND resource.id=payments.provider_resource_id
    JOIN provider ON provider.enterprise_id=${enterpriseId}::uuid AND provider.id=resource.provider_id
    ORDER BY payments.occurred_at DESC,payments.id DESC`.execute(db);
  const registered = (await registeredSubscriptionHistory(db, enterpriseId)).filter((row) =>
    row.id.startsWith("registered:") && new Date(row.occurredAt) >= start && new Date(row.occurredAt) <= until);
  const resources = await db.selectFrom("provider_resource as r").innerJoin("provider as p", "p.id", "r.provider_id")
    .select(["r.id", "r.name", "p.code", "p.name as provider_name"]).where("r.enterprise_id", "=", enterpriseId)
    .where("p.enterprise_id", "=", enterpriseId).execute();
  for (const row of registered) {
    const resource = resources.find((r) => r.id === row.providerResourceId); if (!resource) continue;
    result.rows.push({ id: row.id, resource_id: resource.id, provider_code: resource.code,
      provider_name: resource.provider_name, resource_name: resource.name, mode: "CODING_PLAN",
      currency: row.accountCurrency, month: new Date(new Date(row.occurredAt).getTime() + 8 * 3600000).toISOString().slice(0, 7),
      cash: row.cashPaidCny, event_type: row.eventType, occurred_at: new Date(row.occurredAt),
      external_reference: null, description: row.description, source: row.source });
  }
  return result.rows.sort((a,b) => b.occurred_at.getTime() - a.occurred_at.getTime() || b.id.localeCompare(a.id));
}
