import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import {
  emptyBalanceComponents,
  money,
  type BalanceComponents,
} from "@qianliu/domain";
import { PROVIDER_FINANCE_CUTOVER, type FinanceCurrency } from "./provider-finance-types.js";

type Executor = Kysely<Database> | Transaction<Database>;

/**
 * 资金余额事实装载（WP02 抽取）。
 *
 * 抽取动机（计划 v1.2 §9 / design §6）：
 *   「余额投影必须抽取并复用既有 provider-finance-balances.ts 聚合语义，
 *     不得另写一套冲销符号公式」。
 *
 * 本模块只负责把**分量事实**读出来；符号与求和顺序由
 * `@qianliu/domain` 的 provider-finance-balance-components 唯一定义。
 * 日常余额查询（cutover→asOf）与候选假设投影（cutover→snapshot_at）共用同一份 SQL，
 * 差别只在窗口参数，因此两处的分量口径不可能漂移。
 */
export interface BalanceFactWindow {
  enterpriseId: string;
  resourceId: string;
  currency: FinanceCurrency;
  /** null 表示资金事件不设时间下界（与非窗口化的当前余额查询保持一致）。 */
  eventsFrom: Date | null;
  eventsTo: Date;
  /** 用量扣费下界固定不早于切换时点。 */
  ledgerFrom: Date;
  ledgerTo: Date;
}

export interface BalanceFactTotals {
  opening: string;
  corrections: string;
  recharges: string;
  reconciliations: string;
  legacyCosts: string;
  reversals: string;
  openingCount: number;
  usageDebits: string;
  latestFinanceEventId: string | null;
  latestFinanceOccurredAt: Date | null;
  latestLedgerLineId: string | null;
  latestSettledAt: Date | null;
}

export async function loadBalanceFactTotals(
  db: Executor, window: BalanceFactWindow,
): Promise<BalanceFactTotals> {
  const [events, usage] = await Promise.all([
    sql<{
      opening: string; corrections: string; recharges: string; reconciliations: string;
      legacy_costs: string; reversals: string; opening_count: string;
      latest_id: string | null; latest_at: Date | null;
    }>`
      SELECT COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_OPENING_BALANCE'),0)::text AS opening,
             COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_OPENING_BALANCE_CORRECTION'),0)::text AS corrections,
             COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_RECHARGE'),0)::text AS recharges,
             COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_BALANCE_RECONCILIATION'),0)::text AS reconciliations,
             COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_LEGACY_COST_ADJUSTMENT'),0)::text AS legacy_costs,
             COALESCE(SUM(account_amount) FILTER (WHERE event_type='REVERSAL'),0)::text AS reversals,
             COUNT(*) FILTER (WHERE event_type='API_OPENING_BALANCE')::text AS opening_count,
             (ARRAY_AGG(id ORDER BY occurred_at DESC, created_at DESC, id DESC))[1] AS latest_id,
             MAX(occurred_at) AS latest_at
        FROM provider_finance_event WHERE enterprise_id=${window.enterpriseId}::uuid
         AND provider_resource_id=${window.resourceId}::uuid AND account_currency=${window.currency}
         AND (${window.eventsFrom}::timestamptz IS NULL OR occurred_at >= ${window.eventsFrom}::timestamptz)
         AND occurred_at <= ${window.eventsTo}`.execute(db),
    sql<{ amount: string; latest_id: string | null; latest_at: Date | null }>`
      SELECT COALESCE(SUM(api_cost) FILTER (
               WHERE api_cost_status='PRICED_USAGE' AND api_cost_currency=${window.currency}
             ),0)::text AS amount,
             (ARRAY_AGG(id ORDER BY COALESCE(settled_at,created_at) DESC,
               created_at DESC, id DESC))[1] AS latest_id,
             MAX(COALESCE(settled_at,created_at)) AS latest_at
        FROM ledger_line WHERE enterprise_id=${window.enterpriseId}::uuid
         AND provider_resource_id=${window.resourceId}::uuid AND resource_mode='API'
         AND COALESCE(settled_at,created_at) >= ${window.ledgerFrom}
         AND COALESCE(settled_at,created_at) <= ${window.ledgerTo}`.execute(db),
  ]);
  const e = events.rows[0]!; const u = usage.rows[0]!;
  return {
    opening: e.opening, corrections: e.corrections, recharges: e.recharges,
    reconciliations: e.reconciliations, legacyCosts: e.legacy_costs, reversals: e.reversals,
    openingCount: Number(e.opening_count), usageDebits: u.amount,
    latestFinanceEventId: e.latest_id, latestFinanceOccurredAt: e.latest_at,
    latestLedgerLineId: u.latest_id, latestSettledAt: u.latest_at,
  };
}

/**
 * 分量映射：唯一填写点是这里。
 * 每个分量都必须经过共享的 `money()` 归一化（SQL 的 `::text` 会给出 `1` 这类非标度化文本），
 * 否则响应形状会从八位小数标度退化为原始文本。
 */
export function toBalanceComponents(totals: BalanceFactTotals): BalanceComponents {
  return {
    ...emptyBalanceComponents(),
    openingBalance: money(totals.opening),
    openingCorrections: money(totals.corrections),
    recharges: money(totals.recharges),
    balanceReconciliations: money(totals.reconciliations),
    legacyCostAdjustments: money(totals.legacyCosts),
    reversals: money(totals.reversals),
    usageDebits: money(totals.usageDebits),
  };
}

export interface UnknownCostRow {
  id: string;
  ai_request_id: string;
}

/** 未明确费用且尚未被历史处置覆盖的 API 用量行（失败关闭依据）。 */
export async function loadUnknownCostRows(
  db: Executor, input: { enterpriseId: string; resourceId: string; asOf: Date },
): Promise<UnknownCostRow[]> {
  const result = await sql<UnknownCostRow>`
    SELECT line.id, line.ai_request_id
      FROM ledger_line line
      LEFT JOIN provider_finance_legacy_cost_resolution resolution
        ON resolution.enterprise_id=line.enterprise_id
       AND resolution.id=line.legacy_cost_resolution_id
      WHERE line.enterprise_id=${input.enterpriseId}::uuid
        AND line.provider_resource_id=${input.resourceId}::uuid
        AND line.resource_mode='API'
        AND (line.api_cost_status='UNKNOWN_COST'
          OR (line.api_cost_status IS NULL AND (line.api_cost IS NULL
            OR line.raw_input_tokens > 0 OR line.raw_output_tokens > 0
            OR COALESCE(line.raw_cache_tokens, 0) > 0
            OR COALESCE(line.raw_reasoning_tokens, 0) > 0)))
        AND COALESCE(line.settled_at, line.created_at) >= ${PROVIDER_FINANCE_CUTOVER}
        AND COALESCE(line.settled_at, line.created_at) <= ${input.asOf}
        AND (resolution.id IS NULL OR resolution.status<>'RESOLVED'
          OR resolution.window_end_inclusive>${input.asOf})
      ORDER BY COALESCE(line.settled_at, line.created_at), line.id LIMIT 100`.execute(db);
  return result.rows;
}

export async function loadOpenReconciliationCaseId(
  db: Executor, input: { enterpriseId: string; resourceId: string; currency: FinanceCurrency },
): Promise<string | null> {
  const row = await db.selectFrom("provider_finance_reconciliation_case").select("id")
    .where("enterprise_id", "=", input.enterpriseId)
    .where("provider_resource_id", "=", input.resourceId)
    .where("account_currency", "=", input.currency)
    .where("status", "=", "OPEN")
    .executeTakeFirst();
  return row?.id ?? null;
}
