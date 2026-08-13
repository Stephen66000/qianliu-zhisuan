import { Decimal } from "decimal.js";
import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database } from "../kysely.js";
import {
  departmentMoney as money,
  departmentMonthDate as monthDate,
} from "./department-cost-types.js";

interface RawLineCostRow {
  department_id: string | null;
  employee_direct_cost: string | null;
  project_cost: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
  input_tokens: string;
  output_tokens: string;
}

export interface RawCostRow extends RawLineCostRow {
  request_count: string;
  missing_snapshot_count: string;
}

export interface RawPackageSummary {
  package_cost: string | null;
  unallocated_package_cost: string | null;
  unknown_resource_count: string;
  unallocated_resource_count: string;
}

export interface RawEnterpriseSummary {
  input_tokens: string;
  output_tokens: string;
  api_cost: string | null;
  request_count: string;
}

interface RawCostAggregateRow extends RawPackageSummary {
  department_id: string | null;
  employee_direct_cost: string | null;
  project_cost: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_row_present: boolean | null;
  timezone: string;
}

interface RawRequestRow {
  department_id: string | null;
  request_count: string;
  missing_snapshot_count: string;
}

interface RawBounds {
  timezone: string;
  started_at: Date;
  ended_at: Date;
  has_plan_resources: boolean;
}

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const ZERO = "0.00000000";
const UNASSIGNED = "__unassigned__";

function latestAttributionQuery(enterpriseId: string): RawBuilder<unknown> {
  return sql`
    SELECT DISTINCT ON (a.ai_request_id)
           a.id, a.ai_request_id, ou.id AS organization_unit_id, a.cost_category
      FROM request_attribution_snapshot a
      LEFT JOIN organization_unit ou
        ON ou.id = a.organization_unit_id AND ou.enterprise_id = ${enterpriseId}::uuid
     WHERE a.enterprise_id = ${enterpriseId}::uuid
     ORDER BY a.ai_request_id, a.version DESC, a.created_at DESC, a.id DESC
  `;
}

