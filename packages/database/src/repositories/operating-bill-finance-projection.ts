import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { OperatingBillSnapshot, OperatingBillSubjectRow } from "./operating-bill-types.js";
import type { ResourceFinanceView } from "./provider-finance-types.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const fixed = (value: Decimal.Value) => new Money(value).toDecimalPlaces(8).toFixed(8);

function group(values: Array<{ currency: string; amount: string }>) {
  const totals = new Map<string, Decimal>();
  for (const value of values) totals.set(value.currency,
    (totals.get(value.currency) ?? new Money(0)).plus(value.amount));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount: fixed(amount) }));
}

function one(values: Array<{ currency: string; amount: string }>): string | null {
  return values.length === 0 ? "0.00000000" : values.length === 1 ? values[0]!.amount : null;
}

export async function projectOperatingBillFinance(
  db: Kysely<Database>, enterpriseId: string, month: string,
  snapshot: OperatingBillSnapshot, views: ResourceFinanceView[],
): Promise<OperatingBillSnapshot> {
  const byResource = new Map(views.map((view) => [view.resourceId, view]));
  // eslint-disable-next-line complexity -- API and Coding Plan project mutually exclusive finance facts.
  const providers = snapshot.providers.map((provider) => {
    const view = byResource.get(provider.providerResourceId);
    if (!view) return provider;
    if (provider.mode === "CODING_PLAN") return { ...provider,
      currency: "CNY", packageCostCurrency: "CNY", packageCost: view.monthlyPlanCashCny,
      totalCost: view.monthlyPlanCashCny, servicePeriodStart: view.currentPeriod?.periodStart ?? null,
      servicePeriodEnd: view.currentPeriod?.periodEndExclusive ?? null };
    const account = view.accounts.length === 1 ? view.accounts[0] : null;
    return { ...provider, currency: account?.currency ?? null,
      openingBalanceCurrency: account?.currency ?? null,
      endingBalanceCurrency: account?.currency ?? null,
      apiSpendCurrency: account?.currency ?? null,
      openingBalance: account?.monthOpeningState === "NORMAL" ? account.monthOpeningBalance : null,
      rechargeAmount: account?.monthlyRecharge ?? null,
      rechargeAmounts: account ? [{ currency: account.currency, amount: account.monthlyRecharge }] : [],
      endingBalance: account?.balanceState === "NORMAL" ? account.balance : null,
      apiCost: account?.monthlyApiCost ?? null, ledgerApiCost: account?.monthlyApiCost ?? null,
      apiSpendStatus: account?.balanceState === "NORMAL" ? "CALCULABLE" : "INCOMPLETE",
      apiSpendReason: account?.balanceState === "NORMAL" ? null
        : account?.balanceState ?? "API_FINANCE_ACCOUNT_NOT_UNIQUE",
      totalCost: account?.monthlyApiCost ?? null };
  });
  const apiSpends = group(providers.filter((p) => p.mode === "API" && p.apiCost !== null && p.apiSpendCurrency)
    .map((p) => ({ currency: p.apiSpendCurrency!, amount: p.apiCost! })));
  const packageCosts = group(providers.filter((p) => p.mode === "CODING_PLAN" && p.packageCost !== null)
    .map((p) => ({ currency: "CNY", amount: p.packageCost! })));
  const totalSpends = group([...apiSpends, ...packageCosts]);
  const rechargeAmounts = group(providers.flatMap((p) => p.mode === "API" ? p.rechargeAmounts : []));
  const openingBalances = group(providers.filter((p) => p.mode === "API" && p.openingBalance !== null && p.openingBalanceCurrency)
    .map((p) => ({ currency: p.openingBalanceCurrency!, amount: p.openingBalance! })));
  const endingBalances = group(providers.filter((p) => p.mode === "API" && p.endingBalance !== null && p.endingBalanceCurrency)
    .map((p) => ({ currency: p.endingBalanceCurrency!, amount: p.endingBalance! })));
  const allocation = await allocatePlanCostsByCalendarMonthTokens(
    db, enterpriseId, month, snapshot.subjects, views,
  );
  const financeResourceIds = new Set(views.map((view) => view.resourceId));
  const gaps = snapshot.gaps.filter((gap) => {
    if (!gap.providerResourceId || !financeResourceIds.has(gap.providerResourceId)) return true;
    return !["OPERATING_SNAPSHOT_MISSING", "API_BALANCE_MISSING", "API_SPEND_NOT_CALCULABLE",
      "NEGATIVE_BALANCE_BRIDGE", "CURRENCY_MISMATCH", "PLAN_FACT_MISSING",
      "UNALLOCATED_PACKAGE_COST"].includes(gap.code);
  });
  return { ...snapshot, providers, subjects: allocation.subjects, gaps,
    sourceFacts: { ...snapshot.sourceFacts, providerFinance: { resourceViews: views } },
    summary: { ...snapshot.summary,
    apiCost: one(apiSpends), ledgerApiCost: one(apiSpends), packageCost: one(packageCosts),
    totalCost: one(totalSpends), monthlyRecharge: one(rechargeAmounts),
    openingBalance: one(openingBalances), endingBalance: one(endingBalances),
    endingBalanceCurrency: endingBalances.length === 1 ? endingBalances[0]!.currency : null,
    openingBalances, rechargeAmounts, endingBalances, apiSpends, packageCosts, totalSpends,
    unallocatedCost: allocation.unallocatedCost } };
}

