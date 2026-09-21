/**
 * 项目归集读模型（候选 C3 合同 §7；WP05）。
 * 全部固定 run 读取（当前或指定）；陈旧度由 dirty 代次推导（不改写 run）；
 * 涉及请求数按目标内 request 去重，跨项目不可相加。
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";

export interface AllocationRunStatus {
  enabled: boolean;
  currentRun: {
    id: string;
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
    computedAt: string | null;
    stale: boolean;
    inputDigest: string | null;
    completeness: { unknownApiCostLineCount?: number; unknownPackageCostLineCount?: number } | null;
  } | null;
  lastError: string | null;
}

function monthFirstDay(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("invalid month");
  return `${month}-01`;
}

/** 计算状态（GET 纯读）：stale = dirty.generation > run.input_dirty_generation。 */
export async function getAllocationRunStatus(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
): Promise<AllocationRunStatus> {
  const day = monthFirstDay(month);
  // 启用按"起始账期"语义：任何 ≤ 目标月的启用记录都视为该月已启用。
  const { rows: enableRows } = await sql<{ enabled_at: Date }>`
    SELECT enabled_at FROM project_allocation_period
    WHERE enterprise_id = ${enterpriseId} AND period_month <= ${day}::date
    LIMIT 1`.execute(db);
  const anyEnable = enableRows[0];

  const run = await db.selectFrom("project_allocation_run")
    .select(["id", "status", "finished_at", "input_dirty_generation", "input_digest", "completeness", "last_error"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", day)
    .where("is_current", "=", true)
    .executeTakeFirst();
  const dirty = await db.selectFrom("project_allocation_dirty")
    .select(["generation"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", day)
    .executeTakeFirst();

  return {
    enabled: anyEnable !== undefined,
    currentRun: run === undefined ? null : {
      id: run.id,
      status: run.status,
      computedAt: run.finished_at?.toISOString() ?? null,
      stale: dirty !== undefined && (run.input_dirty_generation ?? 0) < dirty.generation,
      inputDigest: run.input_digest,
      completeness: run.completeness as { unknownApiCostLineCount?: number; unknownPackageCostLineCount?: number } | null,
    },
    lastError: run?.last_error ?? null,
  };
}

export interface ProjectAllocationSummary {
  projectPrincipalId: string;
  runId: string;
  totalTokens: string;
  directTokens: string;
  manualTokens: string;
  ruleTokens: string;
  apiCostByCurrency: Record<string, string>;
  packageCostCny: string;
  involvedRequestCount: number;
  unallocatedReasons: Record<string, number> | null;
}

/** 项目维度汇总（当前 run）：来源拆分 + 涉及请求数（目标内去重）。 */
export async function listProjectAllocationSummaries(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
): Promise<{ runId: string | null; summaries: Map<string, ProjectAllocationSummary> }> {
  const day = monthFirstDay(month);
  const run = await db.selectFrom("project_allocation_run")
    .select(["id"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", day)
    .where("is_current", "=", true)
    .where("status", "=", "SUCCEEDED")
    .executeTakeFirst();
  if (run === undefined) return { runId: null, summaries: new Map() };

  const { rows } = await sql<{
    project_principal_id: string;
    total_tokens: string;
    direct_tokens: string;
    manual_tokens: string;
    rule_tokens: string;
    api_cost_cny: string | null;
    api_cost_usd: string | null;
    package_cost_cny: string | null;
    involved_requests: number;
  }>`
    SELECT target_project_principal_id::text AS project_principal_id,
           SUM(share_input_tokens + share_output_tokens)::text AS total_tokens,
           SUM(CASE WHEN allocation_source = 'PROJECT_DIRECT' THEN share_input_tokens + share_output_tokens ELSE 0 END)::text AS direct_tokens,
           SUM(CASE WHEN allocation_source = 'MANUAL_ASSIGNMENT' THEN share_input_tokens + share_output_tokens ELSE 0 END)::text AS manual_tokens,
           SUM(CASE WHEN allocation_source = 'MEMBERSHIP_RULE' THEN share_input_tokens + share_output_tokens ELSE 0 END)::text AS rule_tokens,
           SUM(CASE WHEN api_cost_currency = 'CNY' THEN share_api_cost ELSE 0 END)::text AS api_cost_cny,
           SUM(CASE WHEN api_cost_currency = 'USD' THEN share_api_cost ELSE 0 END)::text AS api_cost_usd,
           SUM(share_package_cost)::text AS package_cost_cny,
           COUNT(DISTINCT ai_request_id)::int AS involved_requests
    FROM project_allocation_line
    WHERE run_id = ${run.id} AND target_type = 'PROJECT'
    GROUP BY target_project_principal_id`.execute(db);

  const summaries = new Map<string, ProjectAllocationSummary>();
  for (const row of rows) {
    summaries.set(row.project_principal_id, {
      projectPrincipalId: row.project_principal_id,
      runId: run.id,
      totalTokens: row.total_tokens,
      directTokens: row.direct_tokens,
      manualTokens: row.manual_tokens,
      ruleTokens: row.rule_tokens,
      apiCostByCurrency: {
        ...(row.api_cost_cny !== null ? { CNY: row.api_cost_cny } : {}),
        ...(row.api_cost_usd !== null ? { USD: row.api_cost_usd } : {}),
      },
      packageCostCny: row.package_cost_cny ?? "0",
      involvedRequestCount: row.involved_requests,
      unallocatedReasons: null,
    });
  }
  return { runId: run.id, summaries };
}

export interface UnallocatedSummary {
  runId: string | null;
  tokens: string;
  byReason: Record<string, string>;
  apiCostByCurrency: Record<string, string>;
  packageCostCny: string;
  lineCount: number;
  resourceResidual: Array<{ providerResourceId: string; amount: string; currency: "CNY"; note: string | null }>;
}

export async function getUnallocatedSummary(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
): Promise<UnallocatedSummary> {
  const day = monthFirstDay(month);
  const run = await db.selectFrom("project_allocation_run")
    .select(["id"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", day)
    .where("is_current", "=", true)
    .where("status", "=", "SUCCEEDED")
    .executeTakeFirst();
  if (run === undefined) {
    return { runId: null, tokens: "0", byReason: {}, apiCostByCurrency: {}, packageCostCny: "0", lineCount: 0, resourceResidual: [] };
  }
  const { rows } = await sql<{
    tokens: string; reason: string; cny: string | null; usd: string | null; package_cny: string | null; n: number;
  }>`
    SELECT SUM(share_input_tokens + share_output_tokens)::text AS tokens,
           COALESCE(unallocated_reason, 'UNKNOWN') AS reason,
           SUM(CASE WHEN api_cost_currency = 'CNY' THEN share_api_cost ELSE 0 END)::text AS cny,
           SUM(CASE WHEN api_cost_currency = 'USD' THEN share_api_cost ELSE 0 END)::text AS usd,
           SUM(share_package_cost)::text AS package_cny,
           COUNT(*)::int AS n
    FROM project_allocation_line
    WHERE run_id = ${run.id} AND target_type = 'UNALLOCATED'
    GROUP BY unallocated_reason`.execute(db);
  const residual = await db.selectFrom("project_allocation_resource_residual")
    .select(["provider_resource_id", "amount", "note"])
    .where("run_id", "=", run.id)
    .execute();

  const byReason: Record<string, string> = {};
  const apiCost: Record<string, string> = {};
  let tokens = "0";
  let packageCny = "0";
  let lineCount = 0;
  for (const row of rows) {
    byReason[row.reason] = row.tokens;
    tokens = addDecimal(tokens, row.tokens);
    packageCny = addDecimal(packageCny, row.package_cny ?? "0");
    if (row.cny !== null) apiCost.CNY = addDecimal(apiCost.CNY ?? "0", row.cny);
    if (row.usd !== null) apiCost.USD = addDecimal(apiCost.USD ?? "0", row.usd);
    lineCount += row.n;
  }
  return {
    runId: run.id,
    tokens,
    byReason,
    apiCostByCurrency: apiCost,
    packageCostCny: packageCny,
    lineCount,
    resourceResidual: residual.map((r) => ({
      providerResourceId: r.provider_resource_id,
      amount: r.amount,
      currency: "CNY" as const,
      note: r.note,
    })),
  };
}

function addDecimal(left: string, right: string): string {
  const [aInt, aFrac = ""] = left.split(".");
  const [bInt, bFrac = ""] = right.split(".");
  const scale = Math.max(aFrac.length, bFrac.length);
  const a = BigInt(aInt + aFrac.padEnd(scale, "0"));
  const b = BigInt(bInt + bFrac.padEnd(scale, "0"));
  const sum = (a + b).toString().padStart(scale + 1, "0");
  return scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`;
}

export interface AllocationLineRow {
  ledgerLineId: string;
  requestId: string;
  upstreamAttemptId: string;
  sourcePrincipalId: string;
  employeeName: string | null;
  allocationSource: string;
  weightBps: number | null;
  requestStartedAt: string;
  accountedAt: string;
  sourceInputTokens: string;
  sourceOutputTokens: string;
  shareInputTokens: string;
  shareOutputTokens: string;
  ratio: number | null;
  sourceApiCost: string | null;
  shareApiCost: string | null;
  apiCostCurrency: string | null;
  sourcePackageCost: string | null;
  sharePackageCost: string | null;
  usageQuality: string;
}

/** 项目明细（固定当前 run；分页稳定排序 ledger_line_id）。 */
export async function listAllocationLines(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  projectId: string,
  params: { runId?: string; employeeId?: string; source?: string; limit: number; offset: number },
): Promise<{ runId: string | null; lines: AllocationLineRow[]; total: number; limit: number; offset: number }> {
  const day = monthFirstDay(month);
  const runId = params.runId ?? (await db.selectFrom("project_allocation_run")
    .select(["id"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", day)
    .where("is_current", "=", true)
    .where("status", "=", "SUCCEEDED")
    .executeTakeFirst())?.id ?? null;
  if (runId === null) return { runId: null, lines: [], total: 0, limit: params.limit, offset: params.offset };

  const { rows } = await sql<AllocationLineRow & { total: number }>`
    SELECT l.ledger_line_id::text AS "ledgerLineId",
           l.ai_request_id::text AS "requestId",
           l.upstream_attempt_id::text AS "upstreamAttemptId",
           l.source_principal_id::text AS "sourcePrincipalId",
           emp.name AS "employeeName",
           l.allocation_source::text AS "allocationSource",
           l.weight_bps::int AS "weightBps",
           l.request_started_at::text AS "requestStartedAt",
           l.accounted_at::text AS "accountedAt",
           l.source_input_tokens::text AS "sourceInputTokens",
           l.source_output_tokens::text AS "sourceOutputTokens",
           l.share_input_tokens::text AS "shareInputTokens",
           l.share_output_tokens::text AS "shareOutputTokens",
           CASE WHEN l.allocation_source = 'MEMBERSHIP_RULE' THEN l.weight_bps END AS ratio,
           l.source_api_cost::text AS "sourceApiCost",
           l.share_api_cost::text AS "shareApiCost",
           l.api_cost_currency AS "apiCostCurrency",
           l.source_package_cost::text AS "sourcePackageCost",
           l.share_package_cost::text AS "sharePackageCost",
           l.usage_quality AS "usageQuality",
           COUNT(*) OVER ()::int AS total
    FROM project_allocation_line l
    LEFT JOIN principal emp ON emp.id = l.source_principal_id AND emp.enterprise_id = l.enterprise_id
    WHERE l.run_id = ${runId}
      AND l.enterprise_id = ${enterpriseId}
      AND (l.target_type = 'UNALLOCATED' OR l.target_project_principal_id = ${projectId}::uuid)
      AND (${params.employeeId ?? null}::uuid IS NULL OR l.source_principal_id = ${params.employeeId ?? null}::uuid)
      AND (${params.source ?? null}::text IS NULL OR l.allocation_source = ${params.source ?? null}::text)
    ORDER BY l.ledger_line_id
    LIMIT ${params.limit} OFFSET ${params.offset}`.execute(db);
  const total = rows[0]?.total ?? 0;
  const lines = rows.map(({ total: _total, ...rest }) => rest);
  return { runId, lines, total, limit: params.limit, offset: params.offset };
}