function costCtes(
  enterpriseId: string,
  startedAt: Date,
  endedAt: Date,
): RawBuilder<unknown> {
  return sql`
    latest_attribution AS (
      ${latestAttributionQuery(enterpriseId)}
    ), plan_resources AS (
      SELECT r.id AS provider_resource_id, snap.package_cost,
             (snap.id IS NOT NULL AND snap.package_cost IS NOT NULL
               AND (snap.effective_from IS NULL OR snap.effective_from < ${endedAt}::timestamptz)
               AND (snap.effective_until IS NULL OR snap.effective_until > ${startedAt}::timestamptz)
             ) AS cost_known,
             ${startedAt}::timestamptz AS started_at,
             ${endedAt}::timestamptz AS ended_at
        FROM provider_resource r
        LEFT JOIN LATERAL (
          SELECT s.id, s.package_cost, s.effective_from, s.effective_until
            FROM provider_resource_operating_snapshot s
           WHERE s.enterprise_id = ${enterpriseId}::uuid
             AND s.provider_resource_id = r.id
             AND s.collected_at < ${endedAt}::timestamptz
           ORDER BY s.collected_at DESC, s.version DESC, s.id DESC LIMIT 1
        ) snap ON true
       WHERE r.enterprise_id = ${enterpriseId}::uuid
         AND r.mode = 'CODING_PLAN' AND r.status <> 'DELETED'
    ), plan_state AS (
      SELECT r.provider_resource_id, r.package_cost, r.cost_known,
             (r.cost_known AND coalesce(d.line_count, 0) > 0
               AND d.line_count = d.known_count AND d.total_deducted > 0) AS allocatable,
             coalesce(d.total_deducted, 0) AS total_deducted,
             r.started_at, r.ended_at
        FROM plan_resources r
        LEFT JOIN LATERAL (
          SELECT count(*)::bigint AS line_count,
                 count(ll.deducted_quota)::bigint AS known_count,
                 coalesce(sum(ll.deducted_quota), 0)::numeric AS total_deducted
            FROM ledger_line ll
           WHERE ll.enterprise_id = ${enterpriseId}::uuid
             AND ll.provider_resource_id = r.provider_resource_id
             AND ll.resource_mode = 'CODING_PLAN'
             AND ll.created_at >= r.started_at AND ll.created_at < r.ended_at
        ) d ON true
    ), plan_line_floor AS (
      SELECT ll.id AS ledger_line_id, ll.provider_resource_id,
             floor(s.package_cost * 100000000::numeric
               * ll.deducted_quota::numeric / s.total_deducted) AS base_units,
             (s.package_cost * 100000000::numeric
               * ll.deducted_quota::numeric / s.total_deducted)
               - floor(s.package_cost * 100000000::numeric
                 * ll.deducted_quota::numeric / s.total_deducted) AS fraction,
             round(s.package_cost * 100000000::numeric) AS total_units
        FROM plan_state s
        JOIN LATERAL (
          SELECT ll.id, ll.provider_resource_id, ll.deducted_quota
            FROM ledger_line ll
           WHERE s.allocatable
             AND ll.enterprise_id = ${enterpriseId}::uuid
             AND ll.provider_resource_id = s.provider_resource_id
             AND ll.resource_mode = 'CODING_PLAN'
             AND ll.created_at >= s.started_at AND ll.created_at < s.ended_at
        ) ll ON true
    ), plan_line_rank AS (
      SELECT f.*,
             row_number() OVER (
               PARTITION BY f.provider_resource_id
               ORDER BY f.fraction DESC, f.ledger_line_id ASC
             ) AS remainder_rank,
             f.total_units - sum(f.base_units) OVER (
               PARTITION BY f.provider_resource_id
             ) AS remainder_units
        FROM plan_line_floor f
    ), plan_line_allocation AS (
      SELECT ledger_line_id,
             (base_units + CASE WHEN remainder_rank <= remainder_units THEN 1 ELSE 0 END)
               / 100000000::numeric AS allocated_cost
        FROM plan_line_rank
    ), line_facts AS (
      SELECT la.organization_unit_id AS department_id,
             coalesce(la.cost_category, 'UNASSIGNED') AS cost_category,
             ll.resource_mode, ll.raw_input_tokens, ll.raw_output_tokens,
             CASE WHEN ll.resource_mode = 'API' THEN ll.api_cost ELSE 0::numeric END AS api_line_cost,
             CASE
               WHEN ll.resource_mode <> 'CODING_PLAN' THEN 0::numeric
               WHEN ps.cost_known IS NOT TRUE THEN NULL
               WHEN ps.allocatable THEN pa.allocated_cost
               ELSE 0::numeric
             END AS package_line_cost
        FROM ledger_line ll
        LEFT JOIN latest_attribution la ON la.ai_request_id = ll.ai_request_id
        LEFT JOIN plan_state ps ON ps.provider_resource_id = ll.provider_resource_id
        LEFT JOIN plan_line_allocation pa ON pa.ledger_line_id = ll.id
       WHERE ll.enterprise_id = ${enterpriseId}::uuid
         AND ll.created_at >= ${startedAt}::timestamptz
         AND ll.created_at < ${endedAt}::timestamptz
    )
  `;
}

/** 没有可经营的 Coding Plan 时跳过套餐分摊 CTE，API 与未知值口径保持不变。 */
function apiOnlyCostCtes(
  enterpriseId: string,
  startedAt: Date,
  endedAt: Date,
): RawBuilder<unknown> {
  return sql`
    latest_attribution AS (
      ${latestAttributionQuery(enterpriseId)}
    ), plan_state AS (
      SELECT NULL::uuid AS provider_resource_id, NULL::numeric AS package_cost,
             false AS cost_known, false AS allocatable, 0::numeric AS total_deducted,
             ${startedAt}::timestamptz AS started_at,
             ${endedAt}::timestamptz AS ended_at
       WHERE false
    ), line_facts AS (
      SELECT la.organization_unit_id AS department_id,
             coalesce(la.cost_category, 'UNASSIGNED') AS cost_category,
             ll.resource_mode, ll.raw_input_tokens, ll.raw_output_tokens,
             CASE WHEN ll.resource_mode = 'API' THEN ll.api_cost ELSE 0::numeric END AS api_line_cost,
             CASE WHEN ll.resource_mode = 'CODING_PLAN' THEN NULL ELSE 0::numeric END AS package_line_cost
        FROM ledger_line ll
        LEFT JOIN latest_attribution la ON la.ai_request_id = ll.ai_request_id
       WHERE ll.enterprise_id = ${enterpriseId}::uuid
         AND ll.created_at >= ${startedAt}::timestamptz
         AND ll.created_at < ${endedAt}::timestamptz
    )
  `;
}

