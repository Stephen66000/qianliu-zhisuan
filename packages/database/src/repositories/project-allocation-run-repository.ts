/**
 * 项目归集计算执行仓储（候选 C3 合同 §5；计划 v1.2 §8.1）。
 * 源行来自共享成本 CTE（liveLineFactCtes 行级证据列）；规则/参与/核算取当前
 * is_current 快照并固化 digest；发布原子（SUCCEEDED+is_current 同事务切换，
 * 先关旧 current）；守恒失败不发布部分结果；资源级套餐余量另表。
 */
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  allocateMonth, type AllocationSourceLine, type ConservationReport,
  type EmployeeAllocationContext, type EmployeeRuleSegment, type MonthAllocationResult,
} from "@qianliu/domain";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { liveLineFactCtes } from "./operating-bill-account-month-lines.js";

export const ALLOCATION_SCHEMA_VERSION = "1";
export const ALLOCATION_ALGORITHM_VERSION = "1";
const RUN_LEASE_MS = 5 * 60_000;

/** 北京自然月的首日（date 列值）。校验复用经营账月份口径，避免 UTC 偏移错日。 */
const monthDate = (month: string): string => {
  operatingBillMonthRange(month);
  return `${month}-01`;
};
const MAX_RUN_FAILURES = 3;

export interface SourceLineRow {
  ledger_line_id: string;
  request_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string | null;
  unified_model_id: string | null;
  request_started_at: Date;
  accounted_at: Date;
  source_principal_id: string;
  source_principal_type: string;
  manual_project_id: string | null;
  raw_input_tokens: string;
  raw_output_tokens: string;
  raw_cache_tokens: string;
  raw_reasoning_tokens: string;
  api_cost: string | null;
  api_cost_currency: string | null;
  package_line_cost: string | null;
  usage_quality: string;
  resource_mode: string;
}

/** 装载某账期源行集合（固定输入快照由调用方在同一事务内使用）。 */
export async function loadAllocationSourceLines(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
): Promise<AllocationSourceLine[]> {
  const { rows } = await sql<SourceLineRow>`
    WITH ${liveLineFactCtes(enterpriseId, month)}
    SELECT ledger_line_id, request_id, upstream_attempt_id, provider_resource_id, unified_model_id,
           request_started_at, accounted_at,
           source_principal_id, source_principal_type, manual_project_id,
           raw_input_tokens, raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens,
           api_cost, api_cost_currency, package_line_cost, usage_quality, resource_mode
    FROM line_facts
    ORDER BY ledger_line_id`.execute(db);
  return rows.map((row) => ({
    ledgerLineId: row.ledger_line_id,
    aiRequestId: row.request_id,
    upstreamAttemptId: row.upstream_attempt_id,
    providerResourceId: row.provider_resource_id,
    unifiedModelId: row.unified_model_id,
    requestStartedAt: row.request_started_at,
    accountedAt: row.accounted_at,
    sourcePrincipalId: row.source_principal_id,
    sourcePrincipalType: row.source_principal_type === "PROJECT" ? "PROJECT" : "EMPLOYEE",
    manualProjectId: row.manual_project_id,
    inputTokens: BigInt(row.raw_input_tokens),
    outputTokens: BigInt(row.raw_output_tokens),
    cacheTokens: row.raw_cache_tokens === null ? null : BigInt(row.raw_cache_tokens),
    reasoningTokens: row.raw_reasoning_tokens === null ? null : BigInt(row.raw_reasoning_tokens),
    apiCost: row.api_cost,
    apiCostCurrency: row.api_cost_currency,
    packageCost: row.package_line_cost,
    usageQuality: row.usage_quality,
    resourceMode: row.resource_mode,
  }));
}

interface RuleRow {
  employee_principal_id: string;
  policy_id: string;
  membership_id: string;
  membership_revision_id: string;
  project_principal_id: string;
  weight_bps: number;
  valid_from: Date;
  valid_until: Date | null;
}

