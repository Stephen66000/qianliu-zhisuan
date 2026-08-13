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
import {
  liveProjectMetadataJoins,
  mapRawProjectMetadata,
  projectMetadataSummarySql,
  projectSummaryMetadata,
  type RawProjectMetadata,
  type RawProjectSummaryMetadata,
} from "./operating-bill-project-metadata.js";

interface RawAccountFact extends RawProjectMetadata {
  request_id: string;
  source_principal_id: string;
  source_principal_name: string;
  source_principal_type: "EMPLOYEE" | "PROJECT";
  project_id: string | null;
  project_name: string | null;
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

interface RawSummary extends RawProjectSummaryMetadata {
  level: "TOTAL" | "SUBJECT" | "PROVIDER";
  subject_id: string | null;
  subject_name: string | null;
  is_unassigned: boolean | null;
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

interface RawPagedFact extends RawAccountFact {
  window_total: string;
  total_count: string;
}

export interface LiveAccountFactFilter {
  principalId?: string;
  unifiedModelId?: string;
  providerCode?: string;
}

export function liveLineFactCtes(enterpriseId: string, month: string): RawBuilder<unknown> {
  const { start, end } = operatingBillMonthRange(month);
  return sql`
    latest_snapshot AS (
      SELECT DISTINCT ON (s.provider_resource_id)
             s.provider_resource_id, s.package_cost, s.effective_from, s.effective_until
        FROM provider_resource_operating_snapshot s
       WHERE s.enterprise_id = ${enterpriseId} AND s.collected_at < ${end}
       ORDER BY s.provider_resource_id, s.collected_at DESC, s.version DESC
    ), resource_deducted AS (
      SELECT ll.provider_resource_id,
             COALESCE(SUM(ll.deducted_quota) FILTER (WHERE ll.resource_mode = 'CODING_PLAN'), 0)::numeric AS total_deducted,
             COUNT(*) FILTER (WHERE ll.resource_mode = 'CODING_PLAN') AS plan_line_count,
             COUNT(ll.deducted_quota) FILTER (WHERE ll.resource_mode = 'CODING_PLAN') AS known_deducted_count
        FROM ledger_line ll
       WHERE ll.enterprise_id = ${enterpriseId}
         AND ll.created_at >= ${start} AND ll.created_at < ${end}
       GROUP BY ll.provider_resource_id
    ), line_facts AS (
      SELECT ll.ai_request_id AS request_id,
             source.id AS source_principal_id, source.name AS source_principal_name,
             source.type AS source_principal_type,
             project.id AS project_id, project.name AS project_name,
             project_owner.id AS project_owner_person_id,
             project_owner.name AS project_owner_name,
             project_department.id AS project_department_id,
             project_department.name AS project_department_name,
             p.code AS provider_code, p.name AS provider_name,
             ar.unified_model_id, um.alias AS current_alias,
             ar.unified_model AS historical_alias, ar.status AS request_status,
             ll.created_at, ll.usage_quality, ll.resource_mode,
             ll.raw_input_tokens, ll.raw_output_tokens,
             ll.raw_cache_tokens, ll.raw_reasoning_tokens,
             ll.deducted_quota, ll.api_cost,
             CASE
               WHEN ll.resource_mode <> 'CODING_PLAN' THEN 0::numeric
               WHEN ll.deducted_quota IS NULL OR snap.package_cost IS NULL
                 OR denom.plan_line_count <> denom.known_deducted_count
                 OR (snap.effective_from IS NOT NULL AND snap.effective_from >= ${end})
                 OR (snap.effective_until IS NOT NULL AND snap.effective_until <= ${start})
                 THEN NULL
               WHEN denom.total_deducted > 0
                 THEN snap.package_cost * ll.deducted_quota::numeric / denom.total_deducted
               ELSE 0::numeric
             END AS package_line_cost
        FROM ledger_line ll
        JOIN ai_request ar ON ar.id = ll.ai_request_id AND ar.enterprise_id = ${enterpriseId}
        JOIN principal source ON source.id = ll.principal_id AND source.enterprise_id = ${enterpriseId}
        JOIN provider_resource resource
          ON resource.id = ll.provider_resource_id AND resource.enterprise_id = ${enterpriseId}
        JOIN provider p ON p.id = resource.provider_id AND p.enterprise_id = ${enterpriseId}
        LEFT JOIN unified_model um
          ON um.id = ar.unified_model_id AND um.enterprise_id = ${enterpriseId}
        LEFT JOIN operating_bill_request_project_assignment assignment
          ON assignment.ai_request_id = ll.ai_request_id AND assignment.enterprise_id = ${enterpriseId}
        ${liveProjectMetadataJoins(enterpriseId)}
        LEFT JOIN latest_snapshot snap ON snap.provider_resource_id = ll.provider_resource_id
        LEFT JOIN resource_deducted denom ON denom.provider_resource_id = ll.provider_resource_id
       WHERE ll.enterprise_id = ${enterpriseId}
         AND ll.created_at >= ${start} AND ll.created_at < ${end}
    )
  `;
}

function factFilters(filter: LiveAccountFactFilter): RawBuilder<unknown> {
  const principal = filter.principalId
    ? sql` AND source_principal_id = ${filter.principalId} AND source_principal_type = 'EMPLOYEE'`
    : sql``;
  const model = filter.unifiedModelId
    ? sql` AND unified_model_id = ${filter.unifiedModelId}` : sql``;
  const provider = filter.providerCode
    ? sql` AND provider_code = ${filter.providerCode}` : sql``;
  return sql`${principal}${model}${provider}`;
}

function requestFactsSql(filter: LiveAccountFactFilter): RawBuilder<unknown> {
  return sql`
    SELECT request_id, source_principal_id, source_principal_name, source_principal_type,
           project_id, project_name, project_owner_person_id, project_owner_name,
           project_department_id, project_department_name, provider_code, provider_name,
           unified_model_id, current_alias, historical_alias, request_status,
           MAX(created_at) AS used_at,
           ARRAY_AGG(DISTINCT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')) AS active_dates,
           ARRAY_AGG(DISTINCT usage_quality) AS qualities,
           SUM(raw_input_tokens)::text AS input_tokens,
           SUM(raw_output_tokens)::text AS output_tokens,
           SUM(raw_cache_tokens)::text AS cache_tokens,
           SUM(raw_reasoning_tokens)::text AS reasoning_tokens,
           (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
             WHEN COUNT(deducted_quota) FILTER (WHERE resource_mode = 'CODING_PLAN')
                = COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
             THEN COALESCE(SUM(deducted_quota) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)::numeric
             ELSE NULL END)::text AS deducted_quota,
           (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'API') = 0 THEN 0::numeric
             WHEN COUNT(api_cost) FILTER (WHERE resource_mode = 'API')
                = COUNT(*) FILTER (WHERE resource_mode = 'API')
             THEN COALESCE(SUM(api_cost) FILTER (WHERE resource_mode = 'API'), 0)::numeric
             ELSE NULL END)::text AS api_cost,
           (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
             WHEN COUNT(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN')
                = COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
             THEN COALESCE(SUM(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)::numeric
             ELSE NULL END)::text AS package_allocated_cost
      FROM line_facts
     WHERE TRUE ${factFilters(filter)}
     GROUP BY request_id, source_principal_id, source_principal_name, source_principal_type,
              project_id, project_name, project_owner_person_id, project_owner_name,
              project_department_id, project_department_name, provider_code, provider_name,
              unified_model_id, current_alias, historical_alias, request_status
  `;
}

function collapsedRequestFactsSql(): RawBuilder<unknown> {
  return sql`
    SELECT request_id,
           MIN(source_principal_id::text)::uuid AS source_principal_id,
           MIN(source_principal_name) AS source_principal_name,
           'EMPLOYEE'::text AS source_principal_type,
           MIN(project_id::text)::uuid AS project_id, MIN(project_name) AS project_name,
           MIN(project_owner_person_id::text)::uuid AS project_owner_person_id,
           MIN(project_owner_name) AS project_owner_name,
           MIN(project_department_id::text)::uuid AS project_department_id,
           MIN(project_department_name) AS project_department_name,
           MIN(provider_code) AS provider_code, MIN(provider_name) AS provider_name,
           MIN(unified_model_id::text)::uuid AS unified_model_id,
           MIN(current_alias) AS current_alias, MIN(historical_alias) AS historical_alias,
           MIN(request_status) AS request_status, MAX(used_at) AS used_at,
           ARRAY[to_char(MAX(used_at) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')] AS active_dates,
           string_to_array(STRING_AGG(array_to_string(qualities, ','), ','), ',') AS qualities,
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
      FROM request_provider_facts GROUP BY request_id
  `;
}

function mapFact(row: RawAccountFact): OperatingBillAccountFact {
  return {
    requestId: row.request_id,
    sourcePrincipalId: row.source_principal_id,
    sourcePrincipalName: row.source_principal_name,
    sourcePrincipalType: row.source_principal_type,
    projectId: row.project_id,
    projectName: row.project_name,
    ...mapRawProjectMetadata(row),
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

export async function loadLiveOperatingBillAccountFacts(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  filter: LiveAccountFactFilter = {},
): Promise<OperatingBillAccountFact[]> {
  const result = await sql<RawAccountFact>`
    WITH ${liveLineFactCtes(enterpriseId, month)}
    ${requestFactsSql(filter)}
  `.execute(db);
  return result.rows.map(mapFact);
}

function summaryTotals(row: RawSummary | undefined): OperatingBillAccountTotals {
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

export async function loadLiveOperatingBillAccountSummary(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  dimension: "EMPLOYEE" | "PROJECT",
  query: { providerCode?: string; search?: string; limit: number; offset: number },
): Promise<{ totals: OperatingBillAccountTotals; rows: OperatingBillAccountSubjectRow[]; total: number }> {
  const provider = query.providerCode ? sql` AND provider_code = ${query.providerCode}` : sql``;
  const needle = query.search?.trim();
  const search = needle ? sql` AND POSITION(lower(${needle}) IN lower(subject_name)) > 0` : sql``;
  const result = await sql<RawSummary>`
    WITH ${liveLineFactCtes(enterpriseId, month)}, dimension_lines AS (
      SELECT line_facts.*,
             CASE WHEN ${dimension} = 'EMPLOYEE' THEN source_principal_id
                  WHEN source_principal_type = 'PROJECT' THEN source_principal_id
                  ELSE project_id END AS subject_id,
             CASE WHEN ${dimension} = 'EMPLOYEE' THEN source_principal_name
                  WHEN source_principal_type = 'PROJECT' THEN source_principal_name
                  ELSE COALESCE(project_name, '未归属项目') END AS subject_name,
             CASE WHEN ${dimension} = 'PROJECT' AND source_principal_type = 'EMPLOYEE'
                       AND project_id IS NULL THEN TRUE ELSE FALSE END AS is_unassigned
        FROM line_facts
       WHERE ${dimension} <> 'EMPLOYEE' OR source_principal_type = 'EMPLOYEE'
    ), scoped_lines AS (
      SELECT * FROM dimension_lines WHERE TRUE ${provider}${search}
    ), summaries AS (
      SELECT CASE WHEN GROUPING(subject_name) = 1 THEN 'TOTAL'
                  WHEN GROUPING(provider_code) = 1 THEN 'SUBJECT' ELSE 'PROVIDER' END AS level,
             subject_id, subject_name, is_unassigned, provider_code, provider_name,
             ${projectMetadataSummarySql()},
             SUM(raw_input_tokens)::text AS input_tokens,
             SUM(raw_output_tokens)::text AS output_tokens,
             SUM(raw_cache_tokens)::text AS cache_tokens,
             SUM(raw_reasoning_tokens)::text AS reasoning_tokens,
             (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
               WHEN COUNT(deducted_quota) FILTER (WHERE resource_mode = 'CODING_PLAN')
                  = COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
               THEN COALESCE(SUM(deducted_quota) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)::numeric
               ELSE NULL END)::text AS deducted_quota,
             (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'API') = 0 THEN 0::numeric
               WHEN COUNT(api_cost) FILTER (WHERE resource_mode = 'API')
                  = COUNT(*) FILTER (WHERE resource_mode = 'API')
               THEN COALESCE(SUM(api_cost) FILTER (WHERE resource_mode = 'API'), 0)::numeric
               ELSE NULL END)::text AS api_cost,
             (CASE WHEN COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN') = 0 THEN 0::numeric
               WHEN COUNT(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN')
                  = COUNT(*) FILTER (WHERE resource_mode = 'CODING_PLAN')
               THEN COALESCE(SUM(package_line_cost) FILTER (WHERE resource_mode = 'CODING_PLAN'), 0)::numeric
               ELSE NULL END)::text AS package_allocated_cost,
             STRING_AGG(DISTINCT upper(usage_quality), ',' ORDER BY upper(usage_quality)) AS quality_signature,
             COUNT(DISTINCT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD'))::text AS active_days,
             COUNT(DISTINCT request_id)::text AS request_count,
             MAX(created_at) AS last_used_at
        FROM scoped_lines
       GROUP BY GROUPING SETS (
         (subject_id, subject_name, is_unassigned, provider_code, provider_name),
         (subject_id, subject_name, is_unassigned), ()
       )
    ), subject_page AS (
      SELECT subject_id, subject_name, is_unassigned
        FROM summaries WHERE level = 'SUBJECT'
       ORDER BY (CASE WHEN api_cost IS NULL OR package_allocated_cost IS NULL THEN NULL
                 ELSE api_cost::numeric + package_allocated_cost::numeric END) DESC NULLS LAST,
                subject_name ASC, COALESCE(subject_id::text, '') ASC
       LIMIT ${query.limit} OFFSET ${query.offset}
    ), subject_meta AS (
      SELECT COUNT(*)::text AS total_count FROM summaries WHERE level = 'SUBJECT'
    )
    SELECT summaries.*, subject_meta.total_count
      FROM summaries CROSS JOIN subject_meta
     WHERE summaries.level = 'TOTAL' OR EXISTS (
       SELECT 1 FROM subject_page page
        WHERE page.subject_id IS NOT DISTINCT FROM summaries.subject_id
          AND page.subject_name IS NOT DISTINCT FROM summaries.subject_name
          AND page.is_unassigned IS NOT DISTINCT FROM summaries.is_unassigned
     )
  `.execute(db);
  const subjects = new Map<string, OperatingBillAccountSubjectRow>();
  for (const row of result.rows.filter((item) => item.level === "SUBJECT")) {
    const key = row.subject_id ?? "__unassigned_project__";
    subjects.set(key, {
      subjectId: row.subject_id,
      subjectName: row.subject_name!,
      isUnassigned: row.is_unassigned ?? false,
      ...projectSummaryMetadata(row, dimension),
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

export async function loadLiveOperatingBillRequestPage(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  filter: Required<Pick<LiveAccountFactFilter, "principalId" | "unifiedModelId">>
    & Pick<LiveAccountFactFilter, "providerCode">,
  page: { limit: number; offset: number },
): Promise<{ facts: OperatingBillAccountFact[]; total: number; employeeName?: undefined }> {
  const result = await sql<RawPagedFact>`
    WITH ${liveLineFactCtes(enterpriseId, month)}, request_provider_facts AS (
      ${requestFactsSql(filter)}
    ), request_facts AS (
      ${collapsedRequestFactsSql()}
    ), counted AS (
      SELECT request_facts.*, COUNT(*) OVER()::text AS window_total FROM request_facts
    ), page AS (
      SELECT * FROM counted
       ORDER BY used_at DESC, request_id DESC
       LIMIT ${page.limit} OFFSET ${page.offset}
    ), meta AS (
      SELECT COUNT(*)::text AS total_count FROM request_facts
    )
    SELECT page.*, meta.total_count
      FROM meta LEFT JOIN page ON TRUE
     ORDER BY page.used_at DESC, page.request_id DESC
  `.execute(db);
  const rows = result.rows.filter((row) => row.request_id !== null);
  return {
    facts: rows.map((row) => mapFact(row)),
    total: Number(rows[0]?.window_total ?? result.rows[0]?.total_count ?? 0),
  };
}
