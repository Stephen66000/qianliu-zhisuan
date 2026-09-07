import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { Money, money } from "./provider-finance-core.js";
import {
  PROVIDER_FINANCE_CUTOVER,
  type FinanceBalanceView,
  type FinanceCurrency,
} from "./provider-finance-types.js";

/** A month's opening excludes that month's first recharge/debit, including midnight events. */
export async function loadFinanceMonthOpening(
  trx: Transaction<Database>,
  enterpriseId: string,
  resourceId: string,
  currency: FinanceCurrency,
  start: Date,
  balanceAt: (asOf: Date) => Promise<FinanceBalanceView | null>,
): Promise<Pick<FinanceBalanceView, "state" | "balance"> | null> {
  if (start.getTime() !== PROVIDER_FINANCE_CUTOVER.getTime())
    return balanceAt(new Date(start.getTime() - 1));
  const result = await sql<{
    count: string;
    amount: string;
  }>`SELECT COUNT(*) FILTER(WHERE event_type='API_OPENING_BALANCE')::text AS count,
    COALESCE(SUM(account_amount),0)::text AS amount FROM provider_finance_event
    WHERE enterprise_id=${enterpriseId}::uuid AND provider_resource_id=${resourceId}::uuid AND account_currency=${currency}
      AND occurred_at<=${start} AND event_type IN ('API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION')`.execute(
    trx,
  );
  const opening = result.rows[0]!;
  if (Number(opening.count) === 0)
    return { state: "MISSING_OPENING_BALANCE", balance: null };
  if (new Money(opening.amount).lt(0))
    return { state: "NEGATIVE_RECONCILIATION_REQUIRED", balance: null };
  return { state: "NORMAL", balance: money(opening.amount) };
}
