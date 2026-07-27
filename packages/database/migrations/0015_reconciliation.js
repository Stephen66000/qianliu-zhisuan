/**
 * 迁移 0015 —— 对账运行记录与差异明细（W17）。
 *
 * 依据：TRD 行 857（账本重复/丢失 → 立即停止，执行幂等对账或数据库恢复）、
 * 行 870-871（同一计量事实重复记账率为 0；已确认调用事件丢失率低于 0.1%）、
 * 行 352（同一计量事实重复到达只更新处理状态，不新增 usage_event/ledger_line）。
 *
 * reconciliation_run：每次对账运行的汇总（时间范围、扫描计数、重复/丢失数、状态）。
 * reconciliation_discrepancy：差异明细（类型/对象/详情/状态）—— W17 异常队列载体。
 *
 * 注：alert_event 表（告警）归 W25；W17 的"异常队列"用 reconciliation_discrepancy 承载。
 *     重复为 0 的硬保证由 usage_event.dedup_key UNIQUE + ledger_transaction UNIQUE(ai_request_id) 约束实现；
 *     对账任务是验证层：扫描确认约束生效并检测约束覆盖不到的丢失。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // reconciliation_run：对账运行汇总
  await db.schema
    .createTable("reconciliation_run")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    // 对账时间范围
    .addColumn("range_from", "timestamptz", (c) => c.notNull())
    .addColumn("range_to", "timestamptz", (c) => c.notNull())
    // 扫描计数
    .addColumn("requests_scanned", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("usage_events_scanned", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("ledger_lines_scanned", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("transactions_scanned", "integer", (c) => c.notNull().defaultTo(0))
    // 差异计数
    .addColumn("duplicate_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("missing_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("mismatch_count", "integer", (c) => c.notNull().defaultTo(0))
    // 汇总比对差异（ledger_transaction.total_* 与 ledger_line 聚合不一致）
    .addColumn("total_discrepancies", "integer", (c) => c.notNull().defaultTo(0))
    // 判定（PASS=重复 0 且丢失在阈值内；FAIL=超出阈值；需人工介入）
    .addColumn("result", "varchar(16)", (c) => c.notNull()) // PASS/FAIL/REVIEW
    .addColumn("duplicate_rate", "numeric") // 重复率（duplicate/scanned，须为 0）
    .addColumn("missing_rate", "numeric") // 丢失率（missing/scanned，须 <0.1%）
    .addColumn("summary", "jsonb") // 人类可读摘要 + 算法版本
    .addColumn("algorithm_version", "varchar(32)", (c) => c.notNull())
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("finished_at", "timestamptz")
    .execute();

  await sql`ALTER TABLE reconciliation_run ADD CONSTRAINT reconciliation_run_result_check CHECK (result IN ('PASS','FAIL','REVIEW'))`.execute(db);

  // reconciliation_discrepancy：差异明细（异常队列载体）
  await db.schema
    .createTable("reconciliation_discrepancy")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("reconciliation_run_id", "uuid", (c) => c.notNull().references("reconciliation_run.id"))
    // 差异类型
    .addColumn("discrepancy_type", "varchar(32)", (c) => c.notNull()) // DUPLICATE_USAGE/MISSING_LEDGER_LINE/MISSING_USAGE/ORPHAN_LEDGER_LINE/SETTLEMENT_MISMATCH
    // 涉及对象（引用账本表 id）
    .addColumn("ai_request_id", "uuid")
    .addColumn("usage_event_id", "uuid")
    .addColumn("ledger_line_id", "uuid")
    .addColumn("ledger_transaction_id", "uuid")
    // 详情（机器可读 + 人类可读）
    .addColumn("detail", "jsonb") // { expected, actual, ... }
    .addColumn("severity", "varchar(16)", (c) => c.notNull().defaultTo("HIGH")) // HIGH/MEDIUM/LOW
    // 处理状态（异常队列：OPEN/INVESTIGATING/RESOLVED/IGNORED）
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("OPEN"))
    .addColumn("resolution_note", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("resolved_at", "timestamptz")
    .execute();

  await sql`ALTER TABLE reconciliation_discrepancy ADD CONSTRAINT reconciliation_discrepancy_type_check CHECK (discrepancy_type IN ('DUPLICATE_USAGE','MISSING_LEDGER_LINE','MISSING_USAGE','ORPHAN_LEDGER_LINE','SETTLEMENT_MISMATCH'))`.execute(db);
  await sql`ALTER TABLE reconciliation_discrepancy ADD CONSTRAINT reconciliation_discrepancy_severity_check CHECK (severity IN ('HIGH','MEDIUM','LOW'))`.execute(db);
  await sql`ALTER TABLE reconciliation_discrepancy ADD CONSTRAINT reconciliation_discrepancy_status_check CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','IGNORED'))`.execute(db);
  // 异常队列查询：企业 + OPEN
  await db.schema
    .createIndex("reconciliation_discrepancy_enterprise_status_idx")
    .ifNotExists()
    .on("reconciliation_discrepancy")
    .columns(["enterprise_id", "status", "severity"])
    .execute();
  await db.schema
    .createIndex("reconciliation_discrepancy_run_idx")
    .ifNotExists()
    .on("reconciliation_discrepancy")
    .columns(["reconciliation_run_id"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("reconciliation_discrepancy").ifExists().execute();
  await db.schema.dropTable("reconciliation_run").ifExists().execute();
}
