import { Decimal } from "decimal.js";
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import type {
  OperatingBillGap,
  OperatingBillPeriod,
  OperatingBillProviderRow,
  OperatingBillSnapshot,
  OperatingBillSubjectRow,
  OperatingBillValueItemView,
} from "./operating-bill-types.js";
import {
  addKnownCost,
  addSubjectApiCost,
  knownAmount,
  nullableAmount,
  nullableTotal,
  resourceCost,
  sumKnownCosts,
  unknownApiCostGaps,
} from "./operating-bill-cost-quality.js";
import { loadMonthlyOperatingCosts } from "./monthly-operating-cost.js";
import { apiBalanceGaps, balanceBridgeFacts, monthlyProviderCostFields, monthlySummaryFields } from "./operating-bill-monthly-cost.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

interface ResourceFactRow {
  resource_id: string;
  provider_code: string;
  provider_name: string;
  resource_name: string;
  mode: "API" | "CODING_PLAN";
  resource_status: string;
  snapshot_id: string | null;
  snapshot_version: number | null;
  snapshot_at: Date | null;
  snapshot_source: string | null;
  currency: string | null; current_balance: string | null; recharge_amount: string | null;
  package_cost: string | null;
  total_quota: string | null;
  used_quota: string | null;
  remaining_quota: string | null;
  quota_unit: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  next_reset_at: Date | null;
}

interface PurchaseFactRow {
  id: string; provider_resource_id: string; purchase_type: "API_RECHARGE" | "PACKAGE_PURCHASE";
  amount: string; currency: string; purchased_at: Date; service_period_start: string | null;
  service_period_end: string | null; source: string;
}

interface ResourceRangeRow {
  provider_resource_id: string; first_at: Date | null; last_at: Date | null; request_count: string;
}

interface ResourceConfirmationRow {
  provider_resource_id: string; status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY";
  fact_fingerprint: string; note: string | null; confirmed_at: Date;
  confirmed_by_name: string; version: number;
}

interface LedgerSourceRow {
  id: string;
  billing_rule_id: string | null;
  rule_version: string | null;
  billing_rule_snapshot: Record<string, unknown> | null;
}

interface UsageFactRow {
  principal_id: string;
  principal_name: string;
  principal_type: "EMPLOYEE" | "PROJECT";
  provider_resource_id: string;
  provider_name: string;
  resource_mode: "API" | "CODING_PLAN";
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  reasoning_tokens: string;
  deducted_quota: string;
  api_cost: string | null;
  active_days: string;
  request_count: string;
  ledger_line_count: string;
}

interface SubjectStatsRow {
  principal_id: string;
  active_days: string;
  request_count: string;
}

function decimal(value: string | null | undefined): Decimal {
  return new MoneyDecimal(value ?? "0");
}

function amount(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

function integerText(value: Decimal): string {
  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0);
}

function assessPlanResource(
  row: ResourceFactRow,
  activePrincipalCount: number,
  packageCost: Decimal,
  periodEnd: Date,
): Pick<OperatingBillProviderRow, "planAssessment" | "idleEntitlementCost" | "assessmentBasis"> {
  const totalQuota = decimal(row.total_quota);
  if (row.mode !== "CODING_PLAN" || row.effective_from === null || row.effective_until === null || row.total_quota === null || row.used_quota === null || !totalQuota.gt(0)) {
    return { planAssessment: null, idleEntitlementCost: null, assessmentBasis: null };
  }
  const used = decimal(row.used_quota);
  const boundary = [row.effective_until, row.next_reset_at, periodEnd]
    .filter((value): value is Date => value !== null)
    .reduce((earliest, value) => value < earliest ? value : earliest, periodEnd);
  const planAssessment = activePrincipalCount === 0 || used.eq(0)
    ? "UNUSED"
    : used.gte(totalQuota) && row.snapshot_at && row.snapshot_at < boundary
      ? "EXHAUSTED_EARLY"
      : used.gte(totalQuota) ? "FULL" : "UNDERUSED";
  return {
    planAssessment,
    idleEntitlementCost: amount(packageCost.mul(MoneyDecimal.max(0, new MoneyDecimal(1).minus(used.div(totalQuota))))),
    assessmentBasis: `已用 ${row.used_quota}/${row.total_quota} ${row.quota_unit ?? "原生额度"}；闲置金额按固定费用×未使用比例折算，不代表厂商退款`,
  };
}

