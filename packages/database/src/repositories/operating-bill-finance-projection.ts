import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { OperatingBillSnapshot, OperatingBillSubjectRow } from "./operating-bill-types.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
import { loadApiCostGaps } from "./provider-finance-api-cost-gaps.js";
import { balanceQualityGaps, monthlyExpenseGaps } from "./operating-bill-finance-quality.js";
import { loadApiCostEstimation } from "./api-cost-estimation.js";
import { apiEstimationGapText } from "./dashboard-monthly-spend.js";
import { estimatedApiCostFields } from "./operating-bill-monthly-cost.js";
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
  const { start, end } = operatingBillMonthRange(month);
  const [monthlyFacts, historicalFacts] = await Promise.all([
    loadApiCostGaps(db, enterpriseId, start, end),
    loadApiCostGaps(db, enterpriseId, PROVIDER_FINANCE_CUTOVER, start),
  ]);
  const names = new Map(snapshot.providers.map((provider) => [provider.providerResourceId, provider.resourceName]));
  const financeGaps = balanceQualityGaps(views, historicalFacts, names);
  const archivedExpenseGaps = views.filter((view) => view.mode === "API"
    && (end <= PROVIDER_FINANCE_CUTOVER || view.accounts.some((account) => account.balanceState === "LEGACY_ARCHIVED")))
    .map((view) => ({ code: "API_LEGACY_ARCHIVED", providerResourceId: view.resourceId,
      field: "ledger_line.api_cost",
      message: `${names.get(view.resourceId) ?? view.resourceId} 本期属于资金切账前历史区间，费用不能由切账后账户的零金额推定` }));
  // WP2-S5（WP1 合同 §4 裁定 2 后端部分 / ACE-03/04/06/07）：finance 开路径的 API 金额
  // 权威切同源估算——与 draft 主路径（operating-bill-draft.ts S3b）同源同语义：按资源
  // 逐个调用（providers 行需资源级金额字面值）＋全企业一次调用（summary，资源范围互斥
  // 切分故恒等）。资金域桥接口径（missingAccountGaps / API_FINANCE_ACCOUNT_NOT_UNIQUE /
  // 资金账户 monthlyApiCost 覆盖）随裁定 2 退役；bridge 字段（opening/recharge/ending、
  // provisionalEndingBalances）、CP 套餐投影、allocatePlanCostsByCalendarMonthTokens
  // （含 API_LEGACY_COST_ADJUSTMENT 未归属行）与 archivedExpenseGaps 原样保留（WP4 处置）。
  const apiResourceIds = snapshot.providers.filter((provider) => provider.mode === "API")
    .map((provider) => provider.providerResourceId);
  const [estimationPairs, enterpriseEstimation] = await Promise.all([
    Promise.all(apiResourceIds.map(async (resourceId) => [
      resourceId,
      await loadApiCostEstimation(db, enterpriseId, { start, end, resourceIds: [resourceId] }),
    ] as const)),
    loadApiCostEstimation(db, enterpriseId, { start, end }),
  ]);
  const estimationByResource = new Map(estimationPairs);
  const estimatedSummary = estimatedApiCostFields(enterpriseEstimation);
  const expenseGaps = [...monthlyExpenseGaps(monthlyFacts, names), ...archivedExpenseGaps];
  const providers = snapshot.providers.map((provider) => {
    const view = byResource.get(provider.providerResourceId);
    if (!view) return provider;
    if (provider.mode === "CODING_PLAN") return { ...provider,
      currency: "CNY", packageCostCurrency: "CNY", packageCost: view.monthlyPlanCashCny,
      totalCost: view.monthlyPlanCashCny,
      servicePeriodStart: view.currentPeriod ? shanghaiDate(view.currentPeriod.periodStart) : null,
      servicePeriodEnd: view.currentPeriod ? shanghaiDate(view.currentPeriod.periodEndExclusive) : null };
    const estimation = estimationByResource.get(view.resourceId) ?? null;
    const fields = estimatedApiCostFields(estimation);
    const account = view.accounts.length === 1 ? view.accounts[0] : null;
    // apiSpendStatus/Reason 切估算完整性口径（WP2-S5 B）：KNOWN_PARTIAL → INCOMPLETE＋
    // 估算缺口码（apiEstimationGapText，PRICE_BASIS_UNVERIFIED 为信息项不参与）；
    // 否则（含 ZERO_CONFIRMED/无行）CALCULABLE。不再使用资金域桥接口径。
    const estimationIncomplete = estimation?.completeness === "KNOWN_PARTIAL";
    return { ...provider, currency: account?.currency ?? null,
      openingBalanceCurrency: account?.currency ?? null,
      endingBalanceCurrency: account?.currency ?? null,
      apiSpendCurrency: fields.apiSpends.length === 1 ? fields.apiSpends[0]!.currency : null,
      openingBalance: account?.monthOpeningState === "NORMAL" ? account.monthOpeningBalance : null,
      rechargeAmount: account?.monthlyRecharge ?? null,
      rechargeAmounts: view.accounts.map((item) => ({
        currency: item.currency, amount: item.monthlyRecharge,
      })),
      endingBalance: account?.balanceState === "NORMAL" ? account.balance : null,
      apiCost: fields.apiCost,
      ledgerApiCost: fields.apiCost,
      apiSpendStatus: estimationIncomplete ? "INCOMPLETE" : "CALCULABLE",
      apiSpendReason: estimationIncomplete ? apiEstimationGapText(estimation!.gaps) : null,
      totalCost: fields.apiCost };
  });
  // 金额段（apiSpends/totalSpends）＝估算 apiSpends（已知部分按币种）＋CP packageCosts
  // 分组；totalCost 仅在估算完整（非 KNOWN_PARTIAL）时产出 scalar，不把缺失冒充已知 0、
  // 也不在估算不完整时把纯套餐合计伪装成总费用（ACE-04/07）。
  const apiSpends = estimatedSummary.apiSpends;
  const packageCosts = group(providers.filter((p) => p.mode === "CODING_PLAN" && p.packageCost !== null)
    .filter((p) => !new Money(p.packageCost!).isZero())
    .map((p) => ({ currency: "CNY", amount: p.packageCost! })));
  const totalSpends = group([...apiSpends, ...packageCosts]);
  const rechargeAmounts = group(apiViews(views).flatMap((view) => view.accounts
    .filter((account) => !new Money(account.monthlyRecharge).isZero()
      || account.hasMonthlyApiCostFacts === true
      || (account.balanceState !== "MISSING_OPENING_BALANCE" && account.balanceState !== "LEGACY_ARCHIVED"))
    .map((account) => ({ currency: account.currency, amount: account.monthlyRecharge }))));
  const openingBalances = group(apiViews(views).flatMap((view) => view.accounts
    .filter((account) => account.monthOpeningState === "NORMAL" && account.monthOpeningBalance !== null)
    .map((account) => ({ currency: account.currency, amount: account.monthOpeningBalance! }))));
  const endingBalances = group(apiViews(views).flatMap((view) => view.accounts
    .filter((account) => account.balanceState === "NORMAL" && account.balance !== null)
    .map((account) => ({ currency: account.currency, amount: account.balance! }))));
  const allocation = await allocatePlanCostsByCalendarMonthTokens(
    db, enterpriseId, month, snapshot.subjects, views,
  );
  const financeResourceIds = new Set(views.map((view) => view.resourceId));
  const retainedGaps = snapshot.gaps.filter((gap) => {
    // Replace legacy created_at/null-only expense checks with the shared settlement-window facts.
    if (gap.code === "API_COST_UNKNOWN") return false;
    if (!gap.providerResourceId || !financeResourceIds.has(gap.providerResourceId)) return true;
    const view = byResource.get(gap.providerResourceId);
    if (view?.mode === "API" && view.accounts.length === 0) return true;
    return !["OPERATING_SNAPSHOT_MISSING", "API_BALANCE_MISSING",
      "API_BALANCE_BRIDGE_MISSING", "API_OPENING_BALANCE_MISSING",
      "API_ENDING_BALANCE_MISSING", "API_CURRENCY_MISMATCH",
      "API_NEGATIVE_BALANCE_BRIDGE", "API_SPEND_NOT_CALCULABLE", "API_COST_UNKNOWN",
      "PLAN_FACT_MISSING", "UNALLOCATED_PACKAGE_COST"].includes(gap.code);
  });
  const seenGaps = new Set<string>();
  const allocationGaps: OperatingBillSnapshot["gaps"] = new Money(allocation.unallocatedCost).gt(0)
    ? [{ code: "UNALLOCATED_PACKAGE_COST", message: `仍有 ${allocation.unallocatedCost} 元套餐费用缺少完整用量归属` }] : [];
  const gaps = [...retainedGaps, ...expenseGaps, ...financeGaps, ...allocationGaps].filter((gap) => {
    const key = `${gap.code}:${gap.providerResourceId ?? ""}:${gap.field ?? ""}`;
    if (seenGaps.has(key)) return false;
    seenGaps.add(key); return true;
  });
  const openingComplete = apiViews(views).every((view) => view.accounts.length > 0 && view.accounts.every((account) =>
    account.monthOpeningState === "NORMAL" && account.monthOpeningBalance !== null));
  const endingComplete = apiViews(views).every((view) => view.accounts.length > 0 && view.accounts.every((account) =>
    account.balanceState === "NORMAL" && account.balance !== null));
  // A partial balance is useful only when every account has an established
  // opening and the only uncertainty is unpriced usage. Never silently drop a
  // missing account/currency, or turn a partial amount into a confirmed balance.
  const canShowProvisional = !endingComplete && apiViews(views).length > 0
    && !gaps.some((gap) => ["API_COST_CURRENCY_MISSING", "API_COST_CURRENCY_CONFLICT"].includes(gap.code))
    && apiViews(views).every((view) => view.accounts.length > 0 && view.accounts.every((account) =>
      ["NORMAL", "INCOMPLETE_USAGE_COST"].includes(account.balanceState)
      && (account.recordedBalance ?? account.balance) !== null
      && (account.recordedBalance ?? account.balance) !== undefined));
  const provisionalEndingBalances = canShowProvisional
    ? group(apiViews(views).flatMap((view) => view.accounts.map((account) => ({
      currency: account.currency, amount: (account.recordedBalance ?? account.balance)!,
    })))) : [];
  // 切账前历史月份（end ≤ CUTOVER）：金额权威仍属旧口径标签（AFR-06"保留原历史金额
  // 及其标签，不填入估算作为已确认值"）——完整性由 archivedExpenseGaps 驱动，摘要
  // 原因保留 API_LEGACY_ARCHIVED；当前期月份由估算完整性驱动（AFR-07：历史资金信息
  // 不参与当前费用完整性判断，LEGACY_ARCHIVED 账户不再强制置缺）。
  const preCutoverMonth = end <= PROVIDER_FINANCE_CUTOVER;
  const estimationIncomplete = enterpriseEstimation.completeness === "KNOWN_PARTIAL";
  const apiIncomplete = preCutoverMonth ? archivedExpenseGaps.length > 0 : estimationIncomplete;
  return { ...snapshot, providers, subjects: allocation.subjects, gaps,
    sourceFacts: { ...snapshot.sourceFacts, providerFinance: { resourceViews: views } },
    summary: { ...snapshot.summary,
    apiCost: estimatedSummary.apiCost, ledgerApiCost: estimatedSummary.apiCost,
    packageCost: one(packageCosts),
    apiSpendStatus: apiIncomplete ? "INCOMPLETE" : "CALCULABLE",
    apiSpendReason: apiIncomplete
      ? preCutoverMonth
        ? [...new Set(archivedExpenseGaps.map((gap) => gap.code))].join("、")
        : apiEstimationGapText(enterpriseEstimation.gaps)
      : null,
    totalCost: apiIncomplete ? null : one(totalSpends), monthlyRecharge: one(rechargeAmounts),
    openingBalance: openingComplete ? one(openingBalances) : null,
    endingBalance: endingComplete ? one(endingBalances) : null,
    endingBalanceCurrency: endingBalances.length === 1 ? endingBalances[0]!.currency : null,
    openingBalances, rechargeAmounts, endingBalances, provisionalEndingBalances,
    apiSpends: estimatedSummary.apiSpends, packageCosts, totalSpends,
    unallocatedCost: allocation.unallocatedCost } };
}

