import type { Decimal } from "decimal.js";
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
import { providerFactEvidence } from "./operating-bill-provider-evidence.js";
import {
  MoneyDecimal, amount, assessPlanResource, decimal, gapForResource, integerText,
  isEffectivePackage, type ResourceFactRow, type ResourceRangeRow,
} from "./operating-bill-draft-policy.js";
import type {
  LedgerSourceRow, PurchaseFactRow, ResourceConfirmationRow, SubjectStatsRow, UsageFactRow,
} from "./operating-bill-draft-rows.js";

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
               s.quota_unit, s.effective_from, s.effective_until, s.next_reset_at,
               mb.id AS budget_id, mb.version AS budget_version, mb.status AS budget_status,
               mb.amount::text AS budget_amount, mb.currency AS budget_currency,
               mb.created_at AS budget_at
          FROM resources r
          JOIN provider p ON p.id = r.provider_id AND p.enterprise_id = ${enterpriseId}
          LEFT JOIN latest s ON s.provider_resource_id = r.id
          LEFT JOIN provider_resource_monthly_budget mb
            ON mb.enterprise_id = ${enterpriseId}
           AND mb.provider_resource_id = r.id
           AND mb.month = ${`${month}-01`}::date
           AND mb.is_current = true
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
        monthlyBudgetId: row.budget_id,
        monthlyBudgetVersion: row.budget_version ?? 0,
        monthlyBudgetStatus: row.budget_status ?? "NOT_CONFIGURED",
        monthlyBudgetAmount: row.budget_amount,
        monthlyBudgetCurrency: row.budget_currency,
        monthlyBudgetAt: row.budget_at?.toISOString() ?? null,
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
        resourceMonthlyBudgetFacts: resources.flatMap((row) => row.budget_id && row.budget_status && row.budget_at ? [{
          providerResourceId: row.resource_id,
          budgetId: row.budget_id,
          version: row.budget_version ?? 0,
          status: row.budget_status,
          amount: row.budget_amount,
          currency: row.budget_currency,
          createdAt: row.budget_at.toISOString(),
        }] : []),
        ledgerLines: ledgerSourcesResult.rows.map((row) => ({
          id: row.id, billingRuleId: row.billing_rule_id, ruleVersion: row.rule_version,
          billingRuleSnapshot: row.billing_rule_snapshot,
        })),
      },
    };
  }
