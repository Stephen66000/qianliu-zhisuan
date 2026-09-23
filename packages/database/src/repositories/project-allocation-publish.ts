/**
 * 批次发布（80 终审 P1-3 拆分）：份额行写入、资源余量、幂等命中判定（no-op 或
 * 重发布为 current）、关旧 current 与发布更新。由 executeAllocationRun 在发布事务内调用。
 */
import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import type { AllocationSourceLine, MonthAllocationResult } from "@qianliu/domain";
import { ALLOCATION_ALGORITHM_VERSION } from "./project-allocation-common.js";

const ZERO_TARGET = "00000000-0000-0000-0000-000000000000";

type LineShareView = MonthAllocationResult["shares"][number];

/** 单条份额行 → line 表插入值（源行缺失时按未知证据兜底，不由计算路径伪造）。 */
function lineInsertValues(
  run: { id: string; enterprise_id: string },
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

export interface PublishRunContext {
  run: { id: string; enterprise_id: string; period_month: string };
  inputDigest: string;
  ruleDigest: string;
  membershipDigest: string;
  manualDigest: string;
  result: MonthAllocationResult;
  lineById: Map<string, AllocationSourceLine>;
  monthRange: { start: Date; end: Date };
  financeEnabled: boolean;
  employees: Set<string>;
  projects: Set<string>;
  resultHash: string;
  started: number;
  lines: AllocationSourceLine[];
}

export async function publishOrNoopRun(tx: Transaction<Database>, context: PublishRunContext): Promise<void> {
  const {
    run, inputDigest, ruleDigest, membershipDigest, manualDigest, result, lineById,
    monthRange, financeEnabled, employees, projects, resultHash, started, lines,
  } = context;
  // 不变量：current 批次永远反映当前输入状态。
  // 同输入+同算法幂等只在"命中批次就是 current"时成立（该输入状态的当前发布已存在，
  // 无需重复发布）；命中**非 current 的历史批次**意味着输入回到了某个历史状态
  // （如人工指定 A→B→A），此时必须确定性重发布为 current——幂等索引已限定为
  // current 维度（R03 P1 合同修订），因此同摘要重发布合法，且不依赖"认出旧状态"。
  const existing = await tx.selectFrom("project_allocation_run")
    .select(["id"])
    .where("enterprise_id", "=", run.enterprise_id)
    .where("period_month", "=", run.period_month.slice(0, 10))
    .where("input_digest", "=", inputDigest)
    .where("algorithm_version", "=", ALLOCATION_ALGORITHM_VERSION)
    .where("status", "=", "SUCCEEDED")
    .where("is_current", "=", true)
    .executeTakeFirst();

  if (!existing) {
    for (const share of result.shares) {
      const source = lineById.get(share.ledgerLineId);
      await tx.insertInto("project_allocation_line")
        .values(lineInsertValues(run, share, source))
        .execute();
    }
    // P1-1：资源级套餐余量（C08/GS-5）——authority（当月套餐成本口径，
    // 与行级 package_line_cost 同源）减去已分摊到源行的部分，仅正差入
    // 余量表；无源行的资源全额进入余量，不伪造 Token、不入源行守恒公式。
    const { rows: residualRows } = await sql<{ provider_resource_id: string; amount: string }>`
      WITH plan_cash_authority AS (
        SELECT event.provider_resource_id, SUM(event.cash_paid_cny)::numeric(24,8) AS amount
          FROM provider_finance_event event
          JOIN provider_resource resource
            ON resource.enterprise_id = event.enterprise_id
           AND resource.id = event.provider_resource_id AND resource.mode = 'CODING_PLAN'
         WHERE event.enterprise_id = ${run.enterprise_id}::uuid
           AND event.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
           AND event.occurred_at >= ${monthRange.start} AND event.occurred_at < ${monthRange.end}
         GROUP BY event.provider_resource_id
      ), snapshot_authority AS (
        SELECT DISTINCT ON (s.provider_resource_id)
               s.provider_resource_id, s.package_cost::numeric(24,8) AS amount
          FROM provider_resource_operating_snapshot s
          JOIN provider_resource resource
            ON resource.enterprise_id = s.enterprise_id
           AND resource.id = s.provider_resource_id AND resource.mode = 'CODING_PLAN'
         WHERE s.enterprise_id = ${run.enterprise_id}::uuid AND s.collected_at < ${monthRange.end}
         ORDER BY s.provider_resource_id, s.collected_at DESC, s.version DESC
      ), authority AS (
        SELECT COALESCE(plan.provider_resource_id, snap.provider_resource_id) AS provider_resource_id,
               COALESCE(plan.amount, snap.amount, 0)::numeric(24,8) AS amount
          FROM plan_cash_authority plan
          FULL OUTER JOIN snapshot_authority snap
            ON snap.provider_resource_id = plan.provider_resource_id
      ), line_allocated AS (
        -- 源行拆分到多个目标时会生成多行份额，每行都带整行源套餐成本；
        -- 必须按 ledger_line_id 去重后再求和，否则减数被放大、余量被低估。
        SELECT provider_resource_id, SUM(source_package_cost)::numeric(24,8) AS amount
          FROM (
            SELECT DISTINCT ON (ledger_line_id)
                   ledger_line_id, provider_resource_id, source_package_cost
              FROM project_allocation_line
             WHERE run_id = ${run.id}::uuid AND resource_mode = 'CODING_PLAN'
               AND source_package_cost IS NOT NULL
             ORDER BY ledger_line_id, provider_resource_id
          ) distinct_source_lines
         GROUP BY provider_resource_id
      )
      SELECT authority.provider_resource_id,
             (authority.amount - COALESCE(line_allocated.amount, 0))::text AS amount
        FROM authority
        LEFT JOIN line_allocated ON line_allocated.provider_resource_id = authority.provider_resource_id
       WHERE authority.amount > 0
         AND authority.amount - COALESCE(line_allocated.amount, 0) > 0`.execute(tx);
    if (residualRows.length > 0) {
      await tx.insertInto("project_allocation_resource_residual")
        .values(residualRows.map((row) => ({
          run_id: run.id,
          provider_resource_id: row.provider_resource_id,
          enterprise_id: run.enterprise_id,
          amount: row.amount,
          note: financeEnabled ? "PLAN_CASH_RESIDUAL" : "SNAPSHOT_RESIDUAL",
        })))
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
    // 幂等命中且命中批次就是 current：no-op 成功。绝不写 input_digest、不夺
    // current、不写份额与余量——该输入状态的当前发布已存在，重复发布无意义且
    // 会占满幂等键。既有发布批次继续供读。
    await tx.updateTable("project_allocation_run")
      .set({
        status: "SUCCEEDED",
        finished_at: new Date(),
        duration_ms: Date.now() - started,
        updated_at: new Date(),
      })
      .where("id", "=", run.id)
      .execute();
  }
}
