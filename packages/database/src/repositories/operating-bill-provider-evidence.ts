import { createHash } from "node:crypto";
import type { Decimal } from "decimal.js";
import type { OperatingBillProviderRow } from "./operating-bill-types.js";
import { nullableAmount } from "./operating-bill-cost-quality.js";

interface EvidenceResourceRow {
  resource_id: string;
  snapshot_id: string | null;
  snapshot_version: number | null;
  snapshot_source: string | null;
  current_balance: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  budget_id: string | null;
  budget_version: number | null;
  budget_status: "ACTIVE" | "CLEARED" | null;
  budget_amount: string | null;
  budget_currency: string | null;
}

interface EvidencePurchaseRow {
  id: string;
  purchase_type: "API_RECHARGE" | "PACKAGE_PURCHASE";
  amount: string;
  currency: string;
  purchased_at: Date;
  service_period_start: string | null;
  service_period_end: string | null;
  source: string;
}

interface EvidenceRangeRow {
  first_at: Date | null;
  last_at: Date | null;
  request_count: string;
}

interface EvidenceConfirmationRow {
  status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY";
  fact_fingerprint: string;
  note: string | null;
  confirmed_at: Date;
  confirmed_by_name: string;
  version: number;
}

export function providerFactEvidence(input: {
  row: EvidenceResourceRow;
  resourceApiCost: Decimal | null;
  ledgerApiCost: Decimal | null;
  resourcePackageCost: Decimal;
  purchases: EvidencePurchaseRow[];
  range?: EvidenceRangeRow;
  confirmed?: EvidenceConfirmationRow;
}): Pick<OperatingBillProviderRow,
  "purchases" | "servicePeriodStart" | "servicePeriodEnd" | "operatingSnapshotSource" |
  "requestRange" | "factFingerprint" | "confirmation"> {
  const purchases = input.purchases.map((item) => ({
    id: item.id, type: item.purchase_type, amount: item.amount, currency: item.currency,
    purchasedAt: item.purchased_at.toISOString(), servicePeriodStart: item.service_period_start,
    servicePeriodEnd: item.service_period_end, source: item.source,
  }));
  const requestRange = {
    from: input.range?.first_at?.toISOString() ?? null,
    to: input.range?.last_at?.toISOString() ?? null,
    count: Number(input.range?.request_count ?? 0),
  };
  const factFingerprint = createHash("sha256").update(JSON.stringify({
    resourceId: input.row.resource_id,
    snapshotId: input.row.snapshot_id,
    snapshotVersion: input.row.snapshot_version,
    apiCost: nullableAmount(input.resourceApiCost),
    ledgerApiCost: nullableAmount(input.ledgerApiCost),
    packageCost: input.resourcePackageCost.toDecimalPlaces(8).toFixed(8),
    endingBalance: input.row.current_balance,
    monthlyBudgetId: input.row.budget_id,
    monthlyBudgetVersion: input.row.budget_version,
    monthlyBudgetStatus: input.row.budget_status,
    monthlyBudgetAmount: input.row.budget_amount,
    monthlyBudgetCurrency: input.row.budget_currency,
    purchases,
    requestRange: [requestRange.from, requestRange.to, requestRange.count],
  })).digest("hex");
  const matchesCurrentFacts = input.confirmed?.fact_fingerprint === factFingerprint;
  return {
    operatingSnapshotSource: input.row.snapshot_source,
    servicePeriodStart: input.row.effective_from?.toISOString() ?? null,
    servicePeriodEnd: input.row.effective_until?.toISOString() ?? null,
    purchases,
    requestRange,
    factFingerprint,
    confirmation: {
      status: input.confirmed && matchesCurrentFacts ? input.confirmed.status : "PENDING",
      note: input.confirmed?.note ?? null,
      confirmedBy: input.confirmed?.confirmed_by_name ?? null,
      confirmedAt: input.confirmed?.confirmed_at.toISOString() ?? null,
      version: input.confirmed?.version ?? 0,
      matchesCurrentFacts,
    },
  };
}
