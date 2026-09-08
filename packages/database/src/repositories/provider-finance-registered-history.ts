import { Money, money } from "./provider-finance-core.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { FinanceEventView } from "./provider-finance-types.js";

/** Read existing registered subscription fees by period start; never inserts payment events. */
export async function registeredSubscriptionHistory(db: Kysely<Database>, enterpriseId: string) {
  const result = await sql<{ id: string; resource_id: string; amount: string; currency: "CNY" | "USD";
    at: Date; created: Date; product: string }>`
    SELECT period.id,period.provider_resource_id AS resource_id,snapshot.package_cost::text AS amount,
      COALESCE(snapshot.currency,tenant.default_currency)::text AS currency,
      period.period_start AS at,period.created_at AS created,period.product_name AS product
    FROM provider_subscription_period period JOIN enterprise tenant ON tenant.id=period.enterprise_id
    JOIN LATERAL (
      SELECT package_cost,currency FROM provider_resource_operating_snapshot snapshot
      WHERE snapshot.enterprise_id=period.enterprise_id AND snapshot.provider_resource_id=period.provider_resource_id
        AND snapshot.package_cost IS NOT NULL AND (snapshot.subscription_period_id=period.id
          OR (snapshot.subscription_period_id IS NULL AND (snapshot.id=period.migration_source_record_id
            OR (period.migration_source_record_id IS NULL AND snapshot.effective_from<=period.period_start
              AND snapshot.effective_until>=period.period_end_exclusive))))
      ORDER BY snapshot.collected_at DESC,snapshot.version DESC LIMIT 1
    ) snapshot ON true
    WHERE period.enterprise_id=${enterpriseId}::uuid AND period.finance_event_id IS NULL
      AND period.reversed_by_event_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM resource_purchase_record purchase
        WHERE purchase.enterprise_id=period.enterprise_id AND purchase.provider_resource_id=period.provider_resource_id
          AND purchase.purchase_type='PACKAGE_PURCHASE'
          AND (purchase.id=period.migration_source_record_id OR
            purchase.service_period_start=(period.period_start AT TIME ZONE 'Asia/Shanghai')::date))
  `.execute(db);
  const events = result.rows.map((row): FinanceEventView => ({ id: `registered:${row.id}`, providerResourceId: row.resource_id,
    eventType: "CODING_PLAN_PURCHASE", accountAmount: row.amount, accountCurrency: row.currency,
    cashPaidCny: row.currency === "CNY" ? row.amount : null, occurredAt: row.at.toISOString(),
    createdAt: row.created.toISOString(), source: "HISTORICAL_REGISTRATION", description: `${row.product} · 已登记订阅`,
    evidenceRef: `subscription-period:${row.id}`, externalReference: null, reversalOfEventId: null,
    correctionOfEventId: null, reconciliationCaseId: null, legacyCostResolutionId: null }));
  const purchases = await sql<{ id:string; resource_id:string; amount:string; currency:"CNY"|"USD";
    at:Date; created:Date; source:string; description:string|null; evidence:string|null; type:string }>`
    SELECT purchase.id,purchase.provider_resource_id AS resource_id,purchase.amount::text,purchase.currency,
      purchase.purchased_at AS at,purchase.created_at AS created,purchase.source,purchase.description,
      purchase.evidence_ref AS evidence,purchase.purchase_type AS type
    FROM resource_purchase_record purchase WHERE purchase.enterprise_id=${enterpriseId}::uuid
      AND NOT EXISTS (SELECT 1 FROM provider_finance_event event
        WHERE event.enterprise_id=purchase.enterprise_id AND event.provider_resource_id=purchase.provider_resource_id
          AND event.external_reference=('legacy-purchase:'||purchase.id::text))`.execute(db);
  for (const row of purchases.rows) events.push({id:`legacy:${row.id}`,providerResourceId:row.resource_id,
    eventType:row.type === "PACKAGE_PURCHASE" ? "CODING_PLAN_PURCHASE" : "API_RECHARGE",
    accountAmount:row.amount,accountCurrency:row.currency,cashPaidCny:row.currency === "CNY" ? row.amount : null,
    occurredAt:row.at.toISOString(),createdAt:row.created.toISOString(),source:row.source,description:row.description,
    evidenceRef:row.evidence,externalReference:null,reversalOfEventId:null,correctionOfEventId:null,
    reconciliationCaseId:null,legacyCostResolutionId:null});
  return events;
}

export async function historicalMonthlyFinance(db: Kysely<Database>, enterpriseId: string, start: Date, end: Date) {
  const events = (await registeredSubscriptionHistory(db, enterpriseId))
    .filter((row) => new Date(row.occurredAt) >= start && new Date(row.occurredAt) < end);
  return { cash: money(events.reduce((sum, row) => sum.plus(row.cashPaidCny ?? "0"), new Money(0))),
    amounts: events.map((row) => ({ mode: (row.eventType === "API_RECHARGE" ? "API" : "CODING_PLAN") as "API" | "CODING_PLAN",
      currency: row.accountCurrency, amount: row.accountAmount, cash_cny: row.cashPaidCny ?? "0" })) };
}

export function summarizeFinanceOrders(rows: Array<{ mode: "API" | "CODING_PLAN"; currency: "CNY" | "USD"; amount: string; cash_cny: string }>) {
  const byMode = (mode: "API" | "CODING_PLAN") => {
    const amounts = new Map<"CNY" | "USD", InstanceType<typeof Money>>();
    for (const row of rows.filter((r) => r.mode === mode)) amounts.set(row.currency, (amounts.get(row.currency) ?? new Money(0)).plus(row.amount));
    return [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: money(amount) }));
  };
  return { apiRecharges: byMode("API"), codingPlanOrders: byMode("CODING_PLAN"),
    planCash: rows.filter((row) => row.mode === "CODING_PLAN").reduce((sum, row) => sum.plus(row.cash_cny), new Money(0)) };
}

/** The overview resource projection must use the same historical subscription facts as the procurement list. */
export async function resourcePlanCostsWithHistory(
  db: Kysely<Database>, enterpriseId: string, start: Date, end: Date, asOf: Date,
  current: Array<{ provider_resource_id: string; cash_cny: string }>,
): Promise<Map<string, string>> {
  const amounts = new Map(current.map((row) => [row.provider_resource_id, row.cash_cny]));
  const history = await registeredSubscriptionHistory(db, enterpriseId);
  for (const row of history) {
    const at = new Date(row.occurredAt);
    if (row.eventType !== "CODING_PLAN_PURCHASE" && row.eventType !== "CODING_PLAN_RENEWAL") continue;
    if (at < start || at >= end || at > asOf || row.cashPaidCny === null) continue;
    amounts.set(row.providerResourceId, money(new Money(amounts.get(row.providerResourceId) ?? 0).plus(row.cashPaidCny)));
  }
  return amounts;
}
