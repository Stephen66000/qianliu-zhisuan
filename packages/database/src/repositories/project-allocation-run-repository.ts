/**
 * 项目归集登记与输入装载仓储（候选 C3 合同 §5；计划 v1.2 §8.1）。
 * 批次执行/发布在 project-allocation-execution.ts（80 终审 P1-3 拆分）。
 * 源行来自共享成本 CTE（liveLineFactCtes 行级证据列）；规则/参与/核算取当前
 * is_current 快照并固化 digest；发布原子（SUCCEEDED+is_current 同事务切换，
 * 先关旧 current）；守恒失败不发布部分结果；资源级套餐余量另表。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { allocationGeneration } from "./project-allocation-common.js";
import { ALLOCATION_ALGORITHM_VERSION, ALLOCATION_SCHEMA_VERSION } from "./project-allocation-execution.js";
export {
  loadAllocationSourceLines, loadAllocationContexts, claimNextAllocationRun,
  executeAllocationRun, runDueAllocationRuns,
  ALLOCATION_SCHEMA_VERSION, ALLOCATION_ALGORITHM_VERSION,
  type ExecuteRunResult,
} from "./project-allocation-execution.js";

/** 北京自然月的首日（date 列值）。校验复用经营账月份口径，避免 UTC 偏移错日。 */
const monthDate = (month: string): string => {
  operatingBillMonthRange(month);
  return `${month}-01`;
};

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
      && allocationGeneration(current.input_dirty_generation) >= allocationGeneration(generation)) {
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
