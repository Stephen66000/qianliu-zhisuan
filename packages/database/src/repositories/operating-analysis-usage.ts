import { sql, type Kysely } from "kysely";
import { Decimal } from "decimal.js";
import type { Database } from "../kysely.js";

export interface MonthlyUsageFact {
  month: string;
  provider_code: string;
  provider_name: string;
  mode: string;
  input: string;
  output: string;
  cache: string;
  employee: string;
  project: string;
  unknown_count: string;
}
interface EmployeeLifetime {
  created_at: Date;
  ended_at: Date | null;
}
export const AnalysisDecimal = Decimal.clone({ precision: 48 });
export const addAnalysis = (values: string[]) =>
  values.reduce((sum, value) => sum.plus(value), new AnalysisDecimal(0));
export const analysisRatio = (value: string | null, base: string | null) =>
  value === null || base === null || !new AnalysisDecimal(base).gt(0)
    ? null
    : new AnalysisDecimal(value).div(base).mul(100).toFixed(2);

/** Keep recorded usage usable for analysis; missing-only usage is not a known zero. */
export function recordedAnalysisUsage(rows: MonthlyUsageFact[]) {
  const usageIncomplete = rows.some((row) => Number(row.unknown_count) > 0);
  const recorded = addAnalysis(rows.flatMap((row) => [row.input, row.output]));
  return { usageIncomplete, totalTokens: usageIncomplete && recorded.isZero() ? null : recorded.toFixed(0) };
}

export async function loadAnalysisUsage(
  db: Kysely<Database>,
  enterpriseId: string,
  asOf: Date,
) {
  const [usage, activity, people, unknownDeletes] = await Promise.all([
    sql<MonthlyUsageFact>`SELECT to_char(COALESCE(ll.settled_at,ll.created_at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month,
      provider.code AS provider_code, provider.name AS provider_name, ll.resource_mode AS mode,
      SUM(ll.raw_input_tokens)::text AS input, SUM(ll.raw_output_tokens)::text AS output,
      SUM(ll.raw_cache_tokens)::text AS cache,
      COALESCE(SUM(ll.raw_input_tokens+ll.raw_output_tokens) FILTER(WHERE principal.type='EMPLOYEE'),0)::text AS employee,
      COALESCE(SUM(ll.raw_input_tokens+ll.raw_output_tokens) FILTER(WHERE principal.type='PROJECT'),0)::text AS project,
      COUNT(*) FILTER(WHERE ll.usage_quality='UNKNOWN')::text AS unknown_count
      FROM ledger_line ll JOIN principal ON principal.enterprise_id=ll.enterprise_id AND principal.id=ll.principal_id
      JOIN provider_resource resource ON resource.enterprise_id=ll.enterprise_id AND resource.id=ll.provider_resource_id
      JOIN provider ON provider.enterprise_id=resource.enterprise_id AND provider.id=resource.provider_id
      WHERE ll.enterprise_id=${enterpriseId}::uuid AND COALESCE(ll.settled_at,ll.created_at)<=${asOf}
      GROUP BY month,provider.code,provider.name,ll.resource_mode`.execute(db),
    sql<{
      month: string;
      active: string;
    }>`SELECT to_char(COALESCE(ll.settled_at,ll.created_at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month,
      COUNT(DISTINCT ll.principal_id) FILTER(WHERE principal.type='EMPLOYEE')::text AS active
      FROM ledger_line ll JOIN principal ON principal.enterprise_id=ll.enterprise_id AND principal.id=ll.principal_id
      WHERE ll.enterprise_id=${enterpriseId}::uuid AND COALESCE(ll.settled_at,ll.created_at)<=${asOf}
      GROUP BY month`.execute(db),
    sql<EmployeeLifetime>`WITH deleted AS (
      SELECT target_id,MIN(created_at) AS ended_at FROM operation_log
      WHERE enterprise_id=${enterpriseId}::uuid AND action='principal.delete' AND result='SUCCESS' GROUP BY target_id
    ) SELECT principal.created_at, principal.archived_at AS ended_at FROM principal
      WHERE enterprise_id=${enterpriseId}::uuid AND type='EMPLOYEE'
      UNION ALL
      SELECT MIN(created.created_at),deleted.ended_at FROM operation_log created
      JOIN deleted ON deleted.target_id=created.target_id
      WHERE created.enterprise_id=${enterpriseId}::uuid AND created.action='principal.create'
        AND created.result='SUCCESS' AND created.change_summary->>'type'='EMPLOYEE'
        AND NOT EXISTS(SELECT 1 FROM principal WHERE principal.enterprise_id=${enterpriseId}::uuid AND principal.id=created.target_id)
      GROUP BY created.target_id,deleted.ended_at`.execute(db),
    sql<{
      deleted_at: Date;
    }>`SELECT deleted.created_at AS deleted_at FROM operation_log deleted
      WHERE deleted.enterprise_id=${enterpriseId}::uuid AND deleted.action='principal.delete' AND deleted.result='SUCCESS'
      AND NOT EXISTS(SELECT 1 FROM operation_log created WHERE created.enterprise_id=deleted.enterprise_id
        AND created.target_id=deleted.target_id AND created.action='principal.create' AND created.result='SUCCESS')`.execute(
      db,
    ),
  ]);
  return {
    usage: usage.rows,
    activity: activity.rows,
    people: people.rows,
    unknownDeletes: unknownDeletes.rows,
  };
}

export function analysisMonthUsage(
  month: string,
  monthEnd: Date,
  asOf: Date,
  facts: Awaited<ReturnType<typeof loadAnalysisUsage>>,
) {
  const start = new Date(`${month}-01T00:00:00+08:00`);
  const future = start > asOf;
  const rows = facts.usage.filter((row) => row.month === month);
  const recorded = recordedAnalysisUsage(rows);
  const totalTokens = future ? null : recorded.totalTokens;
  const field = (key: "input" | "output" | "cache" | "employee" | "project") =>
    totalTokens !== null ? addAnalysis(rows.map((row) => row[key])).toFixed(0) : null;
  const at = Math.min(monthEnd.getTime() - 1, asOf.getTime());
  const unknownPeople = facts.unknownDeletes.some(
    (row) => row.deleted_at.getTime() > at,
  );
  const employeeCount =
    future || unknownPeople
      ? null
      : facts.people.filter(
          (person) =>
            person.created_at.getTime() <= at &&
            (!person.ended_at || person.ended_at.getTime() > at),
        ).length;

  return {
    month,
    totalTokens,
    usageIncomplete: !future && recorded.usageIncomplete,
    inputTokens: field("input"),
    outputTokens: field("output"),
    cacheTokens: field("cache"),
    employeeTokens: field("employee"),
    projectTokens: field("project"),
    employeeCount,
    activeEmployees: future
      ? null
      : Number(facts.activity.find((row) => row.month === month)?.active ?? 0),
    perCapitaTokens:
      totalTokens !== null && employeeCount
        ? new AnalysisDecimal(totalTokens).div(employeeCount).toFixed(2)
        : null,
  };
}