async function allocatePlanCostsByCalendarMonthTokens(
  db: Kysely<Database>, enterpriseId: string, month: string,
  source: OperatingBillSubjectRow[], views: ResourceFinanceView[],
): Promise<{ subjects: OperatingBillSubjectRow[]; unallocatedCost: string }> {
  const { start, end } = operatingBillMonthRange(month);
  const [result, legacyResult] = await Promise.all([sql<{ subject_id: string; subject_type: "EMPLOYEE" | "PROJECT";
    provider_resource_id: string; tokens: string }>`
    SELECT line.principal_id::text AS subject_id, 'EMPLOYEE'::text AS subject_type,
           line.provider_resource_id, SUM(line.raw_input_tokens+line.raw_output_tokens)::text AS tokens
      FROM ledger_line line WHERE line.enterprise_id=${enterpriseId}::uuid
       AND line.resource_mode='CODING_PLAN' AND line.settled_at>=${start} AND line.settled_at<${end}
     GROUP BY line.principal_id,line.provider_resource_id
    UNION ALL
    SELECT COALESCE(project.id::text,'__unassigned_project__'), 'PROJECT',
           line.provider_resource_id, SUM(line.raw_input_tokens+line.raw_output_tokens)::text
      FROM ledger_line line
      LEFT JOIN operating_bill_request_project_assignment assignment
        ON assignment.enterprise_id=line.enterprise_id AND assignment.ai_request_id=line.ai_request_id
      LEFT JOIN principal project ON project.enterprise_id=line.enterprise_id
       AND project.id=assignment.project_principal_id AND project.type='PROJECT'
     WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='CODING_PLAN'
       AND line.settled_at>=${start} AND line.settled_at<${end}
     GROUP BY project.id,line.provider_resource_id`.execute(db),
  sql<{ amount: string }>`SELECT COALESCE(SUM(-account_amount),0)::text AS amount
    FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
     AND event_type='API_LEGACY_COST_ADJUSTMENT'
     AND occurred_at>=${start} AND occurred_at<${end}`.execute(db)]);
  const allocations = new Map<string, Decimal>();
  let unallocated = new Money(0);
  for (const view of views.filter((item) => item.mode === "CODING_PLAN"
    && new Money(item.monthlyPlanCashCny).gt(0))) {
    for (const kind of ["EMPLOYEE", "PROJECT"] as const) {
      const rows = result.rows.filter((row) => row.provider_resource_id === view.resourceId
        && row.subject_type === kind && new Money(row.tokens).gt(0));
      const total = rows.reduce((sum, row) => sum.plus(row.tokens), new Money(0));
      if (total.isZero()) {
        if (kind === "EMPLOYEE") unallocated = unallocated.plus(view.monthlyPlanCashCny);
        continue;
      }
      const totalUnits = new Money(view.monthlyPlanCashCny).mul(100_000_000)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      const parts = rows.map((row) => {
        const exact = totalUnits.mul(row.tokens).div(total);
        const base = exact.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
        return { row, base, fraction: exact.minus(base) };
      });
      let remainder = totalUnits.minus(parts.reduce((sum, part) => sum.plus(part.base), new Money(0)))
        .toNumber();
      parts.sort((left, right) => right.fraction.cmp(left.fraction)
        || left.row.subject_id.localeCompare(right.row.subject_id));
      for (const part of parts) {
        const units = part.base.plus(remainder > 0 ? 1 : 0);
        remainder -= remainder > 0 ? 1 : 0;
        allocations.set(`${kind}:${part.row.subject_id}`,
          (allocations.get(`${kind}:${part.row.subject_id}`) ?? new Money(0))
            .plus(units.div(100_000_000)));
      }
    }
  }
  const subjects = source.map((subject) => {
    const plan = allocations.get(`${subject.principalType}:${subject.principalId}`) ?? new Money(0);
    const total = subject.apiCost === null ? null : fixed(new Money(subject.apiCost).plus(plan));
    return { ...subject, packageAllocatedCost: fixed(plan), totalAllocatedCost: total };
  });
  const legacyCost = new Money(legacyResult.rows[0]?.amount ?? 0);
  if (!legacyCost.isZero()) {
    const index = subjects.findIndex((subject) => subject.principalType === "PROJECT"
      && subject.principalId === "__unassigned_project__");
    const prior = index >= 0 ? subjects[index]! : {
      principalId: "__unassigned_project__", principalName: "未归属历史 API 成本",
      principalType: "PROJECT" as const, providers: [], inputTokens: "0", outputTokens: "0",
      cacheTokens: "0", reasoningTokens: "0", totalTokens: "0", deductedQuota: "0",
      apiCost: "0.00000000", packageAllocatedCost: "0.00000000",
      totalAllocatedCost: "0.00000000", activeDays: 0, requestCount: 0,
    };
    const api = new Money(prior.apiCost ?? 0).plus(legacyCost);
    const updated = { ...prior, apiCost: fixed(api),
      totalAllocatedCost: fixed(api.plus(prior.packageAllocatedCost)) };
    if (index >= 0) subjects[index] = updated; else subjects.push(updated);
  }
  return { subjects, unallocatedCost: fixed(unallocated) };
}
