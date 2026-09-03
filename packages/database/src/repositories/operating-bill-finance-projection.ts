import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { OperatingBillSnapshot, OperatingBillSubjectRow } from "./operating-bill-types.js";
import type { ResourceFinanceView } from "./provider-finance-types.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const fixed = (value: Decimal.Value) => new Money(value).toDecimalPlaces(8).toFixed(8);
const shanghaiDate = (value: string) => {
  const shifted = new Date(new Date(value).getTime() + 8 * 3600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
};

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
      totalCost: view.monthlyPlanCashCny,
      servicePeriodStart: view.currentPeriod ? shanghaiDate(view.currentPeriod.periodStart) : null,
      servicePeriodEnd: view.currentPeriod ? shanghaiDate(view.currentPeriod.periodEndExclusive) : null };
    const account = view.accounts.length === 1 ? view.accounts[0] : null;
    return { ...provider, currency: account?.currency ?? null,
      openingBalanceCurrency: account?.currency ?? null,
      endingBalanceCurrency: account?.currency ?? null,
      apiSpendCurrency: account?.currency ?? null,
      openingBalance: account?.monthOpeningState === "NORMAL" ? account.monthOpeningBalance : null,
      rechargeAmount: account?.monthlyRecharge ?? null,
      rechargeAmounts: view.accounts.map((item) => ({
        currency: item.currency, amount: item.monthlyRecharge,
      })),
      endingBalance: account?.balanceState === "NORMAL" ? account.balance : null,
      apiCost: account?.balanceState === "INCOMPLETE_USAGE_COST" ? null
        : account?.monthlyApiCost ?? null,
      ledgerApiCost: account?.balanceState === "INCOMPLETE_USAGE_COST" ? null
        : account?.monthlyApiCost ?? null,
      apiSpendStatus: account?.balanceState === "NORMAL" ? "CALCULABLE" : "INCOMPLETE",
      apiSpendReason: account?.balanceState === "NORMAL" ? null
        : account?.balanceState ?? "API_FINANCE_ACCOUNT_NOT_UNIQUE",
      totalCost: account?.balanceState === "INCOMPLETE_USAGE_COST" ? null
        : account?.monthlyApiCost ?? null };
  });
  const apiViews = views.filter((view) => view.mode === "API");
  const apiSpends = group(apiViews.flatMap((view) => view.accounts
    .filter((account) => account.balanceState !== "INCOMPLETE_USAGE_COST"
      && !new Money(account.monthlyApiCost).isZero())
    .map((account) => ({ currency: account.currency, amount: account.monthlyApiCost }))));
  const packageCosts = group(providers.filter((p) => p.mode === "CODING_PLAN" && p.packageCost !== null)
    .filter((p) => !new Money(p.packageCost!).isZero())
    .map((p) => ({ currency: "CNY", amount: p.packageCost! })));
  const totalSpends = group([...apiSpends, ...packageCosts]);
  const rechargeAmounts = group(apiViews.flatMap((view) => view.accounts
    .filter((account) => !new Money(account.monthlyRecharge).isZero())
    .map((account) => ({ currency: account.currency, amount: account.monthlyRecharge }))));
  const openingBalances = group(apiViews.flatMap((view) => view.accounts
    .filter((account) => account.monthOpeningState === "NORMAL" && account.monthOpeningBalance !== null)
    .map((account) => ({ currency: account.currency, amount: account.monthOpeningBalance! }))));
  const endingBalances = group(apiViews.flatMap((view) => view.accounts
    .filter((account) => account.balanceState === "NORMAL" && account.balance !== null)
    .map((account) => ({ currency: account.currency, amount: account.balance! }))));
  const allocation = await allocatePlanCostsByCalendarMonthTokens(
    db, enterpriseId, month, snapshot.subjects, views,
  );
  const financeResourceIds = new Set(views.map((view) => view.resourceId));
  const retainedGaps = snapshot.gaps.filter((gap) => {
    if (!gap.providerResourceId || !financeResourceIds.has(gap.providerResourceId)) return true;
    const view = byResource.get(gap.providerResourceId);
    if (view?.mode === "API" && view.accounts.length === 0) return true;
    return !["OPERATING_SNAPSHOT_MISSING", "API_BALANCE_MISSING",
      "API_BALANCE_BRIDGE_MISSING", "API_OPENING_BALANCE_MISSING",
      "API_ENDING_BALANCE_MISSING", "API_CURRENCY_MISMATCH",
      "API_NEGATIVE_BALANCE_BRIDGE", "API_SPEND_NOT_CALCULABLE", "API_COST_UNKNOWN",
      "PLAN_FACT_MISSING", "UNALLOCATED_PACKAGE_COST"].includes(gap.code);
  });
  const stateCode = {
    MISSING_OPENING_BALANCE: "API_OPENING_BALANCE_MISSING",
    INCOMPLETE_USAGE_COST: "API_COST_UNKNOWN",
    NEGATIVE_RECONCILIATION_REQUIRED: "API_NEGATIVE_RECONCILIATION_REQUIRED",
    LEGACY_ARCHIVED: "API_LEGACY_ARCHIVED",
  } as const;
  const financeGaps = apiViews.flatMap((view) => view.accounts.flatMap((account) =>
    account.balanceState === "NORMAL" ? [] : [{
      code: stateCode[account.balanceState],
      message: `${view.resourceId} 的 ${account.currency} 资金账户状态为 ${account.balanceState}`,
      providerResourceId: view.resourceId,
      field: account.balanceState === "INCOMPLETE_USAGE_COST" ? "ledger_line.api_cost" : "balance",
    }]));
  const seenGaps = new Set<string>();
  const gaps = [...retainedGaps, ...financeGaps].filter((gap) => {
    const key = `${gap.code}:${gap.providerResourceId ?? ""}:${gap.field ?? ""}`;
    if (seenGaps.has(key)) return false;
    seenGaps.add(key); return true;
  });
  const apiIncomplete = financeGaps.length > 0;
  return { ...snapshot, providers, subjects: allocation.subjects, gaps,
    sourceFacts: { ...snapshot.sourceFacts, providerFinance: { resourceViews: views } },
    summary: { ...snapshot.summary,
    apiCost: one(apiSpends), ledgerApiCost: one(apiSpends), packageCost: one(packageCosts),
    apiSpendStatus: apiIncomplete ? "INCOMPLETE" : "CALCULABLE",
    apiSpendReason: apiIncomplete ? financeGaps.map((gap) => gap.code).join("、") : null,
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
  const [result, legacyResult] = await Promise.all([sql<{ subject_id: string; subject_name: string;
    subject_type: "EMPLOYEE" | "PROJECT"; provider_resource_id: string; provider_name: string;
    input_tokens: string; output_tokens: string; cache_tokens: string; reasoning_tokens: string;
    tokens: string; active_dates: string[]; request_ids: string[] }>`
    SELECT COALESCE(project.id, source.id)::text AS subject_id,
           COALESCE(project.name, source.name) AS subject_name,
           CASE WHEN project.id IS NOT NULL OR source.type='PROJECT'
             THEN 'PROJECT' ELSE 'EMPLOYEE' END::text AS subject_type,
           line.provider_resource_id, provider.name AS provider_name,
           SUM(line.raw_input_tokens)::text AS input_tokens,
           SUM(line.raw_output_tokens)::text AS output_tokens,
           SUM(line.raw_cache_tokens)::text AS cache_tokens,
           SUM(line.raw_reasoning_tokens)::text AS reasoning_tokens,
           SUM(line.raw_input_tokens+line.raw_output_tokens)::text AS tokens,
           ARRAY_AGG(DISTINCT to_char(line.settled_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')) AS active_dates,
           ARRAY_AGG(DISTINCT line.ai_request_id::text) AS request_ids
      FROM ledger_line line
      JOIN principal source ON source.enterprise_id=line.enterprise_id
       AND source.id=line.principal_id
      JOIN provider_resource resource ON resource.enterprise_id=line.enterprise_id
       AND resource.id=line.provider_resource_id
      JOIN provider ON provider.enterprise_id=resource.enterprise_id
       AND provider.id=resource.provider_id
      LEFT JOIN operating_bill_request_project_assignment assignment
        ON assignment.enterprise_id=line.enterprise_id AND assignment.ai_request_id=line.ai_request_id
      LEFT JOIN principal project ON project.enterprise_id=line.enterprise_id
       AND project.id=assignment.project_principal_id AND project.type='PROJECT'
     WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='CODING_PLAN'
       AND line.settled_at>=${start} AND line.settled_at<${end}
     GROUP BY COALESCE(project.id, source.id), COALESCE(project.name, source.name),
       CASE WHEN project.id IS NOT NULL OR source.type='PROJECT' THEN 'PROJECT' ELSE 'EMPLOYEE' END,
       line.provider_resource_id, provider.name`.execute(db),
  sql<{ amount: string }>`SELECT COALESCE(SUM(-account_amount),0)::text AS amount
    FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
     AND event_type='API_LEGACY_COST_ADJUSTMENT'
     AND occurred_at>=${start} AND occurred_at<${end}`.execute(db)]);
  const allocations = new Map<string, Decimal>();
  let unallocated = new Money(0);
  let allocated = new Money(0);
  let planCost = new Money(0);
  for (const view of views.filter((item) => item.mode === "CODING_PLAN"
    && new Money(item.monthlyPlanCashCny).gt(0))) {
    planCost = planCost.plus(view.monthlyPlanCashCny);
    const rows = result.rows.filter((row) => row.provider_resource_id === view.resourceId
      && new Money(row.tokens).gt(0));
    const total = rows.reduce((sum, row) => sum.plus(row.tokens), new Money(0));
    if (total.isZero()) {
      unallocated = unallocated.plus(view.monthlyPlanCashCny);
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
        const key = `${part.row.subject_type}:${part.row.subject_id}`;
        const amount = units.div(100_000_000);
        allocations.set(key,
          (allocations.get(key) ?? new Money(0))
            .plus(amount));
        allocated = allocated.plus(amount);
      }
  }
  if (!allocated.plus(unallocated).eq(planCost)) {
    throw new Error("Coding Plan 月费分摊不守恒");
  }
  const subjects = source.map((subject) => {
    const plan = allocations.get(`${subject.principalType}:${subject.principalId}`) ?? new Money(0);
    const total = subject.apiCost === null ? null : fixed(new Money(subject.apiCost).plus(plan));
    return { ...subject, packageAllocatedCost: fixed(plan), totalAllocatedCost: total };
  });
  const subjectKeys = new Set(subjects.map((subject) => `${subject.principalType}:${subject.principalId}`));
  const missing = new Map<string, typeof result.rows[number][]>();
  for (const row of result.rows) {
    const key = `${row.subject_type}:${row.subject_id}`;
    if (subjectKeys.has(key)) continue;
    const rows = missing.get(key) ?? []; rows.push(row); missing.set(key, rows);
  }
  for (const [key, rows] of missing) {
    const first = rows[0]!;
    const sum = (field: "input_tokens" | "output_tokens" | "cache_tokens" | "reasoning_tokens") =>
      rows.reduce((total, row) => total.plus(row[field]), new Money(0)).toFixed(0);
    const input = sum("input_tokens"); const output = sum("output_tokens");
    const plan = allocations.get(key) ?? new Money(0);
    subjects.push({ principalId: first.subject_id, principalName: first.subject_name,
      principalType: first.subject_type, providers: [...new Set(rows.map((row) => row.provider_name))].sort(),
      inputTokens: input, outputTokens: output, cacheTokens: sum("cache_tokens"),
      reasoningTokens: sum("reasoning_tokens"), totalTokens: new Money(input).plus(output).toFixed(0),
      deductedQuota: "0", apiCost: "0.00000000", packageAllocatedCost: fixed(plan),
      totalAllocatedCost: fixed(plan),
      activeDays: new Set(rows.flatMap((row) => row.active_dates)).size,
      requestCount: new Set(rows.flatMap((row) => row.request_ids)).size });
  }
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
