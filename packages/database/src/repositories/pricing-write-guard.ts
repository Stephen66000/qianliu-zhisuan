import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
export class PricingModeConflictError extends Error {
  constructor() { super("pricing_mode_conflict"); }
}

/** Serialize API mode changes across both legacy writes and atomic configuration writes. */
export async function lockPricingWrites(db: Kysely<Database>, enterpriseId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${enterpriseId}), hashtext('billing-rule-writes'))`.execute(db);
}
export async function hasConflictingPricingMode(db: Kysely<Database>, enterpriseId: string, rule: {
  id?: string; rule_type: string; pricing_mode?: string; provider_resource_id?: string | null;
  upstream_model?: string | null; effective_from: Date; effective_to?: Date | null;
}) {
  if (rule.rule_type !== "API_PRICE") return false;
  let query = db.selectFrom("billing_rule").select("id").where("enterprise_id", "=", enterpriseId)
    .where("rule_type", "=", "API_PRICE").where("enabled", "=", true).where("archived_at", "is", null)
    .where("pricing_mode", "!=", (rule.pricing_mode ?? "ABSOLUTE") as "ABSOLUTE" | "MULTIPLIER")
    .where((eb) => eb.or([eb("effective_to", "is", null), eb("effective_to", ">", rule.effective_from)]));
  if (rule.id) query = query.where("id", "!=", rule.id);
  if (rule.effective_to) query = query.where("effective_from", "<", rule.effective_to);
  if (rule.provider_resource_id) query = query.where((eb) => eb.or([
    eb("provider_resource_id", "is", null), eb("provider_resource_id", "=", rule.provider_resource_id!),
  ]));
  if (rule.upstream_model) query = query.where((eb) => eb.or([
    eb("upstream_model", "is", null), eb("upstream_model", "=", rule.upstream_model!),
  ]));
  return Boolean(await query.executeTakeFirst());
}
