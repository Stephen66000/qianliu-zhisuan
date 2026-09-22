/**
 * 项目归集补偿扫描（候选 C3 合同 §5.2；计划 v1.2 §8.1.2）。
 * 阶段一变更识别：不接入 Gateway/结算路径。新事实由写入方在同一事务内直接
 * 推脏（成员/规则/生命周期/人工指定/归属回填/finance 回填），本扫描只兜住
 * ledger_line 迟到插入，并把"已脏但尚未有批次消费该代次"的账期补登记。
 * 时间一律取数据库时钟（now()），避免与业务写入方的时钟源不一致。
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { enqueueAllocationRun, runDueAllocationRuns } from "./project-allocation-run-repository.js";

/** 回看窗口：覆盖迟到插入与水位边界竞态。 */
const LOOKBACK_MS = 10 * 60_000;

export interface AllocationScanResult {
  enterprisesScanned: number;
  /** 本 tick 由迟到新事实推脏的账期。 */
  monthsMarked: string[];
  /** 本 tick 实际登记批次的账期（含既有脏、无批次消费的账期）。 */
  monthsEnqueued: string[];
  runsCreated: number;
  runsExecuted: number;
}

/**
 * worker tick：补偿扫描 + 到期批次执行。幂等（无新事实、无未消费脏代次时不动任何行）。
 * 扫描按"启用企业的全部账期"聚合 account_at 月份；一个月只推一次代次。
 */
export async function projectAllocationTick(
  db: Kysely<Database>,
  workerId: string,
): Promise<AllocationScanResult> {
  const { rows: enterprises } = await sql<{ enterprise_id: string }>`
    SELECT DISTINCT enterprise_id FROM project_allocation_period`.execute(db);
  const { rows: clockRows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
  const now = clockRows[0]!.now;
  const monthsMarked = new Set<string>();
  const monthsEnqueued = new Set<string>();
  let runsCreated = 0;

  for (const enterprise of enterprises) {
    const enterpriseId = enterprise.enterprise_id;
    const watermark = await db.selectFrom("project_allocation_scan_watermark")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .executeTakeFirst();
    const previous = watermark?.ledger_line_watermark ?? new Date(0);
    const lookbackFloor = new Date(previous.getTime() - LOOKBACK_MS);

    // 只标记"晚于该月上次标记时间"的新行：回看窗口仅用于兜住边界竞态，
    // 不让同一条线在每个 tick 的回看期内重复推进代次。
    const { rows: monthRows } = await sql<{ month: string }>`
      WITH candidates AS (
        SELECT to_char(
          CASE WHEN COALESCE(finance.enabled, false) THEN ll.settled_at ELSE ll.created_at END
            AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month,
          ll.created_at
        FROM ledger_line ll
        CROSS JOIN (SELECT COALESCE(
          (SELECT strict_writes_enabled FROM provider_finance_runtime_state
            WHERE enterprise_id = ${enterpriseId}::uuid), false) AS enabled) finance
        WHERE ll.enterprise_id = ${enterpriseId}::uuid
          AND ll.created_at >= ${lookbackFloor} AND ll.created_at < ${now}
      )
      SELECT c.month
      FROM candidates c
      LEFT JOIN project_allocation_dirty d
        ON d.enterprise_id = ${enterpriseId}::uuid AND d.period_month = (c.month || '-01')::date
      GROUP BY c.month, d.last_marked_at
      HAVING MAX(c.created_at) > COALESCE(d.last_marked_at, '-infinity'::timestamptz)`.execute(db);

    for (const line of monthRows) {
      monthsMarked.add(`${enterpriseId}:${line.month}`);
      await sql`INSERT INTO project_allocation_dirty
        (enterprise_id, period_month, generation, dirty, last_marked_at)
      VALUES (${enterpriseId}, ${`${line.month}-01`}::date, 1, true, now())
      ON CONFLICT (enterprise_id, period_month)
      DO UPDATE SET generation = project_allocation_dirty.generation + 1,
        dirty = true, last_marked_at = now()`.execute(db);
    }

    // 纯配置变更（成员/规则/生命周期/人工指定/回填）不产生新 ledger 行，
    // 只靠上面的迟到行扫描永远登记不到：这里把"已脏且当前批次未消费该代次"的
    // 账期补登记，使脏代次不依赖人工点"重建批次"。
    const { rows: pendingDirty } = await sql<{ month: string }>`
      SELECT to_char(d.period_month, 'YYYY-MM') AS month
        FROM project_allocation_dirty d
        LEFT JOIN project_allocation_run r
          ON r.enterprise_id = d.enterprise_id AND r.period_month = d.period_month
         AND r.is_current AND r.status = 'SUCCEEDED'
       WHERE d.enterprise_id = ${enterpriseId}::uuid AND d.dirty
         AND (r.id IS NULL OR d.generation > COALESCE(r.input_dirty_generation, 0))
       ORDER BY month`.execute(db);
    for (const row of pendingDirty) monthsEnqueued.add(`${enterpriseId}:${row.month}`);
    for (const key of monthsMarked) {
      if (key.startsWith(`${enterpriseId}:`)) monthsEnqueued.add(key);
    }

    await sql`INSERT INTO project_allocation_scan_watermark
      (enterprise_id, ledger_line_watermark, updated_at)
    VALUES (${enterpriseId}, ${now}, now())
    ON CONFLICT (enterprise_id) DO UPDATE SET
      ledger_line_watermark = ${now}, updated_at = now()`.execute(db);
  }

  // 为所有待登记账期登记批次（SYSTEM actor；单活动任务约束由部分唯一索引兜底）。
  for (const key of monthsEnqueued) {
    const separator = key.indexOf(":");
    const enterpriseId = key.slice(0, separator);
    const month = key.slice(separator + 1);
    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId, month, actorType: "SYSTEM", actorAdminId: null,
    });
    if (enqueued.created) runsCreated += 1;
  }

  const executed = await runDueAllocationRuns(db, workerId);
  return {
    enterprisesScanned: enterprises.length,
    monthsMarked: [...monthsMarked],
    monthsEnqueued: [...monthsEnqueued],
    runsCreated,
    runsExecuted: executed.length,
  };
}
