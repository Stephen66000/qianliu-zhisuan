import { Decimal } from "decimal.js";
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
  currency: string | null;
  current_balance: string | null;
  package_cost: string | null;
  total_quota: string | null;
  used_quota: string | null;
  remaining_quota: string | null;
  quota_unit: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  next_reset_at: Date | null;
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
  api_cost: string;
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
  if (row.mode !== "CODING_PLAN" || row.total_quota === null || row.used_quota === null || !totalQuota.gt(0)) {
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

function gapForResource(row: ResourceFactRow): OperatingBillGap | null {
  if (!row.snapshot_id) {
    return { code: "OPERATING_SNAPSHOT_MISSING", message: `${row.resource_name} 缺少账期经营快照`, providerResourceId: row.resource_id };
  }
  if (row.mode === "API" && (!row.currency || row.current_balance === null)) {
    return { code: "API_BALANCE_MISSING", message: `${row.resource_name} 缺少币种或期末余额`, providerResourceId: row.resource_id };
  }
  if (row.mode === "CODING_PLAN" && (row.package_cost === null || row.total_quota === null || row.used_quota === null || row.quota_unit === null)) {
    return { code: "PLAN_FACT_MISSING", message: `${row.resource_name} 缺少套餐费用或额度事实`, providerResourceId: row.resource_id };
  }
  return null;
}

function isEffectivePackage(row: ResourceFactRow, start: Date, end: Date): boolean {
  return row.mode === "CODING_PLAN" && row.package_cost !== null
    && (row.effective_from === null || row.effective_from < end)
    && (row.effective_until === null || row.effective_until > start);
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
    const [
      resourceResult,
      usageResult,
      projectUsageResult,
      subjectStatsResult,
      projectStatsResult,
      ledgerSourcesResult,
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
               s.collected_at AS snapshot_at, s.currency, s.current_balance,
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
               COALESCE(SUM(CASE WHEN ll.resource_mode = 'API' THEN ll.api_cost ELSE 0 END), 0)::text AS api_cost,
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
               COALESCE(SUM(CASE WHEN ll.resource_mode = 'API' THEN ll.api_cost ELSE 0 END), 0)::text AS api_cost,
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
      Promise.resolve(valueItems),
    ]);
    const resources = resourceResult.rows;
    const sourceUsage = usageResult.rows;
    const usage = [...sourceUsage, ...projectUsageResult.rows];
    const statsByPrincipal = new Map(
      [...subjectStatsResult.rows, ...projectStatsResult.rows]
        .map((row) => [row.principal_id, row] as const),
    );
    const gaps: OperatingBillGap[] = [];
    const resourceById = new Map(resources.map((row) => [row.resource_id, row]));
    for (const row of resources) {
      const gap = gapForResource(row);
      if (gap) gaps.push(gap);
    }

    const apiCostByResource = new Map<string, Decimal>();
    const deductedByResource = new Map<string, Decimal>();
    for (const row of sourceUsage) {
      apiCostByResource.set(row.provider_resource_id,
        (apiCostByResource.get(row.provider_resource_id) ?? new MoneyDecimal(0)).plus(row.api_cost));
      deductedByResource.set(row.provider_resource_id,
        (deductedByResource.get(row.provider_resource_id) ?? new MoneyDecimal(0)).plus(row.deducted_quota));
    }
    const apiCost = [...apiCostByResource.values()].reduce((sum, value) => sum.plus(value), new MoneyDecimal(0));
    const packageResources = resources.filter((row) => isEffectivePackage(row, start, end));
    const packageCost = packageResources.reduce((sum, row) => sum.plus(row.package_cost!), new MoneyDecimal(0));

    const subjectMap = new Map<string, {
      base: OperatingBillSubjectRow;
      input: Decimal; output: Decimal; cache: Decimal; reasoning: Decimal;
      deducted: Decimal; api: Decimal; packageAllocated: Decimal;
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
        packageAllocated: new MoneyDecimal(0),
      };
      if (!current.base.providers.includes(row.provider_name)) current.base.providers.push(row.provider_name);
      current.input = current.input.plus(row.input_tokens);
      current.output = current.output.plus(row.output_tokens);
      current.cache = current.cache.plus(row.cache_tokens);
      current.reasoning = current.reasoning.plus(row.reasoning_tokens);
      current.deducted = current.deducted.plus(row.deducted_quota);
      current.api = current.api.plus(row.api_cost);
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
    const subjects = [...subjectMap.values()].map((row) => ({
      ...row.base,
      activeDays: Number(statsByPrincipal.get(row.base.principalId)?.active_days ?? 0),
      requestCount: Number(statsByPrincipal.get(row.base.principalId)?.request_count ?? 0),
      providers: [...row.base.providers].sort(),
      inputTokens: integerText(row.input), outputTokens: integerText(row.output),
      cacheTokens: integerText(row.cache), reasoningTokens: integerText(row.reasoning),
      totalTokens: integerText(row.input.plus(row.output)), deductedQuota: integerText(row.deducted),
      apiCost: amount(row.api), packageAllocatedCost: amount(row.packageAllocated),
      totalAllocatedCost: amount(row.api.plus(row.packageAllocated)),
    })).sort((left, right) => decimal(right.totalAllocatedCost).cmp(left.totalAllocatedCost));

    if (unallocatedCost.gt(0)) {
      gaps.push({ code: "UNALLOCATED_PACKAGE_COST", message: `仍有 ${amount(unallocatedCost)} 元套餐费用没有实际使用归属` });
    }
    const currencies = new Set(resources.filter((row) => row.mode === "API" && row.currency).map((row) => row.currency!));
    const apiResources = resources.filter((row) => row.mode === "API");
    const balanceComplete = apiResources.length > 0 && apiResources.every((row) => row.current_balance !== null && row.currency !== null) && currencies.size === 1;
    const endingBalance = balanceComplete
      ? apiResources.reduce((sum, row) => sum.plus(row.current_balance!), new MoneyDecimal(0)) : null;
    const utilizationWeightedCost = packageResources.reduce((sum, row) => {
      if (row.total_quota === null || row.used_quota === null || decimal(row.total_quota).lte(0)) return sum;
      return sum.plus(decimal(row.package_cost).mul(decimal(row.used_quota).div(row.total_quota)));
    }, new MoneyDecimal(0));
    const planUtilization = packageCost.gt(0) ? utilizationWeightedCost.div(packageCost).mul(100) : null;

    const providers: OperatingBillProviderRow[] = resources.map((row) => {
      const resourceApiCost = apiCostByResource.get(row.resource_id) ?? new MoneyDecimal(0);
      const resourcePackageCost = isEffectivePackage(row, start, end)
        ? decimal(row.package_cost) : new MoneyDecimal(0);
      const totalQuota = decimal(row.total_quota);
      const utilization = row.mode === "CODING_PLAN" && row.total_quota !== null && row.used_quota !== null && totalQuota.gt(0)
        ? decimal(row.used_quota).div(totalQuota).mul(100).toDecimalPlaces(2).toFixed(2) : null;
      const activePrincipalCount = new Set(sourceUsage.filter((item) => item.provider_resource_id === row.resource_id).map((item) => item.principal_id)).size;
      const assessment = assessPlanResource(row, activePrincipalCount, resourcePackageCost, end);
      return {
        providerResourceId: row.resource_id, providerCode: row.provider_code,
        providerName: row.provider_name, resourceName: row.resource_name, mode: row.mode,
        currency: row.currency, apiCost: amount(resourceApiCost), packageCost: amount(resourcePackageCost),
        totalCost: amount(resourceApiCost.plus(resourcePackageCost)), endingBalance: row.current_balance,
        totalQuota: row.total_quota, usedQuota: row.used_quota, remainingQuota: row.remaining_quota,
        quotaUnit: row.quota_unit, utilization,
        activePrincipalCount,
        operatingSnapshotId: row.snapshot_id, operatingSnapshotVersion: row.snapshot_version,
        operatingSnapshotAt: row.snapshot_at?.toISOString() ?? null, status: row.resource_status,
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
        totalCost: amount(apiCost.plus(packageCost)), apiCost: amount(apiCost), packageCost: amount(packageCost),
        endingBalance: endingBalance ? amount(endingBalance) : null,
        endingBalanceCurrency: balanceComplete ? [...currencies][0] ?? null : null,
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
        ledgerLines: ledgerSourcesResult.rows.map((row) => ({
          id: row.id, billingRuleId: row.billing_rule_id, ruleVersion: row.rule_version,
          billingRuleSnapshot: row.billing_rule_snapshot,
        })),
      },
    };
  }