/** API 资源视图子集（本函数内多次过滤的局部简写）。 */
function apiViews(views: ResourceFinanceView[]): ResourceFinanceView[] {
  return views.filter((view) => view.mode === "API");
}

async function allocatePlanCostsByCalendarMonthTokens(
  db: Kysely<Database>, enterpriseId: string, month: string,
  source: OperatingBillSubjectRow[], views: ResourceFinanceView[],
): Promise<{ subjects: OperatingBillSubjectRow[]; unallocatedCost: string }> {
  const { start, end } = operatingBillMonthRange(month);
  const [result, legacyResult] = await Promise.all([sql<{ subject_id: string; subject_name: string;
    subject_type: "EMPLOYEE" | "PROJECT"; provider_resource_id: string; provider_name: string;
    input_tokens: string; output_tokens: string; cache_tokens: string; reasoning_tokens: string;
    tokens: string; unknown_count: string; active_dates: string[]; request_ids: string[] }>`
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
           COUNT(*) FILTER (WHERE line.usage_quality='UNKNOWN')::text AS unknown_count,
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
    const resourceRows = result.rows.filter((row) => row.provider_resource_id === view.resourceId);
    // Unknown tokens invalidate this resource's denominator, not just one subject's share.
    if (resourceRows.some((row) => Number(row.unknown_count) > 0)) {
      unallocated = unallocated.plus(view.monthlyPlanCashCny);
      continue;
    }
    const rows = resourceRows.filter((row) => new Money(row.tokens).gt(0));
    const total = rows.reduce((sum, row) => sum.plus(row.tokens), new Money(0));
    if (total.isZero()) {
      unallocated = unallocated.plus(view.monthlyPlanCashCny);
      continue;
    }
      const allocationScale = new Money(view.monthlyPlanCashCny).decimalPlaces() <= 2 ? 100 : 100_000_000;
      const totalUnits = new Money(view.monthlyPlanCashCny).mul(allocationScale)
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
        const amount = units.div(allocationScale);
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
