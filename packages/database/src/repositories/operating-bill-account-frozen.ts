import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database } from "../kysely.js";
import {
  finishAccountSummary,
  type OperatingBillAccountFact,
} from "./operating-bill-account-aggregate.js";
import type {
  OperatingBillAccountSubjectRow,
  OperatingBillAccountTotals,
} from "./operating-bill-account-types.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";

export class OperatingBillAccountEvidenceUnavailableError extends Error {}

interface RawFrozenFact {
  request_id: string;
  source_principal_id: string;
  source_principal_name: string;
  source_principal_type: "EMPLOYEE" | "PROJECT";
  project_id: string | null;
  project_name: string | null;
  project_owner_person_id: string | null;
  project_owner_name: string | null;
  project_department_id: string | null;
  project_department_name: string | null;
  provider_code: string;
  provider_name: string;
  unified_model_id: string | null;
  current_alias: string | null;
  historical_alias: string;
  request_status: string;
  used_at: Date;
  active_dates: string[];
  qualities: string[];
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  reasoning_tokens: string;
  deducted_quota: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
}

interface RawFrozenSummary {
  level: "TOTAL" | "SUBJECT" | "PROVIDER";
  subject_id: string | null;
  subject_name: string | null;
  is_unassigned: boolean | null;
  project_owner_person_id: string | null;
  project_owner_name: string | null;
  project_departments: Array<{ departmentId: string; departmentName: string }>;
  provider_code: string | null;
  provider_name: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_tokens: string | null;
  reasoning_tokens: string | null;
  deducted_quota: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
  quality_signature: string | null;
  active_days: string;
  request_count: string;
  last_used_at: Date | null;
  total_count: string;
}

interface RawFrozenPage extends RawFrozenFact {
  window_total: string;
  total_count: string;
}

interface FrozenFilter {
  principalId?: string;
  unifiedModelId?: string;
  providerCode?: string;
}

export async function frozenEvidenceState(
  db: Kysely<Database>, enterpriseId: string, month: string,
): Promise<"DRAFT" | "AVAILABLE" | "UNAVAILABLE"> {
  const { monthDate } = operatingBillMonthRange(month);
  const result = await sql<{ status: "DRAFT" | "CLOSED"; has_evidence: boolean }>`
    SELECT period.status,
           jsonb_typeof(version.snapshot #> '{sourceFacts,accountFacts}') = 'array' AS has_evidence
      FROM operating_bill_period period
      LEFT JOIN operating_bill_version version
        ON version.enterprise_id = period.enterprise_id AND version.period_id = period.id
       AND version.version = period.current_version
     WHERE period.enterprise_id = ${enterpriseId} AND period.period_month = ${monthDate}
  `.execute(db);
  const state = result.rows[0];
  if (state?.status !== "CLOSED") return "DRAFT";
  return state.has_evidence ? "AVAILABLE" : "UNAVAILABLE";
}

