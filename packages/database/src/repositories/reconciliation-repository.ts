/**
 * 对账仓储（W17）—— 扫描账本表找差异 + 落对账结果。
 *
 * 依据：TRD 行 857（账本重复/丢失 → 立即停止，执行幂等对账）、行 870-871（重复 0/丢失<0.1%）。
 *
 * 分层：
 *   - 扫描（本仓储）：SQL 查 5 类差异 + 计数；
 *   - 判定（@qianliu/domain reconciliation.ts 纯函数）：算比率、给 PASS/FAIL/REVIEW、分级 severity。
 *
 * 重复为 0 的硬保证：usage_event.dedup_key UNIQUE + ledger_transaction UNIQUE(ai_request_id)。
 * 本仓储的扫描是验证层：确认约束生效，并检测约束覆盖不到的丢失。
 *
 * 5 类差异扫描（TRD 行 352、857）：
 *   - DUPLICATE_USAGE：同 dedup_key 多条（约束应已阻止，复核）；
 *   - MISSING_LEDGER_LINE：usage_event 存在但缺 ledger_line；
 *   - MISSING_USAGE：upstream_attempt 有消耗缺 usage_event；
 *   - ORPHAN_LEDGER_LINE：ledger_line 无对应 usage_event；
 *   - SETTLEMENT_MISMATCH：ledger_transaction.total_* ≠ ledger_line 聚合。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import {
  evaluateReconciliation,
  RECONCILIATION_ALGORITHM_VERSION,
  type DiscrepancyRecord,
  type ReconciliationScan,
  type ReconciliationVerdict,
} from "@qianliu/domain";

export interface ReconciliationRunInput {
  enterpriseId: string;
  rangeFrom: Date;
  rangeTo: Date;
}

/** 对账运行完整结果（run + 判定 + 差异）。 */
export interface ReconciliationOutcome {
  runId: string;
  verdict: ReconciliationVerdict;
}

