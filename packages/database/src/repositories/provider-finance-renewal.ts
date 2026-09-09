import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { Money, money, lockResource } from "./provider-finance-core.js";
import { ProviderFinanceError } from "./provider-finance-types.js";
import { loadLegacySubscriptionFee } from "./provider-finance-period-facts.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { nextSubscriptionEnd } from "./subscription-renewal-calendar.js";

async function resourceState(db: Kysely<Database>, enterpriseId: string, resourceId: string) {
  const row = await db.selectFrom("provider_resource as resource")
    .innerJoin("provider", "provider.id", "resource.provider_id")
    .select(["resource.id", "resource.mode", "resource.subscription_auto_renew_enabled", "provider.code", "provider.name"])
    .where("resource.enterprise_id", "=", enterpriseId).where("provider.enterprise_id", "=", enterpriseId)
    .where("resource.id", "=", resourceId).where("resource.status", "<>", "DELETED").executeTakeFirst();
  if (!row) throw new ProviderFinanceError("NOT_FOUND", "厂商资源不存在");
  if (row.mode !== "CODING_PLAN") {
    throw new ProviderFinanceError("INVALID_MODE", "该资源不适用套餐自动续订");
  }
  return row;
}
async function renewalPlan(db: Kysely<Database>, enterpriseId: string, resourceId: string) {
  const base = () => db.selectFrom("provider_subscription_period as period")
    .leftJoin("provider_finance_event as event", join => join.onRef("event.id", "=", "period.finance_event_id").onRef("event.enterprise_id", "=", "period.enterprise_id"))
    .selectAll("period").select(["event.account_amount", "event.account_currency", "event.cash_paid_cny", "event.source as event_source"])
    .where("period.enterprise_id", "=", enterpriseId).where("period.provider_resource_id", "=", resourceId)
    .orderBy("period.period_start", "desc").orderBy("period.created_at", "desc").orderBy("period.id", "desc");
  const latest = await base().executeTakeFirst();
  if (!latest) return null;
  // System-generated periods never become the calendar template: Jan 31 must not drift to Mar 28.
  const template = await base().where(eb => eb.or([eb("event.source", "is", null), eb("event.source", "<>", "SYSTEM_RENEWAL")]))
    .where("period.reversed_by_event_id", "is", null).executeTakeFirst();
  if (!template || latest.reversed_by_event_id) return { latest, template: null, amount: null, currency: null, cash: null };
  const legacy = template.account_amount === null ? await loadLegacySubscriptionFee(db, enterpriseId, resourceId,
    template.id, template.migration_source_record_id, template.period_start, template.period_end_exclusive) : null;
  const purchase = template.account_amount === null && !legacy && template.source === "MIGRATED_PURCHASE" && template.migration_source_record_id
    ? (await sql<{ amount: string; currency: string }>`SELECT amount::text,currency FROM resource_purchase_record
        WHERE enterprise_id=${enterpriseId}::uuid AND provider_resource_id=${resourceId}::uuid
          AND id=${template.migration_source_record_id}::uuid`.execute(db)).rows[0] : null;
  const amount = template.account_amount ?? legacy?.amount ?? purchase?.amount ?? null;
  const currency = template.account_currency ?? legacy?.currency ?? purchase?.currency ?? null;
  const cash = template.cash_paid_cny ?? (currency === "CNY" ? amount : null);
  return { latest, template, amount, currency, cash };
}

export async function getSubscriptionAutoRenewal(db: Kysely<Database>, enterpriseId: string, resourceId: string) {
  const resource = await resourceState(db, enterpriseId, resourceId);
  const plan = await renewalPlan(db, enterpriseId, resourceId);
  return { enabled: resource.subscription_auto_renew_enabled,
    nextRenewalAt: resource.subscription_auto_renew_enabled && plan ? plan.latest.period_end_exclusive.toISOString() : null,
    amount: plan?.amount ?? null, currency: plan?.currency ?? null, cashPaidCny: plan?.cash ?? null,
    productName: plan?.template?.product_name ?? plan?.latest.product_name ?? null,
    blockedReason: !plan ? "未登记订阅周期" : !plan.template ? "最近订阅已冲销，请重新登记"
      : !plan.amount || !plan.cash || !new Money(plan.amount).gt(0) || !new Money(plan.cash).gt(0) ? "未登记完整续订金额" : null };
}