function gapForResource(row: ResourceFactRow, range?: ResourceRangeRow): OperatingBillGap | null {
  const detail = {
    providerResourceId: row.resource_id,
    snapshotId: row.snapshot_id,
    snapshotVersion: row.snapshot_version,
    requestRangeFrom: range?.first_at?.toISOString() ?? null,
    requestRangeTo: range?.last_at?.toISOString() ?? null,
  };
  if (!row.snapshot_id) {
    return { code: "OPERATING_SNAPSHOT_MISSING", message: `${row.resource_name} 缺少字段：经营快照；请求范围 ${detail.requestRangeFrom ?? "无请求"} ~ ${detail.requestRangeTo ?? "无请求"}`, field: "operating_snapshot", ...detail };
  }
  if (row.mode === "API" && (!row.currency || row.current_balance === null)) {
    return { code: "API_BALANCE_MISSING", message: `${row.resource_name} 缺少字段：${!row.currency ? "currency" : "current_balance"}；快照 v${row.snapshot_version}`, field: !row.currency ? "currency" : "current_balance", ...detail };
  }
  if (row.mode === "CODING_PLAN" && (row.package_cost === null || row.total_quota === null || row.used_quota === null || row.quota_unit === null)) {
    const field = row.package_cost === null ? "package_cost" : row.total_quota === null ? "total_quota" : row.used_quota === null ? "used_quota" : "quota_unit";
    return { code: "PLAN_FACT_MISSING", message: `${row.resource_name} 缺少字段：${field}；快照 v${row.snapshot_version}`, field, ...detail };
  }
  if (row.mode === "CODING_PLAN" && (row.effective_from === null || row.effective_until === null)) {
    const field = row.effective_from === null ? "effective_from" : "effective_until"; return { code: "PLAN_PERIOD_MISSING", message: `${row.resource_name} 缺少字段：${field}；不能计算订阅周期利用率`, field, ...detail };
  }
  return null;
}

function isEffectivePackage(row: ResourceFactRow, start: Date, end: Date): boolean {
  return row.mode === "CODING_PLAN" && row.package_cost !== null && row.effective_from !== null && row.effective_until !== null && row.effective_from < end && row.effective_until > start;
}

