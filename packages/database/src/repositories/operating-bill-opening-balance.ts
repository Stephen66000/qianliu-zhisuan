import { Decimal } from "decimal.js";
import type { Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { loadMonthlyOperatingCosts } from "./monthly-operating-cost.js";
import {
  OperatingBillFutureOpeningBalanceError,
  OperatingBillOpeningBalanceAlreadyAvailableError,
  OperatingBillOpeningBalanceCurrencyMismatchError,
  OperatingBillReferenceError,
} from "./operating-bill-errors.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { ensureOperatingBillPeriod } from "./operating-bill-period.js";
import { OperatingBillClosedError } from "./operating-bill-write-barrier.js";
import type { OperatingBillView } from "./operating-bill-types.js";

export interface RecordOpeningBalanceInput {
  enterpriseId: string;
  adminId: string;
  month: string;
  providerResourceId: string;
  amount: string;
  currency: string;
  reason: string | null;
}

export async function recordOperatingBillOpeningBalance(
  db: Kysely<Database>,
  input: RecordOpeningBalanceInput,
  loadBill: () => Promise<OperatingBillView>,
): Promise<{ bill: OperatingBillView; created: boolean }> {
  const range = operatingBillMonthRange(input.month);
  const currentMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
  if (range.start > operatingBillMonthRange(currentMonth).start) {
    throw new OperatingBillFutureOpeningBalanceError();
  }
  const created = await db.transaction().execute(async (trx) => {
    const initial = await ensureOperatingBillPeriod(
      trx, input.enterpriseId, input.adminId, input.month,
    );
    const period = await trx.selectFrom("operating_bill_period").selectAll()
      .where("enterprise_id", "=", input.enterpriseId).where("id", "=", initial.id)
      .forUpdate().executeTakeFirstOrThrow();
    if (period.status === "CLOSED") throw new OperatingBillClosedError();
    const resource = await trx.selectFrom("provider_resource").select(["id", "mode"])
      .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.providerResourceId)
      .where("status", "<>", "DELETED").forUpdate().executeTakeFirst();
    if (!resource || resource.mode !== "API") throw new OperatingBillReferenceError();
    const endingSnapshot = await trx.selectFrom("provider_resource_operating_snapshot")
      .select("currency").where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", resource.id).where("collected_at", "<", range.end)
      .where("current_balance", "is not", null)
      .orderBy("collected_at", "desc").orderBy("version", "desc").executeTakeFirst();
    if (endingSnapshot?.currency && endingSnapshot.currency !== input.currency) {
      throw new OperatingBillOpeningBalanceCurrencyMismatchError();
    }
    const latest = await trx.selectFrom("operating_bill_opening_balance")
      .select(["version", "amount", "currency", "reason"])
      .where("enterprise_id", "=", input.enterpriseId).where("period_id", "=", period.id)
      .where("provider_resource_id", "=", resource.id)
      .orderBy("version", "desc").executeTakeFirst();
    const existing = (await loadMonthlyOperatingCosts(
      trx, input.enterpriseId, range.start, range.end,
    )).resources.find((row) => row.resourceId === resource.id);
    if (existing?.openingBalance !== null && existing?.openingBalance !== undefined
      && existing.openingBalanceSource !== "MANUAL") {
      throw new OperatingBillOpeningBalanceAlreadyAvailableError();
    }
    if (latest && new Decimal(latest.amount).equals(input.amount)
      && latest.currency === input.currency && latest.reason === input.reason) return false;
    await trx.insertInto("operating_bill_opening_balance").values({
      enterprise_id: input.enterpriseId, period_id: period.id,
      provider_resource_id: resource.id, version: (latest?.version ?? 0) + 1,
      amount: input.amount, currency: input.currency, source: "MANUAL",
      reason: input.reason, created_by: input.adminId,
    }).execute();
    await trx.insertInto("operation_log").values({ actor_source: "ADMIN",
      enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
      action: "operating_bill.opening_balance.create", target_type: "provider_resource",
      target_id: resource.id,
      change_summary: {
        month: input.month, amount: input.amount, currency: input.currency, reason: input.reason,
      },
      result: "SUCCESS", failure_reason: null,
    }).execute();
    await trx.updateTable("operating_bill_period").set({ updated_at: new Date() })
      .where("id", "=", period.id).execute();
    return true;
  });
  return { bill: await loadBill(), created };
}
