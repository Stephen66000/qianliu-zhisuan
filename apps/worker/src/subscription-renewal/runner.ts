import type { Kysely } from "kysely";
import { runSubscriptionAutoRenewals, type Database } from "@qianliu/database";
import { readProviderFinanceMode } from "@qianliu/config";

export async function runSubscriptionRenewalTick(input: { db: Kysely<Database>; now?: Date; env?: NodeJS.ProcessEnv }) {
  if (readProviderFinanceMode(input.env ?? process.env) !== "ACTIVE") {
    return { scanned: 0, created: 0, failures: [], skipped: "FINANCE_MODE_INACTIVE" };
  }
  return runSubscriptionAutoRenewals(input.db, input.now ?? new Date());
}