export function frozenFactsCte(enterpriseId: string, month: string): RawBuilder<unknown> {
  const { monthDate } = operatingBillMonthRange(month);
  return sql`
    frozen_json AS (
      SELECT item.fact
        FROM operating_bill_period period
        JOIN operating_bill_version version
          ON version.enterprise_id = period.enterprise_id AND version.period_id = period.id
         AND version.version = period.current_version
        CROSS JOIN LATERAL jsonb_array_elements(
          version.snapshot #> '{sourceFacts,accountFacts}'
        ) AS item(fact)
       WHERE period.enterprise_id = ${enterpriseId} AND period.period_month = ${monthDate}
         AND period.status = 'CLOSED'
    ), frozen_facts AS (
      SELECT fact->>'requestId' AS request_id,
             fact->>'sourcePrincipalId' AS source_principal_id,
             fact->>'sourcePrincipalName' AS source_principal_name,
             fact->>'sourcePrincipalType' AS source_principal_type,
             NULLIF(fact->>'projectId', '')::uuid AS project_id,
             fact->>'projectName' AS project_name,
             NULLIF(fact->>'projectOwnerPersonId', '')::uuid AS project_owner_person_id,
             fact->>'projectOwnerName' AS project_owner_name,
             NULLIF(fact->>'projectDepartmentId', '')::uuid AS project_department_id,
             fact->>'projectDepartmentName' AS project_department_name,
             fact->>'providerCode' AS provider_code,
             fact->>'providerName' AS provider_name,
             NULLIF(fact->>'unifiedModelId', '')::uuid AS unified_model_id,
             COALESCE(model.alias, fact->>'currentAlias') AS current_alias,
             fact->>'historicalAlias' AS historical_alias,
             fact->>'requestStatus' AS request_status,
             (fact->>'usedAt')::timestamptz AS used_at,
             ARRAY(SELECT jsonb_array_elements_text(fact->'activeDates')) AS active_dates,
             ARRAY(SELECT jsonb_array_elements_text(fact->'qualities')) AS qualities,
             fact->>'inputTokens' AS input_tokens,
             fact->>'outputTokens' AS output_tokens,
             fact->>'cacheTokens' AS cache_tokens,
             fact->>'reasoningTokens' AS reasoning_tokens,
             fact->>'deductedQuota' AS deducted_quota,
             fact->>'apiCost' AS api_cost,
             fact->>'packageAllocatedCost' AS package_allocated_cost,
             (SELECT STRING_AGG(DISTINCT upper(q.value), ',' ORDER BY upper(q.value))
                FROM jsonb_array_elements_text(fact->'qualities') q(value)) AS quality_signature
        FROM frozen_json
        LEFT JOIN unified_model model
          ON model.enterprise_id = ${enterpriseId}
         AND model.id = NULLIF(fact->>'unifiedModelId', '')::uuid
    )
  `;
}

function frozenFilters(filter: FrozenFilter): RawBuilder<unknown> {
  const principal = filter.principalId
    ? sql` AND source_principal_id = ${filter.principalId} AND source_principal_type = 'EMPLOYEE'`
    : sql``;
  const model = filter.unifiedModelId
    ? sql` AND unified_model_id = ${filter.unifiedModelId}` : sql``;
  const provider = filter.providerCode
    ? sql` AND provider_code = ${filter.providerCode}` : sql``;
  return sql`${principal}${model}${provider}`;
}

function mapFrozenFact(row: RawFrozenFact): OperatingBillAccountFact {
  return {
    requestId: row.request_id,
    sourcePrincipalId: row.source_principal_id,
    sourcePrincipalName: row.source_principal_name,
    sourcePrincipalType: row.source_principal_type,
    projectId: row.project_id,
    projectName: row.project_name,
    projectOwnerPersonId: row.project_owner_person_id,
    projectOwnerName: row.project_owner_name,
    projectDepartmentId: row.project_department_id,
    projectDepartmentName: row.project_department_name,
    providerCode: row.provider_code,
    providerName: row.provider_name,
    unifiedModelId: row.unified_model_id,
    currentAlias: row.current_alias,
    historicalAlias: row.historical_alias,
    requestStatus: row.request_status,
    usedAt: row.used_at,
    activeDates: row.active_dates,
    qualities: row.qualities,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    reasoningTokens: row.reasoning_tokens,
    deductedQuota: row.deducted_quota,
    apiCost: row.api_cost,
    packageAllocatedCost: row.package_allocated_cost,
  };
}

function summaryTotals(row: RawFrozenSummary | undefined): OperatingBillAccountTotals {
  return finishAccountSummary({
    inputTokens: row?.input_tokens ?? "0",
    outputTokens: row?.output_tokens ?? "0",
    cacheTokens: row?.cache_tokens ?? "0",
    reasoningTokens: row?.reasoning_tokens ?? "0",
    deductedQuota: row?.deducted_quota ?? (row ? null : "0"),
    apiCost: row?.api_cost ?? (row ? null : "0"),
    packageAllocatedCost: row?.package_allocated_cost ?? (row ? null : "0"),
    qualities: row?.quality_signature?.split(",") ?? [],
    activeDays: Number(row?.active_days ?? 0),
    requestCount: Number(row?.request_count ?? 0),
    lastUsedAt: row?.last_used_at ?? null,
  });
}