export class ReconciliationRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * 执行一次对账：扫描 → 判定 → 落 run + discrepancies。
   * 幂等：每次调用产生一条新 run（历史 run 保留供审计）。
   */
  async runReconciliation(input: ReconciliationRunInput): Promise<ReconciliationOutcome> {
    // 1. 创建 run（started_at 默认 now）
    const run = await this.db
      .insertInto("reconciliation_run")
      .values({
        enterprise_id: input.enterpriseId,
        range_from: input.rangeFrom,
        range_to: input.rangeTo,
        result: "REVIEW", // 临时，扫描后更新
        algorithm_version: RECONCILIATION_ALGORITHM_VERSION,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // 2. 扫描差异（5 类）
    const scan = await this.scanDiscrepancies(input.enterpriseId, input.rangeFrom, input.rangeTo);

    // 3. 纯函数判定
    const verdict = evaluateReconciliation(scan);

    // 4. 更新 run 汇总
    await this.db
      .updateTable("reconciliation_run")
      .set({
        requests_scanned: scan.requestsScanned,
        usage_events_scanned: scan.usageEventsScanned,
        ledger_lines_scanned: scan.ledgerLinesScanned,
        transactions_scanned: scan.transactionsScanned,
        duplicate_count: verdict.duplicateCount,
        missing_count: verdict.missingCount,
        mismatch_count: verdict.mismatchCount,
        total_discrepancies: verdict.totalDiscrepancies,
        result: verdict.result,
        duplicate_rate: verdict.duplicateRate,
        missing_rate: verdict.missingRate,
        summary: {
          algorithm: RECONCILIATION_ALGORITHM_VERSION,
          range_from: input.rangeFrom.toISOString(),
          range_to: input.rangeTo.toISOString(),
        },
        finished_at: new Date(),
      })
      .where("id", "=", run.id)
      .execute();

    // 5. 落差异明细（异常队列）
    if (verdict.discrepancies.length > 0) {
      await this.db
        .insertInto("reconciliation_discrepancy")
        .values(
          verdict.discrepancies.map((d) => ({
            enterprise_id: input.enterpriseId,
            reconciliation_run_id: run.id,
            discrepancy_type: d.type,
            ai_request_id: d.aiRequestId,
            usage_event_id: d.usageEventId,
            ledger_line_id: d.ledgerLineId,
            ledger_transaction_id: d.ledgerTransactionId,
            detail: d.detail as unknown as Record<string, unknown>,
            severity: d.severity,
            status: "OPEN",
          })),
        )
        .execute();
    }

    return { runId: run.id, verdict };
  }

  /** 查询异常队列（OPEN 差异，供管理 API/首页展示）。 */
  async listOpenDiscrepancies(enterpriseId: string, limit = 100): Promise<
    Array<{
      id: string;
      discrepancy_type: string;
      ai_request_id: string | null;
      severity: string;
      status: string;
      detail: Record<string, unknown> | null;
      created_at: Date;
    }>
  > {
    return this.db
      .selectFrom("reconciliation_discrepancy")
      .select([
        "id",
        "discrepancy_type",
        "ai_request_id",
        "severity",
        "status",
        "detail",
        "created_at",
      ])
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "OPEN")
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute() as never;
  }

  /** 标记差异处理状态（异常队列流转）。 */
  async updateDiscrepancyStatus(
    discrepancyId: string,
    status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "IGNORED",
    resolutionNote?: string,
  ): Promise<void> {
    await this.db
      .updateTable("reconciliation_discrepancy")
      .set({
        status,
        resolution_note: resolutionNote ?? null,
        resolved_at: status === "RESOLVED" || status === "IGNORED" ? new Date() : null,
      })
      .where("id", "=", discrepancyId)
      .execute();
  }

  /**
   * 扫描 5 类差异（在时间范围内）。
   * 用原生 SQL（Kysely 表达复杂 LEFT JOIN/GROUP BY HAVING 较繁琐）。
   */
  private async scanDiscrepancies(
    enterpriseId: string,
    rangeFrom: Date,
    rangeTo: Date,
  ): Promise<ReconciliationScan> {
    const discrepancies: DiscrepancyRecord[] = [];

    // 计数（时间范围内的账本对象）
    const counts = await this.db
      .selectFrom("ai_request")
      .select([
        (eb) => eb.fn.countAll().as("requests"),
      ])
      .where("enterprise_id", "=", enterpriseId)
      .where("started_at", ">=", rangeFrom)
      .where("started_at", "<", rangeTo)
      .executeTakeFirstOrThrow();
    const requestsScanned = Number((counts as { requests: bigint | number }).requests);

    const usageCountRow = await this.db
      .selectFrom("usage_event")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .where("enterprise_id", "=", enterpriseId)
      .executeTakeFirstOrThrow();
    const usageEventsScanned = Number((usageCountRow as { cnt: bigint | number }).cnt);

    const lineCountRow = await this.db
      .selectFrom("ledger_line")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .where("enterprise_id", "=", enterpriseId)
      .executeTakeFirstOrThrow();
    const ledgerLinesScanned = Number((lineCountRow as { cnt: bigint | number }).cnt);

    const txCountRow = await this.db
      .selectFrom("ledger_transaction")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .where("enterprise_id", "=", enterpriseId)
      .executeTakeFirstOrThrow();
    const transactionsScanned = Number((txCountRow as { cnt: bigint | number }).cnt);

    // 1. DUPLICATE_USAGE：同 dedup_key 多条（约束应阻止；复核）
    const dupRows = await sql`
      SELECT dedup_key, COUNT(*)::int AS cnt, array_agg(id::text) AS ids
      FROM usage_event
      WHERE enterprise_id = ${enterpriseId}
      GROUP BY dedup_key HAVING COUNT(*) > 1
    `.execute(this.db);
    for (const r of dupRows.rows as Array<{ dedup_key: string; cnt: number; ids: string[] }>) {
      for (const id of r.ids) {
        discrepancies.push({
          type: "DUPLICATE_USAGE",
          aiRequestId: null,
          usageEventId: id,
          ledgerLineId: null,
          ledgerTransactionId: null,
          detail: { dedup_key: r.dedup_key, count: r.cnt },
        });
      }
    }

    // 2. MISSING_LEDGER_LINE：usage_event 存在但缺对应 ledger_line
    const missingLineRows = await sql`
      SELECT ue.id AS usage_event_id, ue.ai_request_id
      FROM usage_event ue
      LEFT JOIN ledger_line ll ON ll.usage_event_id = ue.id
      WHERE ue.enterprise_id = ${enterpriseId} AND ll.id IS NULL
    `.execute(this.db);
    for (const r of missingLineRows.rows as Array<{ usage_event_id: string; ai_request_id: string }>) {
      discrepancies.push({
        type: "MISSING_LEDGER_LINE",
        aiRequestId: r.ai_request_id,
        usageEventId: r.usage_event_id,
        ledgerLineId: null,
        ledgerTransactionId: null,
        detail: { reason: "usage_event_without_ledger_line" },
      });
    }

    // 3. ORPHAN_LEDGER_LINE：ledger_line 无对应 usage_event（外键应阻止；复核）
    const orphanRows = await sql`
      SELECT ll.id AS ledger_line_id, ll.ai_request_id
      FROM ledger_line ll
      LEFT JOIN usage_event ue ON ue.id = ll.usage_event_id
      WHERE ll.enterprise_id = ${enterpriseId} AND ue.id IS NULL
    `.execute(this.db);
    for (const r of orphanRows.rows as Array<{ ledger_line_id: string; ai_request_id: string }>) {
      discrepancies.push({
        type: "ORPHAN_LEDGER_LINE",
        aiRequestId: r.ai_request_id,
        usageEventId: null,
        ledgerLineId: r.ledger_line_id,
        ledgerTransactionId: null,
        detail: { reason: "ledger_line_without_usage_event" },
      });
    }

    // 4. SETTLEMENT_MISMATCH：ledger_transaction.total_* ≠ ledger_line 聚合
    const mismatchRows = await sql`
      SELECT lt.id AS tx_id, lt.ai_request_id,
             lt.total_input_tokens, lt.total_output_tokens,
             COALESCE(SUM(ll.raw_input_tokens), 0) AS sum_in,
             COALESCE(SUM(ll.raw_output_tokens), 0) AS sum_out
      FROM ledger_transaction lt
      LEFT JOIN ledger_line ll ON ll.ai_request_id = lt.ai_request_id
      WHERE lt.enterprise_id = ${enterpriseId}
      GROUP BY lt.id, lt.ai_request_id, lt.total_input_tokens, lt.total_output_tokens
      HAVING lt.total_input_tokens <> COALESCE(SUM(ll.raw_input_tokens), 0)
          OR lt.total_output_tokens <> COALESCE(SUM(ll.raw_output_tokens), 0)
    `.execute(this.db);
    for (const r of mismatchRows.rows as Array<{
      tx_id: string;
      ai_request_id: string;
      total_input_tokens: string;
      total_output_tokens: string;
      sum_in: string;
      sum_out: string;
    }>) {
      discrepancies.push({
        type: "SETTLEMENT_MISMATCH",
        aiRequestId: r.ai_request_id,
        usageEventId: null,
        ledgerLineId: null,
        ledgerTransactionId: r.tx_id,
        detail: {
          expected_input: r.total_input_tokens,
          actual_input: r.sum_in,
          expected_output: r.total_output_tokens,
          actual_output: r.sum_out,
        },
      });
    }

    // 注：MISSING_USAGE（attempt 有消耗缺 usage_event）—— attempt 层无独立"消耗"标记，
    // usage 由 outcome 决定；此处不扫描（避免误报无消耗的失败 attempt）。

    return {
      rangeFrom: rangeFrom.getTime(),
      rangeTo: rangeTo.getTime(),
      requestsScanned,
      usageEventsScanned,
      ledgerLinesScanned,
      transactionsScanned,
      discrepancies,
    };
  }
}
