import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

export class OperatingBillClosedError extends Error {}

/** 结算事实时间所属的北京时间经营账期。 */
export function operatingBillMonthAt(value: Date): string {
  const shanghai = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 无论账期行是否已存在，都用 PostgreSQL 事务级 advisory lock
 * 串行化同企业同月的首次结算与账期创建。
 */
export async function acquireOperatingBillMonthWriteBarrier(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
): Promise<void> {
  operatingBillMonthRange(month);
  const lockKey = `qianliu:operating-bill:${enterpriseId}:${month}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0::bigint))`
    .execute(db);
}

/**
 * attempt/ledger_line 写入前锁住已有账期并触碰行版本：
 * writer 先行时，正在 REPEATABLE READ 关账的事务会以 40001 重试；
 * close 先行时，writer 等待后可见 CLOSED 并拒绝新事实。
 */
export async function guardOperatingBillLedgerWrite(
  db: Kysely<Database>,
  enterpriseId: string,
  writtenAt: Date,
): Promise<void> {
  const month = operatingBillMonthAt(writtenAt);
  await acquireOperatingBillMonthWriteBarrier(db, enterpriseId, month);
  const { monthDate } = operatingBillMonthRange(month);
  const period = await db.selectFrom("operating_bill_period")
    .select(["id", "status"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", monthDate)
    .forUpdate()
    .executeTakeFirst();
  if (period?.status === "CLOSED") throw new OperatingBillClosedError();
  if (period) {
    await db.updateTable("operating_bill_period")
      .set({ updated_at: writtenAt })
      .where("id", "=", period.id)
      .where("enterprise_id", "=", enterpriseId)
      .execute();
  }
}

/**
 * terminal request status 是完整结算的发布屏障。当月保守拦截企业全部在途
 * attempt（包括跨月请求）；历史月只拦截与该月 attempt/usage/line 有关的在途请求。
 */
export async function hasPendingOperatingBillSettlement(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  now: Date,
): Promise<boolean> {
  const { start, end } = operatingBillMonthRange(month);
  const isCurrentMonth = operatingBillMonthAt(now) === month;
  const pending = await sql<{ pending: boolean }>`
    SELECT (
      EXISTS (
        SELECT 1
          FROM ai_request request
         WHERE request.enterprise_id = ${enterpriseId}
           AND request.status = 'IN_PROGRESS'
           AND EXISTS (
             SELECT 1 FROM upstream_attempt attempt
              WHERE attempt.enterprise_id = ${enterpriseId}
                AND attempt.ai_request_id = request.id
           )
           AND (
             ${isCurrentMonth}
             OR EXISTS (
               SELECT 1 FROM upstream_attempt attempt
                WHERE attempt.enterprise_id = ${enterpriseId}
                  AND attempt.ai_request_id = request.id
                  AND attempt.started_at >= ${start} AND attempt.started_at < ${end}
             )
             OR EXISTS (
               SELECT 1 FROM usage_event usage
                WHERE usage.enterprise_id = ${enterpriseId}
                  AND usage.ai_request_id = request.id
                  AND usage.created_at >= ${start} AND usage.created_at < ${end}
             )
             OR EXISTS (
               SELECT 1 FROM ledger_line line
                WHERE line.enterprise_id = ${enterpriseId}
                  AND line.ai_request_id = request.id
                  AND line.created_at >= ${start} AND line.created_at < ${end}
             )
           )
      )
      OR EXISTS (
        SELECT 1 FROM usage_event usage
         WHERE usage.enterprise_id = ${enterpriseId}
           AND usage.created_at >= ${start} AND usage.created_at < ${end}
           AND NOT EXISTS (
             SELECT 1 FROM ledger_line line
              WHERE line.enterprise_id = usage.enterprise_id
                AND line.usage_event_id = usage.id
           )
      )
      OR EXISTS (
        SELECT 1 FROM ledger_line line
         WHERE line.enterprise_id = ${enterpriseId}
           AND line.created_at >= ${start} AND line.created_at < ${end}
           AND NOT EXISTS (
             SELECT 1 FROM ledger_transaction ledger_tx
              WHERE ledger_tx.enterprise_id = line.enterprise_id
                AND ledger_tx.ai_request_id = line.ai_request_id
           )
      )
      OR EXISTS (
        SELECT 1
          FROM ledger_transaction ledger_tx
         WHERE ledger_tx.enterprise_id = ${enterpriseId}
           AND EXISTS (
             SELECT 1 FROM ledger_line target_line
              WHERE target_line.enterprise_id = ledger_tx.enterprise_id
                AND target_line.ai_request_id = ledger_tx.ai_request_id
                AND target_line.created_at >= ${start} AND target_line.created_at < ${end}
           )
           AND EXISTS (
             SELECT 1 FROM ledger_line line
              WHERE line.enterprise_id = ledger_tx.enterprise_id
                AND line.ai_request_id = ledger_tx.ai_request_id
             GROUP BY line.ai_request_id
             HAVING ledger_tx.status <> 'SETTLED'
                 OR ledger_tx.attempt_count <> (
                   SELECT COUNT(*) FROM upstream_attempt attempt
                    WHERE attempt.enterprise_id = ledger_tx.enterprise_id
                      AND attempt.ai_request_id = ledger_tx.ai_request_id
                 )
                 OR ledger_tx.total_input_tokens <> SUM(line.raw_input_tokens)
                 OR ledger_tx.total_output_tokens <> SUM(line.raw_output_tokens)
                 OR ledger_tx.total_cache_tokens <> SUM(line.raw_cache_tokens)
                 OR ledger_tx.total_reasoning_tokens <> SUM(line.raw_reasoning_tokens)
                 OR ledger_tx.total_deducted_quota <> COALESCE(SUM(line.deducted_quota), 0)
                 OR (COUNT(*) FILTER (WHERE line.resource_mode = 'API')
                       = COUNT(line.api_cost) FILTER (WHERE line.resource_mode = 'API')
                     AND ledger_tx.total_api_cost <>
                       COALESCE(SUM(line.api_cost) FILTER (WHERE line.resource_mode = 'API'), 0))
           )
      )
      OR EXISTS (
        SELECT 1
          FROM ai_request request
          JOIN upstream_attempt attempt
            ON attempt.enterprise_id = request.enterprise_id
           AND attempt.ai_request_id = request.id
         WHERE request.enterprise_id = ${enterpriseId}
           AND request.status <> 'IN_PROGRESS'
           AND attempt.finished_at IS NULL
           AND attempt.started_at >= ${start} AND attempt.started_at < ${end}
      )
    ) AS pending
  `.execute(db);
  return pending.rows[0]?.pending ?? false;
}