function providerFactEvidence(input: {
  row: ResourceFactRow;
  resourceApiCost: Decimal | null;
  ledgerApiCost: Decimal | null;
  resourcePackageCost: Decimal;
  purchases: PurchaseFactRow[];
  range?: ResourceRangeRow;
  confirmed?: ResourceConfirmationRow;
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
    packageCost: amount(input.resourcePackageCost),
    endingBalance: input.row.current_balance,
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

export async function buildOperatingBillDraft(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  period: OperatingBillPeriod | null,
  valueItems: OperatingBillValueItemView[],
  start: Date,
  end: Date,
): Promise<OperatingBillSnapshot> {
    const monthlyOperatingCosts = await loadMonthlyOperatingCosts(db, enterpriseId, start, end);
    const monthlyCostByResource = new Map(monthlyOperatingCosts.resources.map((row) => [row.resourceId, row]));
    const [
      resourceResult,
      usageResult,
      projectUsageResult,
      subjectStatsResult,
      projectStatsResult,
      ledgerSourcesResult,
      purchasesResult,
      resourceRangesResult,
      confirmationsResult,
      values,
    ] = await Promise.all([
      sql<ResourceFactRow>`
        WITH resources AS (
          SELECT pr.id, pr.provider_id, pr.name, pr.mode, pr.status
            FROM provider_resource pr
           WHERE pr.enterprise_id = ${enterpriseId} AND pr.status <> 'DELETED'
        ), latest AS (
          SELECT DISTINCT ON (s.provider_resource_id) s.*
            FROM provider_resource_operating_snapshot s
            JOIN resources r ON r.id = s.provider_resource_id
           WHERE s.enterprise_id = ${enterpriseId} AND s.collected_at < ${end}
           ORDER BY s.provider_resource_id, s.collected_at DESC, s.version DESC
        )
        SELECT r.id AS resource_id, p.code AS provider_code, p.name AS provider_name,
               r.name AS resource_name, r.mode, r.status AS resource_status,
               s.id AS snapshot_id, s.version AS snapshot_version,
               s.collected_at AS snapshot_at, s.source AS snapshot_source, s.currency, s.current_balance, s.recharge_amount,
               s.package_cost, s.total_quota, s.used_quota, s.remaining_quota,
               s.quota_unit, s.effective_from, s.effective_until, s.next_reset_at
          FROM resources r
          JOIN provider p ON p.id = r.provider_id AND p.enterprise_id = ${enterpriseId}
          LEFT JOIN latest s ON s.provider_resource_id = r.id
         ORDER BY p.code, r.name
      `.execute(db),
      sql<UsageFactRow>`
        SELECT ll.principal_id, prn.name AS principal_name, prn.type AS principal_type,
               ll.provider_resource_id, p.name AS provider_name,
               ll.resource_mode,
               SUM(ll.raw_input_tokens)::text AS input_tokens,
               SUM(ll.raw_output_tokens)::text AS output_tokens,
               SUM(ll.raw_cache_tokens)::text AS cache_tokens,
               SUM(ll.raw_reasoning_tokens)::text AS reasoning_tokens,
               COALESCE(SUM(ll.deducted_quota), 0)::text AS deducted_quota,
               (CASE WHEN COUNT(*) FILTER (WHERE ll.resource_mode = 'API')
                           = COUNT(ll.api_cost) FILTER (WHERE ll.resource_mode = 'API')
                     THEN COALESCE(SUM(ll.api_cost) FILTER (WHERE ll.resource_mode = 'API'), 0)
                     ELSE NULL END)::text AS api_cost,
               COUNT(DISTINCT (ll.created_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS active_days,
               COUNT(DISTINCT ll.ai_request_id)::text AS request_count,
               COUNT(*)::text AS ledger_line_count
          FROM ledger_line ll
          JOIN principal prn ON prn.id = ll.principal_id AND prn.enterprise_id = ${enterpriseId}
          JOIN provider_resource r ON r.id = ll.provider_resource_id AND r.enterprise_id = ${enterpriseId}
          JOIN provider p ON p.id = r.provider_id AND p.enterprise_id = ${enterpriseId}
         WHERE ll.enterprise_id = ${enterpriseId}
           AND ll.created_at >= ${start} AND ll.created_at < ${end}
         GROUP BY ll.principal_id, prn.name, prn.type, ll.provider_resource_id, p.name, ll.resource_mode
      `.execute(db),
      sql<UsageFactRow>`
        SELECT COALESCE(project.id::text, '__unassigned_project__') AS principal_id,
               COALESCE(project.name, '未归属项目') AS principal_name,
               'PROJECT'::text AS principal_type,
               ll.provider_resource_id, p.name AS provider_name, ll.resource_mode,
               SUM(ll.raw_input_tokens)::text AS input_tokens,
               SUM(ll.raw_output_tokens)::text AS output_tokens,
               SUM(ll.raw_cache_tokens)::text AS cache_tokens,
               SUM(ll.raw_reasoning_tokens)::text AS reasoning_tokens,
               COALESCE(SUM(ll.deducted_quota), 0)::text AS deducted_quota,
               (CASE WHEN COUNT(*) FILTER (WHERE ll.resource_mode = 'API')
                           = COUNT(ll.api_cost) FILTER (WHERE ll.resource_mode = 'API')
                     THEN COALESCE(SUM(ll.api_cost) FILTER (WHERE ll.resource_mode = 'API'), 0)
                     ELSE NULL END)::text AS api_cost,
               COUNT(DISTINCT (ll.created_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS active_days,
               COUNT(DISTINCT ll.ai_request_id)::text AS request_count,
               COUNT(*)::text AS ledger_line_count
          FROM ledger_line ll
          JOIN principal source ON source.id = ll.principal_id AND source.enterprise_id = ${enterpriseId} AND source.type = 'EMPLOYEE'
          JOIN provider_resource r ON r.id = ll.provider_resource_id AND r.enterprise_id = ${enterpriseId}
          JOIN provider p ON p.id = r.provider_id AND p.enterprise_id = ${enterpriseId}
          LEFT JOIN operating_bill_request_project_assignment a
            ON a.enterprise_id = ${enterpriseId} AND a.ai_request_id = ll.ai_request_id
          LEFT JOIN principal project
            ON project.enterprise_id = ${enterpriseId} AND project.id = a.project_principal_id AND project.type = 'PROJECT'
         WHERE ll.enterprise_id = ${enterpriseId}
           AND ll.created_at >= ${start} AND ll.created_at < ${end}
         GROUP BY project.id, project.name, ll.provider_resource_id, p.name, ll.resource_mode
      `.execute(db),
      sql<SubjectStatsRow>`
        SELECT ll.principal_id,
               COUNT(DISTINCT (ll.created_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS active_days,
               COUNT(DISTINCT ll.ai_request_id)::text AS request_count
          FROM ledger_line ll
          JOIN principal prn ON prn.id = ll.principal_id AND prn.enterprise_id = ${enterpriseId}
         WHERE ll.enterprise_id = ${enterpriseId}
           AND ll.created_at >= ${start} AND ll.created_at < ${end}
         GROUP BY ll.principal_id
      `.execute(db),
      sql<SubjectStatsRow>`
        SELECT COALESCE(project.id::text, '__unassigned_project__') AS principal_id,
               COUNT(DISTINCT (ll.created_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS active_days,
               COUNT(DISTINCT ll.ai_request_id)::text AS request_count
          FROM ledger_line ll
          JOIN principal source
            ON source.id = ll.principal_id AND source.enterprise_id = ${enterpriseId} AND source.type = 'EMPLOYEE'
          LEFT JOIN operating_bill_request_project_assignment a
            ON a.enterprise_id = ${enterpriseId} AND a.ai_request_id = ll.ai_request_id
          LEFT JOIN principal project
            ON project.enterprise_id = ${enterpriseId} AND project.id = a.project_principal_id AND project.type = 'PROJECT'
         WHERE ll.enterprise_id = ${enterpriseId}
           AND ll.created_at >= ${start} AND ll.created_at < ${end}
         GROUP BY project.id
      `.execute(db),
      sql<LedgerSourceRow>`
        SELECT id, billing_rule_id, rule_version, billing_rule_snapshot
          FROM ledger_line
         WHERE enterprise_id = ${enterpriseId}
           AND created_at >= ${start} AND created_at < ${end}
         ORDER BY created_at, id
      `.execute(db),
      sql<PurchaseFactRow>`
        SELECT id, provider_resource_id, purchase_type, amount::text, currency, purchased_at,
               service_period_start::text, service_period_end::text, source
          FROM resource_purchase_record
         WHERE enterprise_id = ${enterpriseId}
           AND purchased_at >= ${start} AND purchased_at < ${end}
         ORDER BY purchased_at, id
      `.execute(db),
      sql<ResourceRangeRow>`
        SELECT provider_resource_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
               COUNT(DISTINCT ai_request_id)::text AS request_count
          FROM ledger_line
         WHERE enterprise_id = ${enterpriseId} AND created_at >= ${start} AND created_at < ${end}
         GROUP BY provider_resource_id
      `.execute(db),
      period ? sql<ResourceConfirmationRow>`
        SELECT c.provider_resource_id, c.status, c.fact_fingerprint, c.note, c.confirmed_at,
               a.display_name AS confirmed_by_name, c.version
          FROM operating_bill_resource_confirmation c
          JOIN admin_user a ON a.id = c.confirmed_by AND a.enterprise_id = c.enterprise_id
         WHERE c.enterprise_id = ${enterpriseId} AND c.period_id = ${period.id}
      `.execute(db) : Promise.resolve({ rows: [] as ResourceConfirmationRow[] }),
      Promise.resolve(valueItems),
    ]);
    const resources = resourceResult.rows;
    const purchasesByResource = new Map<string, PurchaseFactRow[]>();
    for (const purchase of purchasesResult.rows) {
      const list = purchasesByResource.get(purchase.provider_resource_id) ?? [];
      list.push(purchase); purchasesByResource.set(purchase.provider_resource_id, list);
    }
    const rangeByResource = new Map(resourceRangesResult.rows.map((row) => [row.provider_resource_id, row]));
    const confirmationByResource = new Map(confirmationsResult.rows.map((row) => [row.provider_resource_id, row]));
    const sourceUsage = usageResult.rows;
    const usage = [...sourceUsage, ...projectUsageResult.rows];
    const statsByPrincipal = new Map(
      [...subjectStatsResult.rows, ...projectStatsResult.rows]
        .map((row) => [row.principal_id, row] as const),
    );
    const gaps: OperatingBillGap[] = [];
    const resourceById = new Map(resources.map((row) => [row.resource_id, row]));
    for (const row of resources) {
      const gap = gapForResource(row, rangeByResource.get(row.resource_id));
      if (gap) gaps.push(gap);
      gaps.push(...apiBalanceGaps(row, monthlyCostByResource.get(row.resource_id)));
    }

    const apiCostByResource = new Map<string, Decimal | null>();
    const deductedByResource = new Map<string, Decimal>();
    for (const row of sourceUsage) {
      addKnownCost(apiCostByResource, row.provider_resource_id, row.api_cost);
      deductedByResource.set(row.provider_resource_id,
        (deductedByResource.get(row.provider_resource_id) ?? new MoneyDecimal(0)).plus(row.deducted_quota));
    }
    const ledgerApiCost = sumKnownCosts(apiCostByResource);
    gaps.push(...unknownApiCostGaps(apiCostByResource, resourceById).map((gap) => {
      const resource = gap.providerResourceId ? resourceById.get(gap.providerResourceId) : undefined;
      const range = gap.providerResourceId ? rangeByResource.get(gap.providerResourceId) : undefined;
      return {
        ...gap,
        field: "ledger_line.api_cost",
        snapshotId: resource?.snapshot_id ?? null,
        snapshotVersion: resource?.snapshot_version ?? null,
        requestRangeFrom: range?.first_at?.toISOString() ?? null,
        requestRangeTo: range?.last_at?.toISOString() ?? null,
        message: `${gap.message}；缺失字段 ledger_line.api_cost；请求范围 ${range?.first_at?.toISOString() ?? "未知"} ~ ${range?.last_at?.toISOString() ?? "未知"}`,
      };
    }));
    const packageResources = resources.filter((row) => isEffectivePackage(row, start, end));
    const packageCost = decimal(monthlyOperatingCosts.summary.packageCost);

    const subjectMap = new Map<string, {
      base: OperatingBillSubjectRow;
      input: Decimal; output: Decimal; cache: Decimal; reasoning: Decimal;
      deducted: Decimal; api: Decimal; apiKnown: boolean; packageAllocated: Decimal;
    }>();
    for (const row of usage) {
      const current = subjectMap.get(row.principal_id) ?? {
        base: {
          principalId: row.principal_id, principalName: row.principal_name,
          principalType: row.principal_type, providers: [], inputTokens: "0", outputTokens: "0",
          cacheTokens: "0", reasoningTokens: "0", totalTokens: "0", deductedQuota: "0",
          apiCost: "0.00000000", packageAllocatedCost: "0.00000000",
          totalAllocatedCost: "0.00000000", activeDays: 0, requestCount: 0,
        },
        input: new MoneyDecimal(0), output: new MoneyDecimal(0), cache: new MoneyDecimal(0),
        reasoning: new MoneyDecimal(0), deducted: new MoneyDecimal(0), api: new MoneyDecimal(0),
        apiKnown: true,
        packageAllocated: new MoneyDecimal(0),
      };
      if (!current.base.providers.includes(row.provider_name)) current.base.providers.push(row.provider_name);
      current.input = current.input.plus(row.input_tokens);
      current.output = current.output.plus(row.output_tokens);
      current.cache = current.cache.plus(row.cache_tokens);
      current.reasoning = current.reasoning.plus(row.reasoning_tokens);
      current.deducted = current.deducted.plus(row.deducted_quota);
      addSubjectApiCost(current, row.api_cost);
      const resource = resourceById.get(row.provider_resource_id);
      if (resource?.mode === "CODING_PLAN" && resource.package_cost !== null) {
        const totalDeducted = deductedByResource.get(row.provider_resource_id) ?? new MoneyDecimal(0);
        if (totalDeducted.gt(0)) {
          current.packageAllocated = current.packageAllocated.plus(
            decimal(resource.package_cost).mul(decimal(row.deducted_quota)).div(totalDeducted),
          );
        }
      }
      subjectMap.set(row.principal_id, current);
    }
    const unallocatedCost = packageResources.reduce((sum, row) => {
      const used = deductedByResource.get(row.resource_id) ?? new MoneyDecimal(0);
      return used.gt(0) ? sum : sum.plus(row.package_cost!);
    }, new MoneyDecimal(0));
    const subjects = [...subjectMap.values()].map((row) => {
      const subjectApiCost = knownAmount(row.api, row.apiKnown);
      return {
        ...row.base,
        activeDays: Number(statsByPrincipal.get(row.base.principalId)?.active_days ?? 0),
        requestCount: Number(statsByPrincipal.get(row.base.principalId)?.request_count ?? 0),
        providers: [...row.base.providers].sort(),
        inputTokens: integerText(row.input), outputTokens: integerText(row.output),
        cacheTokens: integerText(row.cache), reasoningTokens: integerText(row.reasoning),
        totalTokens: integerText(row.input.plus(row.output)), deductedQuota: integerText(row.deducted),
        apiCost: subjectApiCost, packageAllocatedCost: amount(row.packageAllocated),
        totalAllocatedCost: nullableTotal(row.apiKnown ? row.api : null, row.packageAllocated),
      };
    }).sort((left, right) => decimal(right.totalAllocatedCost).cmp(decimal(left.totalAllocatedCost)));

    if (unallocatedCost.gt(0)) {
      gaps.push({ code: "UNALLOCATED_PACKAGE_COST", message: `仍有 ${amount(unallocatedCost)} 元套餐费用没有实际使用归属` });
    }
    const utilizationWeightedCost = packageResources.reduce((sum, row) => {
      if (row.total_quota === null || row.used_quota === null || decimal(row.total_quota).lte(0)) return sum;
      return sum.plus(decimal(row.package_cost).mul(decimal(row.used_quota).div(row.total_quota)));
    }, new MoneyDecimal(0));
    const planUtilization = packageCost.gt(0) ? utilizationWeightedCost.div(packageCost).mul(100) : null;

    const providers: OperatingBillProviderRow[] = resources.map((row) => {
      const resourceLedgerApiCost = resourceCost(apiCostByResource, row.resource_id);
      const monthlyCost = monthlyCostByResource.get(row.resource_id)!;
      const resourceApiCost = monthlyCost.apiSpend === null ? null : decimal(monthlyCost.apiSpend);
      const resourcePackageCost = decimal(monthlyCost.packageCost);
      const totalQuota = decimal(row.total_quota);
      const utilization = row.mode === "CODING_PLAN" && row.effective_from !== null && row.effective_until !== null && row.total_quota !== null && row.used_quota !== null && totalQuota.gt(0)
        ? decimal(row.used_quota).div(totalQuota).mul(100).toDecimalPlaces(2).toFixed(2) : null;
      const activePrincipalCount = new Set(sourceUsage.filter((item) => item.provider_resource_id === row.resource_id).map((item) => item.principal_id)).size;
      const assessment = assessPlanResource(row, activePrincipalCount, resourcePackageCost, end);
      const range = rangeByResource.get(row.resource_id);
      const confirmed = confirmationByResource.get(row.resource_id);
      const factEvidence = providerFactEvidence({
        row, resourceApiCost, ledgerApiCost: resourceLedgerApiCost, resourcePackageCost,
        purchases: purchasesByResource.get(row.resource_id) ?? [], range, confirmed,
      });
      return {
        providerResourceId: row.resource_id, providerCode: row.provider_code,
        providerName: row.provider_name, resourceName: row.resource_name, mode: row.mode,
        currency: row.currency,
        ...monthlyProviderCostFields(monthlyCost, nullableAmount(resourceLedgerApiCost)),
        totalQuota: row.total_quota, usedQuota: row.used_quota, remainingQuota: row.remaining_quota,
        quotaUnit: row.quota_unit, utilization,
        activePrincipalCount,
        operatingSnapshotId: row.snapshot_id, operatingSnapshotVersion: row.snapshot_version,
        operatingSnapshotAt: row.snapshot_at?.toISOString() ?? null, snapshotRechargeAmount: row.recharge_amount, status: row.resource_status,
        ...factEvidence,
        ...assessment,
      };
    });
    const confirmedValueAmount = values.filter((item) => item.status === "CONFIRMED" && item.value_type === "MONETARY")
      .reduce((sum, item) => sum.plus(item.amount ?? 0), new MoneyDecimal(0));
    const ledgerLineCount = usageResult.rows.reduce((sum, row) => sum + Number(row.ledger_line_count), 0);
    return {
      month, timezone: "Asia/Shanghai", periodStart: start.toISOString(), periodEnd: end.toISOString(),
      status: "DRAFT", version: period?.current_version ?? 0, generatedAt: new Date().toISOString(),
      closedAt: null, closedBy: null, closeNote: null,
      summary: {
        ...monthlySummaryFields(monthlyOperatingCosts),
        ledgerApiCost: nullableAmount(ledgerApiCost),
        planUtilization: planUtilization ? planUtilization.toDecimalPlaces(2).toFixed(2) : null,
        activePrincipalCount: new Set(sourceUsage.map((item) => item.principal_id)).size,
        confirmedValueAmount: amount(confirmedValueAmount),
        confirmedNonMonetaryCount: values.filter((item) => item.status === "CONFIRMED" && item.value_type === "NON_MONETARY").length,
        unallocatedCost: amount(unallocatedCost),
      },
      providers, subjects, values, gaps,
      sourceFacts: {
        ledgerLineCount,
        operatingSnapshotIds: resources.map((row) => row.snapshot_id).filter((id): id is string => id !== null),
        balanceBridgeFacts: balanceBridgeFacts(monthlyOperatingCosts),
        ledgerLines: ledgerSourcesResult.rows.map((row) => ({
          id: row.id, billingRuleId: row.billing_rule_id, ruleVersion: row.rule_version,
          billingRuleSnapshot: row.billing_rule_snapshot,
        })),
      },
    };
  }