/** 装载员工级分配上下文（当前 is_current 规则 + ACTIVE 参与 + 当前核算窗口）。 */
export async function loadAllocationContexts(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<{ contextsByEmployee: Map<string, EmployeeAllocationContext>; ruleDigest: string; membershipDigest: string }> {
  const { rows: rules } = await sql<RuleRow>`
    SELECT ru.employee_principal_id, ru.policy_id, ru.membership_id, ru.membership_revision_id,
           ru.project_principal_id, ru.weight_bps::int AS weight_bps, ru.valid_from, ru.valid_until
    FROM employee_project_allocation_rule ru
    JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
    WHERE pol.enterprise_id = ${enterpriseId} AND pol.is_current
    ORDER BY ru.employee_principal_id, ru.valid_from`.execute(db);
  const { rows: memberships } = await sql<{
    employee_principal_id: string; membership_id: string; project_principal_id: string;
    joined_at: Date; left_at: Date | null;
  }>`
    SELECT m.employee_principal_id, r.membership_id, r.project_principal_id, r.joined_at, r.left_at
    FROM project_membership_revision r
    JOIN project_membership m ON m.id = r.membership_id
    WHERE r.enterprise_id = ${enterpriseId} AND r.status = 'ACTIVE'
    ORDER BY r.joined_at`.execute(db);
  const { rows: accounting } = await sql<{
    project_principal_id: string; started_at: Date; ended_at: Date | null;
  }>`
    SELECT project_principal_id, accounting_started_at AS started_at, accounting_ended_at AS ended_at
    FROM project_accounting_profile_version
    WHERE enterprise_id = ${enterpriseId} AND is_current`.execute(db);

  const contextsByEmployee = new Map<string, EmployeeAllocationContext>();
  const ensure = (employeeId: string): EmployeeAllocationContext => {
    let context = contextsByEmployee.get(employeeId);
    if (!context) {
      context = { employeePrincipalId: employeeId, segments: [], memberships: [], accountingByProject: new Map() };
      contextsByEmployee.set(employeeId, context);
    }
    return context;
  };
  for (const rule of rules) {
    const segment: EmployeeRuleSegment = {
      policyId: rule.policy_id,
      membershipId: rule.membership_id,
      membershipRevisionId: rule.membership_revision_id,
      projectPrincipalId: rule.project_principal_id,
      weightBps: rule.weight_bps,
      validFrom: rule.valid_from,
      validUntil: rule.valid_until,
    };
    ensure(rule.employee_principal_id).segments.push(segment);
  }
  for (const membership of memberships) {
    ensure(membership.employee_principal_id).memberships.push({
      membershipId: membership.membership_id,
      projectPrincipalId: membership.project_principal_id,
      joinedAt: membership.joined_at,
      leftAt: membership.left_at,
    });
  }
  // 核算窗口按项目全局生效（所有员工的上下文共享同一窗口集合）。
  for (const context of contextsByEmployee.values()) {
    for (const row of accounting) {
      context.accountingByProject.set(row.project_principal_id, { startedAt: row.started_at, endedAt: row.ended_at });
    }
  }
  const digest = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    contextsByEmployee,
    ruleDigest: digest(rules.map((rule) => [
      rule.policy_id, rule.membership_revision_id, rule.project_principal_id, rule.weight_bps,
      rule.valid_from.toISOString(), rule.valid_until?.toISOString() ?? null,
    ])),
    membershipDigest: digest(memberships.map((m) => [
      m.membership_id, m.project_principal_id,
      m.joined_at.toISOString(), m.left_at?.toISOString() ?? null,
    ])),
  };
}

export interface EnableAllocationInput {
  enterpriseId: string;
  startMonth: string;
  actorAdminId: string;
}

