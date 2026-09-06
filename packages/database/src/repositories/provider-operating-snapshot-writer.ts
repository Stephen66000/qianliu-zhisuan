import type { Transaction } from "kysely";
import type { Database } from "../kysely.js";
import type { ProviderResource, OperatingSnapshotInput } from "./provider-repository.js";

export class CurrentSubscriptionPeriodRequiredError extends Error {
  constructor() {
    super("current subscription period is required for Coding Plan quota configuration");
    this.name = "CurrentSubscriptionPeriodRequiredError";
  }
}

async function bindPlanSnapshotToCurrentPeriod(
  trx: Transaction<Database>, enterpriseId: string, resourceId: string,
  operating: OperatingSnapshotInput,
): Promise<OperatingSnapshotInput> {
  const now = new Date();
  const period = await trx.selectFrom("provider_subscription_period")
    .select(["id", "finance_event_id", "migration_source_record_id", "product_name",
      "period_start", "period_end_exclusive"])
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", resourceId)
    .where("reversed_by_event_id", "is", null)
    .where("period_start", "<=", now)
    .where("period_end_exclusive", ">", now)
    .orderBy("period_start", "desc").orderBy("created_at", "desc").orderBy("id", "desc")
    .forUpdate().executeTakeFirst();
  if (!period) throw new CurrentSubscriptionPeriodRequiredError();

  const event = period.finance_event_id
    ? await trx.selectFrom("provider_finance_event")
      .select(["account_amount", "account_currency"])
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", period.finance_event_id).executeTakeFirst()
    : null;
  let snapshotQuery = trx.selectFrom("provider_resource_operating_snapshot")
    .select(["package_cost", "currency"])
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", resourceId)
    .where((eb) => eb.or([eb("package_cost", "is not", null), eb("total_quota", "is not", null)]));
  snapshotQuery = period.migration_source_record_id
    ? snapshotQuery.where("id", "=", period.migration_source_record_id)
    : snapshotQuery.where("effective_from", "<=", period.period_start)
      .where("effective_until", ">=", period.period_end_exclusive);
  const prior = await snapshotQuery
    .orderBy("collected_at", "desc").orderBy("version", "desc").executeTakeFirst();

  return {
    ...operating,
    collected_at: now,
    package_name: operating.package_name ?? period.product_name,
    package_cost: event?.account_amount ?? prior?.package_cost ?? null,
    currency: event?.account_currency ?? prior?.currency ?? null,
    effective_from: period.period_start,
    effective_until: period.period_end_exclusive,
    subscription_period_id: period.id,
  };
}

export async function appendOperatingSnapshot(
  trx: Transaction<Database>, enterpriseId: string, resourceId: string,
  resourceMode: ProviderResource["mode"], operating: OperatingSnapshotInput,
  bindCurrentSubscriptionPeriod: boolean,
): Promise<void> {
  const snapshot = bindCurrentSubscriptionPeriod
    && resourceMode === "CODING_PLAN" && operating.source === "ADMIN"
    ? await bindPlanSnapshotToCurrentPeriod(trx, enterpriseId, resourceId, operating)
    : operating;
  const previous = await trx.selectFrom("provider_resource_operating_snapshot")
    .select("version").where("provider_resource_id", "=", resourceId)
    .orderBy("version", "desc").executeTakeFirst();
  await trx.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: enterpriseId,
    provider_resource_id: resourceId,
    version: (previous?.version ?? 0) + 1,
    source: snapshot.source,
    collected_at: snapshot.collected_at,
    currency: snapshot.currency ?? null,
    recharge_amount: snapshot.recharge_amount ?? null,
    current_balance: snapshot.current_balance ?? null,
    cumulative_cost: snapshot.cumulative_cost ?? null,
    current_period_cost: snapshot.current_period_cost ?? null,
    cost_period_start: snapshot.cost_period_start ?? null,
    cost_period_end: snapshot.cost_period_end ?? null,
    balance_updated_at: snapshot.balance_updated_at ?? null,
    package_name: snapshot.package_name ?? null,
    package_cost: snapshot.package_cost ?? null,
    total_quota: snapshot.total_quota ?? null,
    quota_unit: snapshot.quota_unit ?? null,
    used_quota: snapshot.used_quota ?? null,
    remaining_quota: snapshot.remaining_quota ?? null,
    effective_from: snapshot.effective_from ?? null,
    effective_until: snapshot.effective_until ?? null,
    reset_cycle: snapshot.reset_cycle ?? null,
    reset_anchor_at: snapshot.reset_anchor_at ?? null,
    reset_timezone: snapshot.reset_timezone ?? null,
    usage_calculation: snapshot.usage_calculation ?? "MANUAL_SNAPSHOT",
    next_reset_at: snapshot.next_reset_at ?? null,
    subscription_period_id: snapshot.subscription_period_id ?? null,
  }).execute();
}