function knownCategoryCost(category: "EMPLOYEE_DIRECT" | "PROJECT"): RawBuilder<unknown> {
  return sql`
    CASE
      WHEN count(*) FILTER (WHERE cost_category = ${category}) = 0 THEN 0::numeric
      WHEN count(*) FILTER (
        WHERE cost_category = ${category}
          AND (api_line_cost IS NULL OR package_line_cost IS NULL)
      ) > 0 THEN NULL
      ELSE coalesce(sum(api_line_cost + package_line_cost)
        FILTER (WHERE cost_category = ${category}), 0)::numeric
    END
  `;
}

function emptyCost(departmentId: string | null): RawCostRow {
  return {
    department_id: departmentId, employee_direct_cost: ZERO, project_cost: ZERO,
    api_cost: ZERO, package_allocated_cost: ZERO, input_tokens: "0", output_tokens: "0",
    request_count: "0", missing_snapshot_count: "0",
  };
}

function summarizeEnterprise(rows: RawCostRow[]): RawEnterpriseSummary {
  if (rows.length === 0) {
    return { input_tokens: "0", output_tokens: "0", api_cost: ZERO, request_count: "0" };
  }
  const apiCosts = rows.map((row) => row.api_cost);
  return {
    input_tokens: rows.reduce((sum, row) => sum + BigInt(row.input_tokens), 0n).toString(),
    output_tokens: rows.reduce((sum, row) => sum + BigInt(row.output_tokens), 0n).toString(),
    api_cost: apiCosts.some((value) => value === null)
      ? null
      : money(apiCosts.reduce((sum, value) => new Money(sum).plus(value!), new Money(0))),
    // 每个请求只有一个最新归属快照，因此不同部门分组的 request 集合不相交。
    request_count: rows.reduce((sum, row) => sum + BigInt(row.request_count), 0n).toString(),
  };
}

