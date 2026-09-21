/**
 * 项目归集结账冻结（候选 C3 合同 §5.5；计划 v1.2 §8.3）。
 * close 事务内：启用账期校验"存在 is_current SUCCEEDED 批次且脏代次未前进"，
 * 然后写 operating_bill_project_allocation_ref（不可变 run 引用+核对摘要）。
 * 未启用账期为 no-op（维持原结账路径）；账单 JSON 不复制逐行明细。
 */
import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";

export class AllocationNotReadyError extends Error {
  constructor(public readonly reason: "not_enabled_check" | "no_current_run" | "stale_input") {
    super(`project allocation not ready for close (${reason})`);
    this.name = "AllocationNotReadyError";
  }
}

interface FreezeInput {
  enterpriseId: string;
  periodId: string;
  month: string;
  version: number;
  /** close 路径为 true；历史兼容/回填路径可关闭一致性强制。 */
  requireConsistency: boolean;
}

/**
 * 结账冻结：在 close 的事务内调用。返回冻结的 run id（未启用返回 null）。
 * 摘要只含 run_id/schema/algorithm/input_digest/result_hash/守恒汇总/完整性/生成时间。
 */
export async function freezeProjectAllocationForClose(
  trx: Transaction<Database>,
  input: FreezeInput,
): Promise<string | null> {
  const day = `${input.month}-01`;
  const { rows: enabled } = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM project_allocation_period
    WHERE enterprise_id = ${input.enterpriseId} AND period_month <= ${day}::date`.execute(trx);
  if ((enabled[0]?.n ?? 0) === 0) return null;

  const { rows: runRows } = await sql<{
    id: string; status: string; input_digest: string | null; result_hash: string | null;
    conservation: Record<string, unknown> | null; completeness: Record<string, unknown> | null;
    finished_at: Date | null; input_dirty_generation: string | null;
    schema_version: string; algorithm_version: string;
  }>`
    SELECT id, status, input_digest, result_hash, conservation, completeness,
           finished_at, input_dirty_generation::text AS input_dirty_generation,
           schema_version, algorithm_version
    FROM project_allocation_run
    WHERE enterprise_id = ${input.enterpriseId} AND period_month = ${day}::date AND is_current
    LIMIT 1`.execute(trx);
  const run = runRows[0];
  if (run === undefined || run.status !== "SUCCEEDED") {
    if (input.requireConsistency) throw new AllocationNotReadyError("no_current_run");
    return null;
  }

  if (input.requireConsistency) {
    const { rows: dirtyRows } = await sql<{ generation: string | null }>`
      SELECT generation::text AS generation FROM project_allocation_dirty
      WHERE enterprise_id = ${input.enterpriseId} AND period_month = ${day}::date`.execute(trx);
    const generation = dirtyRows[0]?.generation === null || dirtyRows[0]?.generation === undefined
      ? "0" : dirtyRows[0].generation;
    const captured = run.input_dirty_generation === null || run.input_dirty_generation === undefined
      ? "0" : run.input_dirty_generation;
    if (BigInt(generation) > BigInt(captured)) {
      throw new AllocationNotReadyError("stale_input");
    }
  }

  const { rows: versionRows } = await sql<{ id: string }>`
    SELECT id FROM operating_bill_version
    WHERE period_id = ${input.periodId} AND version = ${input.version}
    LIMIT 1`.execute(trx);
  const billVersionId = versionRows[0]?.id;
  if (billVersionId === undefined) return null;

  await trx.insertInto("operating_bill_project_allocation_ref").values({
    enterprise_id: input.enterpriseId,
    bill_version_id: billVersionId,
    run_id: run.id,
    frozen: {
      run_id: run.id,
      schema_version: run.schema_version,
      algorithm_version: run.algorithm_version,
      input_digest: run.input_digest,
      result_hash: run.result_hash,
      conservation: run.conservation,
      completeness: run.completeness,
      generated_at: run.finished_at?.toISOString() ?? null,
    },
  }).execute();
  return run.id;
}