export async function loadFrozenOperatingBillAccountSummary(
  db: Kysely<Database>, enterpriseId: string, month: string,
  dimension: "EMPLOYEE" | "PROJECT",
  query: { providerCode?: string; search?: string; limit: number; offset: number },
): Promise<{ totals: OperatingBillAccountTotals; rows: OperatingBillAccountSubjectRow[]; total: number }> {
  const state = await frozenEvidenceState(db, enterpriseId, month);
  if (state !== "AVAILABLE") throw new OperatingBillAccountEvidenceUnavailableError();
  const provider = query.providerCode ? sql` AND provider_code = ${query.providerCode}` : sql``;
  const needle = query.search?.trim();
  const search = needle ? sql` AND POSITION(lower(${needle}) IN lower(subject_name)) > 0` : sql``;
  const result = await sql<RawFrozenSummary>`
    WITH ${frozenFactsCte(enterpriseId, month)}, dimension_facts AS (
      SELECT frozen_facts.*,
             CASE WHEN ${dimension} = 'EMPLOYEE' THEN source_principal_id::uuid
                  WHEN source_principal_type = 'PROJECT' THEN source_principal_id::uuid
                  ELSE project_id END AS subject_id,
             CASE WHEN ${dimension} = 'EMPLOYEE' THEN source_principal_name
                  WHEN source_principal_type = 'PROJECT' THEN source_principal_name
                  ELSE COALESCE(project_name, '未归属项目') END AS subject_name,
             CASE WHEN ${dimension} = 'PROJECT' AND source_principal_type = 'EMPLOYEE'
                       AND project_id IS NULL THEN TRUE ELSE FALSE END AS is_unassigned
        FROM frozen_facts
       WHERE ${dimension} <> 'EMPLOYEE' OR source_principal_type = 'EMPLOYEE'
    ), scoped_facts AS (
      SELECT * FROM dimension_facts WHERE TRUE ${provider}${search}
    ), summaries AS (
      SELECT CASE WHEN GROUPING(subject_name) = 1 THEN 'TOTAL'
                  WHEN GROUPING(provider_code) = 1 THEN 'SUBJECT' ELSE 'PROVIDER' END AS level,
             subject_id, subject_name, is_unassigned, provider_code, provider_name,
             MIN(project_owner_person_id::text)::uuid AS project_owner_person_id,
             MIN(project_owner_name) AS project_owner_name,
             COALESCE(
               jsonb_agg(DISTINCT jsonb_build_object(
                 'departmentId', project_department_id,
                 'departmentName', project_department_name
               )) FILTER (WHERE project_department_id IS NOT NULL),
               '[]'::jsonb
             ) AS project_departments,
             SUM(input_tokens::numeric)::text AS input_tokens,
             SUM(output_tokens::numeric)::text AS output_tokens,
             SUM(cache_tokens::numeric)::text AS cache_tokens,
             SUM(reasoning_tokens::numeric)::text AS reasoning_tokens,
             (CASE WHEN COUNT(deducted_quota) = COUNT(*)
               THEN COALESCE(SUM(deducted_quota::numeric), 0) ELSE NULL END)::text AS deducted_quota,
             (CASE WHEN COUNT(api_cost) = COUNT(*)
               THEN COALESCE(SUM(api_cost::numeric), 0) ELSE NULL END)::text AS api_cost,
             (CASE WHEN COUNT(package_allocated_cost) = COUNT(*)
               THEN COALESCE(SUM(package_allocated_cost::numeric), 0) ELSE NULL END)::text
               AS package_allocated_cost,
             STRING_AGG(DISTINCT quality_signature, ',') AS quality_signature,
             COUNT(DISTINCT request_id)::text AS request_count,
             MAX(used_at) AS last_used_at
        FROM scoped_facts
       GROUP BY GROUPING SETS (
         (subject_id, subject_name, is_unassigned, provider_code, provider_name),
         (subject_id, subject_name, is_unassigned), ()
       )
    ), activity AS (
      SELECT CASE WHEN GROUPING(subject_name) = 1 THEN 'TOTAL'
                  WHEN GROUPING(provider_code) = 1 THEN 'SUBJECT' ELSE 'PROVIDER' END AS level,
             subject_id, subject_name, is_unassigned, provider_code, provider_name,
             COUNT(DISTINCT active_date)::text AS active_days
        FROM scoped_facts CROSS JOIN LATERAL unnest(active_dates) active_date
       GROUP BY GROUPING SETS (
         (subject_id, subject_name, is_unassigned, provider_code, provider_name),
         (subject_id, subject_name, is_unassigned), ()
       )
    ), joined AS (
      SELECT summaries.*, COALESCE(activity.active_days, '0') AS active_days
        FROM summaries LEFT JOIN activity
        ON activity.level = summaries.level
       AND activity.subject_id IS NOT DISTINCT FROM summaries.subject_id
       AND activity.subject_name IS NOT DISTINCT FROM summaries.subject_name
       AND activity.is_unassigned IS NOT DISTINCT FROM summaries.is_unassigned
       AND activity.provider_code IS NOT DISTINCT FROM summaries.provider_code
       AND activity.provider_name IS NOT DISTINCT FROM summaries.provider_name
    ), subject_page AS (
      SELECT subject_id, subject_name, is_unassigned
        FROM joined WHERE level = 'SUBJECT'
       ORDER BY (CASE WHEN api_cost IS NULL OR package_allocated_cost IS NULL THEN NULL
                 ELSE api_cost::numeric + package_allocated_cost::numeric END) DESC NULLS LAST,
                subject_name ASC, COALESCE(subject_id::text, '') ASC
       LIMIT ${query.limit} OFFSET ${query.offset}
    ), subject_meta AS (
      SELECT COUNT(*)::text AS total_count FROM joined WHERE level = 'SUBJECT'
    )
    SELECT joined.*, subject_meta.total_count
      FROM joined CROSS JOIN subject_meta
     WHERE joined.level = 'TOTAL' OR EXISTS (
       SELECT 1 FROM subject_page page
        WHERE page.subject_id IS NOT DISTINCT FROM joined.subject_id
          AND page.subject_name IS NOT DISTINCT FROM joined.subject_name
          AND page.is_unassigned IS NOT DISTINCT FROM joined.is_unassigned
     )
  `.execute(db);
  const subjects = new Map<string, OperatingBillAccountSubjectRow>();
  for (const row of result.rows.filter((item) => item.level === "SUBJECT")) {
    subjects.set(row.subject_id ?? "__unassigned_project__", {
      subjectId: row.subject_id,
      subjectName: row.subject_name!,
      isUnassigned: row.is_unassigned ?? false,
      projectOwner: dimension === "PROJECT" && row.project_owner_person_id && row.project_owner_name
        ? { personId: row.project_owner_person_id, personName: row.project_owner_name }
        : null,
      projectDepartments: dimension === "PROJECT"
        ? row.project_departments.sort((left, right) =>
          left.departmentName.localeCompare(right.departmentName)
            || left.departmentId.localeCompare(right.departmentId))
        : [],
      providers: [],
      totals: summaryTotals(row),
    });
  }
  for (const row of result.rows.filter((item) => item.level === "PROVIDER")) {
    const subject = subjects.get(row.subject_id ?? "__unassigned_project__");
    if (subject && row.provider_code && row.provider_name) {
      subject.providers.push({ providerCode: row.provider_code, providerName: row.provider_name });
    }
  }
  return {
    totals: summaryTotals(result.rows.find((row) => row.level === "TOTAL")),
    rows: [...subjects.values()],
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

export async function loadFrozenOperatingBillRequestPage(
  db: Kysely<Database>, enterpriseId: string, month: string,
  filter: Required<Pick<FrozenFilter, "principalId" | "unifiedModelId">>
    & Pick<FrozenFilter, "providerCode">,
  page: { limit: number; offset: number },
): Promise<{ facts: OperatingBillAccountFact[]; total: number; employeeName: string | null }> {
  const state = await frozenEvidenceState(db, enterpriseId, month);
  if (state !== "AVAILABLE") throw new OperatingBillAccountEvidenceUnavailableError();
  const result = await sql<RawFrozenPage>`
    WITH ${frozenFactsCte(enterpriseId, month)}, scoped AS (
      SELECT * FROM frozen_facts WHERE TRUE ${frozenFilters(filter)}
    ), request_facts AS (
      SELECT request_id, MAX(source_principal_id) AS source_principal_id,
             MAX(source_principal_name) AS source_principal_name,
             'EMPLOYEE'::text AS source_principal_type,
             NULL::uuid AS project_id, NULL::text AS project_name,
             NULL::uuid AS project_owner_person_id, NULL::text AS project_owner_name,
             NULL::uuid AS project_department_id, NULL::text AS project_department_name,
             MAX(provider_code) AS provider_code, MAX(provider_name) AS provider_name,
             MAX(unified_model_id::text)::uuid AS unified_model_id,
             MAX(current_alias) AS current_alias, MAX(historical_alias) AS historical_alias,
             MAX(request_status) AS request_status, MAX(used_at) AS used_at,
             ARRAY[to_char(MAX(used_at) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')] AS active_dates,
             string_to_array(STRING_AGG(DISTINCT quality_signature, ','), ',') AS qualities,
             SUM(input_tokens::numeric)::text AS input_tokens,
             SUM(output_tokens::numeric)::text AS output_tokens,
             SUM(cache_tokens::numeric)::text AS cache_tokens,
             SUM(reasoning_tokens::numeric)::text AS reasoning_tokens,
             (CASE WHEN COUNT(deducted_quota) = COUNT(*)
               THEN COALESCE(SUM(deducted_quota::numeric), 0) ELSE NULL END)::text AS deducted_quota,
             (CASE WHEN COUNT(api_cost) = COUNT(*)
               THEN COALESCE(SUM(api_cost::numeric), 0) ELSE NULL END)::text AS api_cost,
             (CASE WHEN COUNT(package_allocated_cost) = COUNT(*)
               THEN COALESCE(SUM(package_allocated_cost::numeric), 0) ELSE NULL END)::text
               AS package_allocated_cost
        FROM scoped GROUP BY request_id
    ), counted AS (
      SELECT request_facts.*, COUNT(*) OVER()::text AS window_total FROM request_facts
    ), page AS (
      SELECT * FROM counted ORDER BY used_at DESC, request_id DESC
       LIMIT ${page.limit} OFFSET ${page.offset}
    ), meta AS (
      SELECT COUNT(*)::text AS total_count FROM request_facts
    )
    SELECT page.*, meta.total_count FROM meta LEFT JOIN page ON TRUE
     ORDER BY page.used_at DESC, page.request_id DESC
  `.execute(db);
  const rows = result.rows.filter((row) => row.request_id !== null);
  return {
    facts: rows.map(mapFrozenFact),
    total: Number(rows[0]?.window_total ?? result.rows[0]?.total_count ?? 0),
    employeeName: await loadFrozenOperatingBillEmployeeName(db, enterpriseId, month, filter.principalId),
  };
}

export async function loadFrozenOperatingBillEmployeeName(
  db: Kysely<Database>, enterpriseId: string, month: string, principalId: string,
): Promise<string | null> {
  const result = await sql<{ employee_name: string | null }>`
    WITH ${frozenFactsCte(enterpriseId, month)}
    SELECT MAX(source_principal_name) AS employee_name FROM frozen_facts
     WHERE source_principal_id = ${principalId} AND source_principal_type = 'EMPLOYEE'
  `.execute(db);
  return result.rows[0]?.employee_name ?? null;
}
