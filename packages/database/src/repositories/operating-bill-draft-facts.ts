import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import type {
  OperatingBillPeriod,
  OperatingBillValueItemView,
} from "./operating-bill-types.js";
import { loadMonthlyOperatingCosts } from "./monthly-operating-cost.js";
import { operatingBillResourceScope } from "./operating-bill-resource-scope.js";
import { effectiveReportedApiCostSql } from "./usage-cost-disposition-projection.js";
import type {
  LedgerSourceRow, PurchaseFactRow, ResourceConfirmationRow, SubjectStatsRow, UsageFactRow,
} from "./operating-bill-draft-rows.js";
import type { ResourceFactRow, ResourceRangeRow } from "./operating-bill-draft-policy.js";

/**
 * buildOperatingBillDraft 的事实装载段（SQL 构造 + 月度经营成本装载）。
 * 原样搬运自 operating-bill-draft.ts：同一次 await 链（先 loadMonthlyOperatingCosts、
 * 再单批 Promise.all），行契约与 SQL 文本逐字不变，语义零变化。
 */
export async function loadOperatingBillDraftFacts(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  period: OperatingBillPeriod | null,
  valueItems: OperatingBillValueItemView[],
  start: Date,
  end: Date,
) {
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
    totalQuotaResult,
  ] = await Promise.all([
    sql<ResourceFactRow>`
      WITH resources AS (
        SELECT pr.id, pr.provider_id, pr.name, pr.mode, pr.status
          FROM provider_resource pr
          JOIN provider scope_provider ON scope_provider.id = pr.provider_id
           AND scope_provider.enterprise_id = pr.enterprise_id
         WHERE pr.enterprise_id = ${enterpriseId} AND pr.status <> 'DELETED'
           AND ${operatingBillResourceScope("pr", "scope_provider", start, end)}
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
                           = COUNT(${effectiveReportedApiCostSql("ll")}) FILTER (WHERE ll.resource_mode = 'API')
                   THEN COALESCE(SUM(${effectiveReportedApiCostSql("ll")}) FILTER (WHERE ll.resource_mode = 'API'), 0)
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
                           = COUNT(${effectiveReportedApiCostSql("ll")}) FILTER (WHERE ll.resource_mode = 'API')
                   THEN COALESCE(SUM(${effectiveReportedApiCostSql("ll")}) FILTER (WHERE ll.resource_mode = 'API'), 0)
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
    sql<{ total_allocated_quota: string }>`
      SELECT COALESCE(SUM(pg.quota_value), 0)::text AS total_allocated_quota
        FROM principal_grant pg
        JOIN principal pr ON pr.id = pg.principal_id AND pr.enterprise_id = ${enterpriseId}
       WHERE pg.enterprise_id = ${enterpriseId}
         AND pg.status = 'ACTIVE'
         AND (pg.valid_until IS NULL OR pg.valid_until > ${end})
    `.execute(db),
  ]);
  return {
    monthlyOperatingCosts,
    monthlyCostByResource,
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
    totalQuotaResult,
  };
}