export async function loadRawCosts(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
): Promise<{
  costs: RawCostRow[];
  packages: RawPackageSummary;
  enterprise: RawEnterpriseSummary;
  timezone: string;
}> {
  const start = monthDate(month);
  const boundsResult = await sql<RawBounds>`
    SELECT settings.timezone,
           ${start}::timestamp AT TIME ZONE settings.timezone AS started_at,
           (${start}::date + interval '1 month')::timestamp
             AT TIME ZONE settings.timezone AS ended_at,
           EXISTS (
             SELECT 1 FROM provider_resource r
              WHERE r.enterprise_id = ${enterpriseId}::uuid
                AND r.mode = 'CODING_PLAN' AND r.status <> 'DELETED'
           ) AS has_plan_resources
      FROM (
        SELECT coalesce((SELECT e.timezone FROM enterprise e
                          WHERE e.id = ${enterpriseId}::uuid), 'Asia/Shanghai') AS timezone
      ) settings
  `.execute(db);
  const bounds = boundsResult.rows[0]!;
  const ctes = bounds.has_plan_resources
    ? costCtes(enterpriseId, bounds.started_at, bounds.ended_at)
    : apiOnlyCostCtes(enterpriseId, bounds.started_at, bounds.ended_at);
  const costQuery = sql<RawCostAggregateRow>`
      WITH ${ctes}, line_grouped AS (
      SELECT department_id, true AS cost_row_present,
             (${knownCategoryCost("EMPLOYEE_DIRECT")}) AS employee_direct_cost,
             (${knownCategoryCost("PROJECT")}) AS project_cost,
             (CASE WHEN count(*) FILTER (WHERE resource_mode = 'API') = 0 THEN 0::numeric
               WHEN count(api_line_cost) FILTER (WHERE resource_mode = 'API')
                  = count(*) FILTER (WHERE resource_mode = 'API')
               THEN coalesce(sum(api_line_cost) FILTER (WHERE resource_mode = 'API'), 0)
               ELSE NULL END) AS api_cost,
             (CASE WHEN count(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
               WHEN count(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN')
                  = count(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
               THEN coalesce(sum(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)
               ELSE NULL END) AS package_allocated_cost,
             coalesce(sum(raw_input_tokens), 0)::numeric AS input_tokens,
             coalesce(sum(raw_output_tokens), 0)::numeric AS output_tokens
        FROM line_facts
       GROUP BY department_id
      ), package_summary AS (
      SELECT (CASE WHEN count(*) = 0 THEN 0::numeric
                   WHEN count(package_cost) FILTER (WHERE cost_known) = count(*)
                     THEN coalesce(sum(package_cost), 0)::numeric
                   ELSE NULL END)::numeric(24,8)::text AS package_cost,
             coalesce(sum(package_cost) FILTER (WHERE cost_known AND NOT allocatable), 0)
               ::numeric(24,8)::text AS unallocated_package_cost,
             count(*) FILTER (WHERE NOT cost_known)::text AS unknown_resource_count,
             count(*) FILTER (WHERE cost_known AND NOT allocatable)::text AS unallocated_resource_count
        FROM plan_state
      )
      SELECT line_grouped.department_id,
             line_grouped.employee_direct_cost::numeric(24,8)::text AS employee_direct_cost,
             line_grouped.project_cost::numeric(24,8)::text AS project_cost,
             line_grouped.api_cost::numeric(24,8)::text AS api_cost,
             line_grouped.package_allocated_cost::numeric(24,8)::text AS package_allocated_cost,
             line_grouped.input_tokens::text AS input_tokens,
             line_grouped.output_tokens::text AS output_tokens,
             line_grouped.cost_row_present,
             package_summary.*, ${bounds.timezone}::text AS timezone
        FROM package_summary
        LEFT JOIN line_grouped ON true
       ORDER BY line_grouped.department_id NULLS LAST
    `;
  const requestQuery = sql<RawRequestRow>`
    WITH latest_attribution AS (${latestAttributionQuery(enterpriseId)})
    SELECT la.organization_unit_id AS department_id,
           count(*)::text AS request_count,
           count(*) FILTER (WHERE la.id IS NULL)::text AS missing_snapshot_count
      FROM ledger_transaction lt
      LEFT JOIN latest_attribution la ON la.ai_request_id = lt.ai_request_id
     WHERE lt.enterprise_id = ${enterpriseId}::uuid
       AND lt.status = 'SETTLED'
       AND lt.created_at >= ${bounds.started_at}::timestamptz
       AND lt.created_at < ${bounds.ended_at}::timestamptz
     GROUP BY la.organization_unit_id
  `;
  const [costResult, requestResult] = await Promise.all([
    costQuery.execute(db),
    requestQuery.execute(db),
  ]);
  const summary = costResult.rows[0]!;
  const costsByDepartment = new Map<string, RawCostRow>();
  for (const row of costResult.rows) {
    if (!row.cost_row_present) continue;
    costsByDepartment.set(row.department_id ?? UNASSIGNED, {
      department_id: row.department_id,
      employee_direct_cost: row.employee_direct_cost,
      project_cost: row.project_cost,
      api_cost: row.api_cost,
      package_allocated_cost: row.package_allocated_cost,
      input_tokens: row.input_tokens ?? "0",
      output_tokens: row.output_tokens ?? "0",
      request_count: "0",
      missing_snapshot_count: "0",
    });
  }
  for (const row of requestResult.rows) {
    const key = row.department_id ?? UNASSIGNED;
    const cost = costsByDepartment.get(key) ?? emptyCost(row.department_id);
    cost.request_count = row.request_count;
    cost.missing_snapshot_count = row.missing_snapshot_count;
    costsByDepartment.set(key, cost);
  }
  const costs = [...costsByDepartment.values()];
  return {
    costs,
    packages: {
      package_cost: summary.package_cost,
      unallocated_package_cost: summary.unallocated_package_cost,
      unknown_resource_count: summary.unknown_resource_count,
      unallocated_resource_count: summary.unallocated_resource_count,
    },
    enterprise: summarizeEnterprise(costs),
    timezone: summary.timezone,
  };
}
