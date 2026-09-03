import type { Transaction } from "kysely";

import type { Database } from "../kysely.js";
import type { LedgerLineInput } from "./gateway-ledger-types.js";
import { GatewayLedgerSettlementConflictError } from "./gateway-ledger-settlement-assertions.js";

/** 结算时冻结开始日最新的有效周期；没有可用周期时保留空值并交给缺口投影。 */
export async function resolveSubscriptionPeriodAtSettlement(
  trx: Transaction<Database>,
  input: Pick<LedgerLineInput,
    "enterprise_id" | "provider_resource_id" | "resource_mode" | "subscription_period_id">,
  settledAt: Date,
): Promise<string | null> {
  if (input.resource_mode === "API") {
    if (input.subscription_period_id) {
      throw new GatewayLedgerSettlementConflictError("api_subscription_period_conflict");
    }
    return null;
  }
  if (input.resource_mode !== "CODING_PLAN") {
    throw new GatewayLedgerSettlementConflictError("settlement_resource_mode_conflict");
  }
  let query = trx.selectFrom("provider_subscription_period").select("id")
    .where("enterprise_id", "=", input.enterprise_id)
    .where("provider_resource_id", "=", input.provider_resource_id)
    .where("reversed_by_event_id", "is", null)
    .where("period_start", "<=", settledAt)
    .where("period_end_exclusive", ">", settledAt);
  if (input.subscription_period_id) query = query.where("id", "=", input.subscription_period_id);
  const period = await query.orderBy("period_start", "desc")
    .orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst();
  if (input.subscription_period_id && !period) {
    throw new GatewayLedgerSettlementConflictError("subscription_period_conflict");
  }
  return period?.id ?? null;
}
