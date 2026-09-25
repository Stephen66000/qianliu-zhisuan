import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { PROVIDER_FINANCE_CUTOVER, ProviderFinanceError, type FinanceCurrency, type FinanceEventType, type FinanceEventView } from "./provider-finance-types.js";

/**
 * 金额标度与余额公式的唯一定义在领域层
 * （`@qianliu/domain` 的 provider-finance-balance-components）。
 * 此处仅再导出，保持既有调用点不变；禁止在本层另建第二套金额/冲销语义。
 */
import { Money, money } from "@qianliu/domain";

export { Money, money };

export function stableHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(normalize);
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function validateOrdinaryOccurredAt(value: Date): void {
  if (value < PROVIDER_FINANCE_CUTOVER) {
    throw new ProviderFinanceError("INVALID_REQUEST", "业务时间不得早于新账本切换时点");
  }
  if (value.getTime() > Date.now()) {
    throw new ProviderFinanceError("INVALID_REQUEST", "业务时间不能晚于当前时间");
  }
}

export function eventView(row: {
  id: string; provider_resource_id: string; event_type: string; account_amount: string;
  account_currency: string; cash_paid_cny: string | null; occurred_at: Date;
  external_reference: string | null; reversal_of_event_id: string | null;
  correction_of_event_id: string | null; reconciliation_case_id: string | null;
  legacy_cost_resolution_id: string | null; description: string | null; evidence_ref: string | null;
  source: string; created_at: Date;
}): FinanceEventView {
  return {
    id: row.id, providerResourceId: row.provider_resource_id,
    eventType: row.event_type as FinanceEventType, accountAmount: row.account_amount,
    accountCurrency: row.account_currency as FinanceCurrency, cashPaidCny: row.cash_paid_cny,
    occurredAt: row.occurred_at.toISOString(), externalReference: row.external_reference,
    reversalOfEventId: row.reversal_of_event_id, correctionOfEventId: row.correction_of_event_id,
    reconciliationCaseId: row.reconciliation_case_id,
    legacyCostResolutionId: row.legacy_cost_resolution_id, description: row.description,
    evidenceRef: row.evidence_ref, source: row.source, createdAt: row.created_at.toISOString(),
    replayed: false,
  };
}

export async function lockResource(
  trx: Transaction<Database>, enterpriseId: string, resourceId: string,
) {
  const resource = await trx.selectFrom("provider_resource")
    // created_at：F-P2-6 期初生效时点下界（不得早于资源创建）校验所需。
    .select(["id", "mode", "created_at"]).where("enterprise_id", "=", enterpriseId)
    .where("id", "=", resourceId).where("status", "<>", "DELETED")
    .forUpdate().executeTakeFirst();
  if (!resource) throw new ProviderFinanceError("NOT_FOUND", "厂商资源不存在");
  return resource;
}