/** Serialize cancellation and scheduled creation with the same resource lock used by manual subscription writes. */
export async function cancelSubscriptionAutoRenewal(db: Kysely<Database>, enterpriseId: string, resourceId: string, adminId: string) {
  return db.transaction().execute(async trx => {
    await lockResource(trx, enterpriseId, resourceId);
    const resource = await resourceState(trx, enterpriseId, resourceId);
    if (resource.subscription_auto_renew_enabled) {
      await trx.updateTable("provider_resource").set({ subscription_auto_renew_enabled: false })
        .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId).execute();
      await trx.insertInto("operation_log").values({ actor_source: "ADMIN", enterprise_id: enterpriseId, admin_user_id: adminId,
        action: "subscription.auto_renew.cancel", target_type: "provider_resource", target_id: resourceId,
        result: "SUCCESS", failure_reason: null, change_summary: { enabled: false } }).execute();
    }
    return { enabled: false as const };
  });
}

export async function renewDueSubscription(db: Kysely<Database>, enterpriseId: string, resourceId: string, now: Date) {
  return db.transaction().execute(async trx => {
    await lockResource(trx, enterpriseId, resourceId);
    const resource = await resourceState(trx, enterpriseId, resourceId);
    if (!resource.subscription_auto_renew_enabled) return false;
    const enabled = (await sql<{ enabled: boolean }>`SELECT strict_writes_enabled AS enabled
      FROM provider_finance_runtime_state WHERE enterprise_id=${enterpriseId}::uuid`.execute(trx)).rows[0];
    if (!enabled?.enabled) return false;
    const plan = await renewalPlan(trx, enterpriseId, resourceId);
    if (!plan || plan.latest.period_end_exclusive > now) return false;
    if (!plan.template || !plan.amount || !plan.cash || !["CNY", "USD"].includes(plan.currency ?? "")
      || !new Money(plan.amount).gt(0) || !new Money(plan.cash).gt(0)) {
      throw new ProviderFinanceError("INVALID_REQUEST", "订阅周期或续订金额缺失，无法自动续订");
    }
    const start = plan.latest.period_end_exclusive;
    const end = nextSubscriptionEnd(plan.template.period_start, plan.template.period_end_exclusive, start);
    await guardOperatingBillLedgerWrite(trx, enterpriseId, start);
    const idempotencyKey = `auto-renewal:${resourceId}:${start.toISOString()}`;
    const prior = await trx.selectFrom("provider_finance_event").select("id").where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId).where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
    if (prior) return false; // Reversal/replay cannot silently recreate an already recorded renewal.
    const event = await trx.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: resourceId, event_type: "CODING_PLAN_RENEWAL",
      account_amount: money(plan.amount), account_currency: plan.currency as "CNY" | "USD", cash_paid_cny: money(plan.cash),
      occurred_at: start, external_reference: null, description: `${resource.name} 系统续订 ¥${new Money(plan.cash).toFixed(2)}`,
      evidence_ref: "按已登记订阅金额和周期自动续记", source: "SYSTEM_RENEWAL", idempotency_key: idempotencyKey,
      created_by_admin_user_id: null,
    }).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("provider_subscription_period").values({ enterprise_id: enterpriseId,
      provider_resource_id: resourceId, finance_event_id: event.id, product_name: plan.template.product_name,
      period_start: start, period_end_exclusive: end, source: "RENEWAL", migration_source_record_id: null,
      created_by_admin_user_id: null }).execute();
    return true;
  });
}

/** Each transaction creates at most one period; repeated ticks recover downtime without duplicate charges. */
export async function runSubscriptionAutoRenewals(db: Kysely<Database>, now = new Date()) {
  const due = await sql<{ enterprise_id: string; id: string }>`SELECT resource.enterprise_id,resource.id
    FROM provider_resource resource JOIN provider ON provider.id=resource.provider_id AND provider.enterprise_id=resource.enterprise_id
    JOIN provider_finance_runtime_state state ON state.enterprise_id=resource.enterprise_id AND state.strict_writes_enabled
    JOIN LATERAL (SELECT period_end_exclusive FROM provider_subscription_period period
      WHERE period.enterprise_id=resource.enterprise_id AND period.provider_resource_id=resource.id
      ORDER BY period_start DESC,created_at DESC,id DESC LIMIT 1) latest ON true
    WHERE resource.mode='CODING_PLAN' AND resource.status<>'DELETED'
      AND resource.subscription_auto_renew_enabled AND latest.period_end_exclusive<=${now}
    ORDER BY latest.period_end_exclusive,resource.id`.execute(db);
  let created = 0; const failures: Array<{ resourceId: string; code: string }> = [];
  for (const resource of due.rows) {
    try {
      for (let i = 0; i < 12; i += 1) {
        if (!await renewDueSubscription(db, resource.enterprise_id, resource.id, now)) break;
        created += 1;
      }
    } catch (error) {
      failures.push({ resourceId: resource.id, code: error instanceof ProviderFinanceError ? error.code : error instanceof Error ? error.name : "UNKNOWN" });
    }
  }
  return { scanned: due.rows.length, created, failures };
}