/** 启用登记：插入启用行（幂等）并同事务登记初始化 QUEUED 批次（合同 §5.2）。 */
export async function enableProjectAllocation(
  db: Kysely<Database>,
  input: EnableAllocationInput,
): Promise<{ enabled: boolean; runId: string | null; alreadyActive: boolean }> {
  const start = monthDate(input.startMonth);
  return db.transaction().execute(async (tx) => {
    const inserted = await tx.insertInto("project_allocation_period")
      .values({
        enterprise_id: input.enterpriseId,
        period_month: start,
        enabled_by: input.actorAdminId,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning(["period_month"])
      .executeTakeFirst();
    const active = await tx.selectFrom("project_allocation_run")
      .select(["id", "status"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("period_month", "=", start)
      .where("status", "in", ["QUEUED", "RUNNING"])
      .executeTakeFirst();
    if (active) return { enabled: false, runId: active.id, alreadyActive: false };
    // 先 upsert 脏行并读取当前代次，初始化批次捕获同代次（完成后可正确消费 dirty）。
    const dirtyRow = await tx.insertInto("project_allocation_dirty")
      .values({ enterprise_id: input.enterpriseId, period_month: start, generation: 1, dirty: true })
      .onConflict((conflict) => conflict.column("enterprise_id").column("period_month")
        .doUpdateSet({ dirty: true, last_marked_at: new Date() }))
      .returning(["generation"])
      .executeTakeFirst();
    const generation = dirtyRow?.generation ?? 1;
    const run = await tx.insertInto("project_allocation_run")
      .values({
        enterprise_id: input.enterpriseId,
        period_month: start,
        schema_version: ALLOCATION_SCHEMA_VERSION,
        algorithm_version: ALLOCATION_ALGORITHM_VERSION,
        status: "QUEUED",
        generation,
        input_dirty_generation: generation,
        actor_type: "ADMIN",
        actor_admin_id: input.actorAdminId,
        updated_at: new Date(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { enabled: inserted !== undefined, runId: run.id, alreadyActive: false };
  });
}

export interface EnqueueRunResult {
  runId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  created: boolean;
}

/**
 * 登记批次：已有活动任务直接返回；当前结果未过期则幂等返回；
 * 否则创建 QUEUED（捕获当前 dirty 代次，单活动任务由部分唯一索引兜底）。
 */
export async function enqueueAllocationRun(
  db: Kysely<Database>,
  params: { enterpriseId: string; month: string; actorType: "SYSTEM" | "ADMIN"; actorAdminId: string | null },
): Promise<EnqueueRunResult> {
  const start = monthDate(params.month);
  return db.transaction().execute(async (tx) => {
    const active = await tx.selectFrom("project_allocation_run")
      .select(["id", "status"])
      .where("enterprise_id", "=", params.enterpriseId)
      .where("period_month", "=", start)
      .where("status", "in", ["QUEUED", "RUNNING"])
      .executeTakeFirst();
    if (active) return { runId: active.id, status: active.status as "QUEUED" | "RUNNING", created: false };

    const dirty = await tx.selectFrom("project_allocation_dirty")
      .select(["generation"])
      .where("enterprise_id", "=", params.enterpriseId)
      .where("period_month", "=", start)
      .executeTakeFirst();
    const current = await tx.selectFrom("project_allocation_run")
      .select(["id", "status", "input_dirty_generation"])
      .where("enterprise_id", "=", params.enterpriseId)
      .where("period_month", "=", start)
      .where("is_current", "=", true)
      .executeTakeFirst();
    const generation = dirty?.generation ?? 0;
    if (current && current.status === "SUCCEEDED"
      && (current.input_dirty_generation ?? 0) >= generation) {
      return { runId: current.id, status: "SUCCEEDED", created: false };
    }
    const run = await tx.insertInto("project_allocation_run")
      .values({
        enterprise_id: params.enterpriseId,
        period_month: start,
        schema_version: ALLOCATION_SCHEMA_VERSION,
        algorithm_version: ALLOCATION_ALGORITHM_VERSION,
        status: "QUEUED",
        generation,
        input_dirty_generation: generation,
        actor_type: params.actorType,
        actor_admin_id: params.actorAdminId,
        updated_at: new Date(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { runId: run.id, status: "QUEUED", created: true };
  });
}

interface ClaimedRun {
  id: string;
  enterprise_id: string;
  period_month: string;
  attempt: number;
}

/** 认领到期批次（FOR UPDATE SKIP LOCKED + 租约）；无任务返回 null。 */
export async function claimNextAllocationRun(
  db: Kysely<Database>,
  leaseOwner: string,
): Promise<ClaimedRun | null> {
  return db.transaction().execute(async (tx) => {
    const { rows } = await sql<ClaimedRun & { lease_owner: string | null; lease_expires_at: Date | null; status: string }>`
      SELECT id, enterprise_id, period_month::text AS period_month, attempt, lease_owner, lease_expires_at, status
      FROM project_allocation_run
      WHERE status = 'QUEUED'
         OR (status = 'RUNNING' AND lease_expires_at < now())
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED`.execute(tx);
    const row = rows[0];
    if (row === undefined) return null;
    const attempt = row.attempt + 1;
    await tx.updateTable("project_allocation_run")
      .set({
        status: "RUNNING",
        attempt,
        lease_owner: leaseOwner,
        lease_expires_at: new Date(Date.now() + RUN_LEASE_MS),
        started_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    return { id: row.id, enterprise_id: row.enterprise_id, period_month: row.period_month, attempt };
  });
}


const ZERO_TARGET = "00000000-0000-0000-0000-000000000000";

/** 单条份额行 → line 表插入值（源行缺失时按未知证据兜底，不由计算路径伪造）。 */
function lineInsertValues(
  run: ClaimedRun,
  share: LineShareView,
  source?: AllocationSourceLine,
) {
  return {
    run_id: run.id,
    enterprise_id: run.enterprise_id,
    ledger_line_id: share.ledgerLineId,
    ai_request_id: share.aiRequestId,
    upstream_attempt_id: source?.upstreamAttemptId ?? "",
    provider_resource_id: source?.providerResourceId ?? null,
    unified_model_id: source?.unifiedModelId ?? null,
    request_started_at: share.requestStartedAt,
    accounted_at: share.accountedAt,
    source_principal_id: share.sourcePrincipalId,
    target_type: share.source === "UNALLOCATED" ? "UNALLOCATED" : "PROJECT",
    target_project_principal_id: share.targetProjectPrincipalId ?? ZERO_TARGET,
    allocation_source: share.source,
    weight_bps: share.weightBps,
    policy_id: share.policyId,
    membership_id: share.membershipId,
    membership_revision_id: share.membershipRevisionId,
    segment_from: share.segmentFrom,
    segment_until: share.segmentUntil,
    unallocated_reason: share.unallocatedReason,
    source_input_tokens: source?.inputTokens ?? 0n,
    source_output_tokens: source?.outputTokens ?? 0n,
    source_cache_tokens: source?.cacheTokens ?? null,
    source_reasoning_tokens: source?.reasoningTokens ?? null,
    share_input_tokens: share.shareInputTokens,
    share_output_tokens: share.shareOutputTokens,
    share_cache_tokens: share.shareCacheTokens,
    share_reasoning_tokens: share.shareReasoningTokens,
    source_api_cost: source?.apiCost ?? null,
    share_api_cost: share.shareApiCost,
    api_cost_currency: source?.apiCostCurrency ?? null,
    source_package_cost: source?.packageCost ?? null,
    share_package_cost: share.sharePackageCost,
    usage_quality: source?.usageQuality ?? "UNKNOWN",
    resource_mode: source?.resourceMode ?? "API",
  } as const;
}

type LineShareView = MonthAllocationResult["shares"][number];

export interface ExecuteRunResult {
  runId: string;
  status: "SUCCEEDED" | "FAILED";
  conservation: ConservationReport | null;
  error: string | null;
}

/**
 * 执行一个批次：装载输入 → 领域分配 → 守恒校验 → 原子发布（先关旧 current，
 * 再 SUCCEEDED+is_current；同批次幂等由部分唯一索引兜底）。失败不发布部分结果。
 */
export async function executeAllocationRun(
  db: Kysely<Database>,
  run: ClaimedRun,
): Promise<ExecuteRunResult> {
  try {
    const month = run.period_month.slice(0, 7);
    const started = Date.now();
    const [lines, { contextsByEmployee, ruleDigest, membershipDigest }] = await Promise.all([
      loadAllocationSourceLines(db, run.enterprise_id, month),
      loadAllocationContexts(db, run.enterprise_id),
    ]);
    const { rows: assignmentRows } = await sql<{ digest: string }>`
      SELECT md5(string_agg(ai_request_id::text || ':' || project_principal_id::text, ',' ORDER BY ai_request_id)) AS digest
      FROM operating_bill_request_project_assignment
      WHERE enterprise_id = ${run.enterprise_id}`.execute(db);
    const manualDigest = assignmentRows[0]?.digest ?? "none";
    const inputDigest = createHash("sha256")
      .update(JSON.stringify([run.period_month, lines.length, ruleDigest, membershipDigest, manualDigest]))
      .digest("hex");

    const { rows: enablement } = await sql<{ earliest: string | null }>`
      SELECT MIN(period_month)::text AS earliest FROM project_allocation_period
      WHERE enterprise_id = ${run.enterprise_id}`.execute(db);
    const earliest = enablement[0]?.earliest ?? null;
    const historicalCutoff = earliest === null ? null : operatingBillMonthRange(earliest.slice(0, 7)).start;

    const lineById = new Map(lines.map((line) => [line.ledgerLineId, line]));
    const result = allocateMonth({
      lines,
      contextsByEmployee,
      historicalCutoff,
    });
    if (result.conservation.violations.length > 0) {
      throw new Error(`conservation violations: ${result.conservation.violations.join("; ")}`);
    }

    const employees = new Set(lines.map((line) => line.sourcePrincipalId));
    const projects = new Set(result.shares
      .map((share) => share.targetProjectPrincipalId)
      .filter((id): id is string => id !== null));
    const resultHash = createHash("sha256")
      .update(JSON.stringify(result.conservation))
      .digest("hex");

    await db.transaction().execute(async (tx) => {
      // 同输入+同算法幂等：已发布则直接返回成功（不重复发布）。
      const existing = await tx.selectFrom("project_allocation_run")
        .select(["id"])
        .where("enterprise_id", "=", run.enterprise_id)
        .where("period_month", "=", run.period_month.slice(0, 10))
        .where("input_digest", "=", inputDigest)
        .where("algorithm_version", "=", ALLOCATION_ALGORITHM_VERSION)
        .where("status", "=", "SUCCEEDED")
        .executeTakeFirst();

      if (!existing) {
        for (const share of result.shares) {
          const source = lineById.get(share.ledgerLineId);
          await tx.insertInto("project_allocation_line")
            .values(lineInsertValues(run, share, source))
            .execute();
        }
        // 先关旧 current，再发布新批次（部分唯一索引窗口要求）。
        const previous = await tx.selectFrom("project_allocation_run")
          .select(["id"])
          .where("enterprise_id", "=", run.enterprise_id)
          .where("period_month", "=", run.period_month.slice(0, 10))
          .where("is_current", "=", true)
          .executeTakeFirst();
        if (previous && previous.id !== run.id) {
          await tx.updateTable("project_allocation_run")
            .set({ is_current: false })
            .where("id", "=", previous.id)
            .execute();
        }
        await tx.updateTable("project_allocation_run")
          .set({
            status: "SUCCEEDED",
            is_current: true,
            input_digest: inputDigest,
            rule_input_digest: ruleDigest,
            membership_input_digest: membershipDigest,
            manual_attribution_input_digest: manualDigest,
            source_fact_digest: inputDigest,
            source_snapshot_as_of: new Date(),
            source_line_count: lines.length,
            employee_count: employees.size,
            project_count: projects.size,
            conservation: result.conservation as unknown as Record<string, unknown>,
            completeness: {
              unknownApiCostLineCount: result.conservation.source.unknownApiCostLineCount,
              unknownPackageCostLineCount: result.conservation.source.unknownPackageCostLineCount,
            },
            result_hash: resultHash,
            finished_at: new Date(),
            duration_ms: Date.now() - started,
            updated_at: new Date(),
          })
          .where("id", "=", run.id)
          .execute();
      } else {
        await tx.updateTable("project_allocation_run")
          .set({
            status: "SUCCEEDED",
            input_digest: inputDigest,
            finished_at: new Date(),
            duration_ms: Date.now() - started,
            updated_at: new Date(),
          })
          .where("id", "=", run.id)
          .execute();
      }

      // 消费脏代次：未前进则清除 dirty；前进则保留（由调度再登记补算）。
      const dirty = await tx.selectFrom("project_allocation_dirty")
        .select(["generation"])
        .where("enterprise_id", "=", run.enterprise_id)
        .where("period_month", "=", run.period_month.slice(0, 10))
        .executeTakeFirst();
      const captured = await tx.selectFrom("project_allocation_run")
        .select(["input_dirty_generation"])
        .where("id", "=", run.id)
        .executeTakeFirst();
      if (dirty && captured && dirty.generation <= (captured.input_dirty_generation ?? 0)) {
        await tx.updateTable("project_allocation_dirty")
          .set({ dirty: false })
          .where("enterprise_id", "=", run.enterprise_id)
          .where("period_month", "=", run.period_month.slice(0, 10))
          .execute();
      }
    });
    return { runId: run.id, status: "SUCCEEDED", conservation: result.conservation, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 状态只进不退（触发器约束）：可重试失败保留 RUNNING 并把租约设为退避到期，
    // 由 claim 的"租约过期回收"路径重新认领；达到上限才转终态 FAILED。
    await db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom("project_allocation_run")
        .select(["attempt"])
        .where("id", "=", run.id)
        .executeTakeFirst();
      const attempt = row?.attempt ?? run.attempt;
      if (attempt >= MAX_RUN_FAILURES) {
        await tx.updateTable("project_allocation_run")
          .set({ status: "FAILED", last_error: message.slice(0, 2000), finished_at: new Date(), updated_at: new Date() })
          .where("id", "=", run.id)
          .execute();
      } else {
        const backoffMs = Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 3600_000);
        await tx.updateTable("project_allocation_run")
          .set({
            last_error: message.slice(0, 2000),
            lease_expires_at: new Date(Date.now() - backoffMs),
            updated_at: new Date(),
          })
          .where("id", "=", run.id)
          .execute();
      }
    });
    return { runId: run.id, status: "FAILED", conservation: null, error: message };
  }
}

/** Worker 入口：认领并执行所有到期批次。 */
export async function runDueAllocationRuns(
  db: Kysely<Database>,
  leaseOwner: string,
): Promise<ExecuteRunResult[]> {
  const results: ExecuteRunResult[] = [];
  for (let i = 0; i < 10; i += 1) {
    const claimed = await claimNextAllocationRun(db, leaseOwner);
    if (claimed === null) break;
    results.push(await executeAllocationRun(db, claimed));
  }
  return results;
}
