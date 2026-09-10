/**
 * 标准版首页同期窗口与用量/活跃主体指标（HOME-STANDARD-20260910 WP02）。
 *
 * - Token：与「厂商资源 / 用量总览」同源（ledger_line + ai_request SUCCEEDED，上海自然月）；
 * - 活跃员工（同期）：与 usage-overview 实时口径同过滤（SETTLED + SUCCEEDED，企业时区）；
 * - 活跃项目：与经营账单项目账同归属解析（北京自然月，排除未归属桶）；
 * - 同期一律半开区间，上月无对应日时截止上月月末（排他边界），禁止整月折算。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import { UsageOverviewEnterpriseNotFoundError } from "./usage-overview-repository.js";
import {
  addRow,
  emptyAccumulator,
  integer,
  queryUsageRows,
  usageQuality,
} from "./dashboard-resource-usage.js";

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 北京时间上一自然月的同期窗口：[上月1日, 上月同一日+时刻)；无对应日时截止上月月末（排他）。 */
export function previousShanghaiMonthWindow(
  now: Date,
): { start: Date; end: Date; truncated: boolean } {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const prevYear = month === 0 ? year - 1 : year;
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevLastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const truncated = local.getUTCDate() > prevLastDay;
  const endLocalMs = truncated
    ? Date.UTC(year, month, 1)
    : Date.UTC(prevYear, prevMonth, local.getUTCDate(), local.getUTCHours(),
      local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
  return {
    start: new Date(Date.UTC(prevYear, prevMonth, 1) - SHANGHAI_OFFSET_MS),
    end: new Date(endLocalMs - SHANGHAI_OFFSET_MS),
    truncated,
  };
}

export function shanghaiNaturalMonthRange(now: Date): { start: Date; end: Date } {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return {
    start: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS),
    end: new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - SHANGHAI_OFFSET_MS,
    ),
  };
}

export interface TokenWindowTotals {
  totalTokens: string;
  inputTokens: string;
  outputTokens: string;
  usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
  unknownCount: number;
}

/**
 * 厂商资源 / 用量总览同源 Token 聚合：按（厂商, 形态）分组先整数化再求和，
 * 与目的页各厂商行展示值的合计一致；缓存与推理为子集，不重复相加。
 */
export async function tokenTotalsForRange(
  db: Kysely<Database>,
  enterpriseId: string,
  start: Date,
  end: Date,
): Promise<TokenWindowTotals> {
  const rows = await queryUsageRows(db, enterpriseId, start, end);
  const byGroup = new Map<string, ReturnType<typeof emptyAccumulator>>();
  for (const row of rows) {
    const key = `${row.provider_code}:${row.mode}`;
    const acc = byGroup.get(key) ?? emptyAccumulator();
    addRow(acc, row);
    byGroup.set(key, acc);
  }
  let totalTokens = 0n;
  let inputTokens = 0n;
  let outputTokens = 0n;
  let unknownCount = 0;
  const qualities = new Set<string>();
  for (const acc of byGroup.values()) {
    totalTokens += BigInt(integer(acc.input.plus(acc.output)));
    inputTokens += BigInt(integer(acc.input));
    outputTokens += BigInt(integer(acc.output));
    unknownCount += acc.unknownCount;
    acc.qualities.forEach((quality) => qualities.add(quality));
  }
  return {
    totalTokens: totalTokens.toString(),
    inputTokens: inputTokens.toString(),
    outputTokens: outputTokens.toString(),
    usageQuality: usageQuality(qualities),
    unknownCount,
  };
}

export interface EmployeePreviousWindow {
  window: { start: Date; end: Date; truncated: boolean };
  count: number;
}

/**
 * 上月同期窗口（企业时区）+ 活跃员工数：过滤与 usage-overview 实时口径一致
 * （ledger_transaction SETTLED + ai_request SUCCEEDED，主体=发起员工）。
 */
export async function previousEmployeeWindow(
  db: Kysely<Database>,
  enterpriseId: string,
  asOf: Date,
): Promise<EmployeePreviousWindow> {
  const result = await sql<{ range_start: Date; range_end: Date; truncated: boolean; cnt: string }>`
    WITH tz AS (
      SELECT timezone FROM enterprise WHERE id = ${enterpriseId}
    ), local AS (
      SELECT ${asOf}::timestamptz AT TIME ZONE (SELECT timezone FROM tz) AS asof_local,
             (SELECT timezone FROM tz) AS tz
    ), bounds AS (
      SELECT date_trunc('month', asof_local) AS cur_month_start,
             date_trunc('month', asof_local) - interval '1 month' AS prev_month_start,
             EXTRACT(DAY FROM (date_trunc('month', asof_local) - interval '1 day')) AS prev_last_day,
             EXTRACT(DAY FROM asof_local) AS asof_day,
             CASE WHEN EXTRACT(DAY FROM asof_local)
                     > EXTRACT(DAY FROM (date_trunc('month', asof_local) - interval '1 day'))
               THEN date_trunc('month', asof_local)
               ELSE asof_local - interval '1 month'
             END AS prev_end_local,
             tz
      FROM local
    )
    SELECT (prev_month_start AT TIME ZONE tz) AS range_start,
           (prev_end_local AT TIME ZONE tz) AS range_end,
           (asof_day > prev_last_day) AS truncated,
           (SELECT COUNT(DISTINCT lt.principal_id)::text
              FROM ledger_transaction lt
              JOIN ai_request ar
                ON ar.id = lt.ai_request_id AND ar.enterprise_id = ${enterpriseId}
              JOIN principal source
                ON source.id = lt.principal_id AND source.enterprise_id = ${enterpriseId}
               AND source.type = 'EMPLOYEE'
             WHERE lt.enterprise_id = ${enterpriseId}
               AND lt.status = 'SETTLED' AND ar.status = 'SUCCEEDED'
               AND lt.created_at >= (prev_month_start AT TIME ZONE tz)
               AND lt.created_at < (prev_end_local AT TIME ZONE tz)) AS cnt
      FROM bounds
     WHERE EXISTS (SELECT 1 FROM enterprise WHERE id = ${enterpriseId})
  `.execute(db);
  const row = result.rows[0];
  if (!row) throw new UsageOverviewEnterpriseNotFoundError();
  return {
    window: { start: row.range_start, end: row.range_end, truncated: row.truncated },
    count: Number(row.cnt),
  };
}

/** 项目账同源活跃项目数：员工发起 ledger_line 经请求归属解析到项目主体，排除未归属桶。 */
export async function countActiveProjectsRange(
  db: Kysely<Database>,
  enterpriseId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const result = await sql<{ cnt: string }>`
    SELECT COUNT(DISTINCT project.id)::text AS cnt
      FROM ledger_line ll
      JOIN principal source
        ON source.id = ll.principal_id AND source.enterprise_id = ${enterpriseId}
       AND source.type = 'EMPLOYEE'
      JOIN provider_resource r ON r.id = ll.provider_resource_id AND r.enterprise_id = ${enterpriseId}
      JOIN provider p ON p.id = r.provider_id AND p.enterprise_id = ${enterpriseId}
      LEFT JOIN operating_bill_request_project_assignment a
        ON a.enterprise_id = ${enterpriseId} AND a.ai_request_id = ll.ai_request_id
      LEFT JOIN principal project
        ON project.enterprise_id = ${enterpriseId} AND project.id = a.project_principal_id
       AND project.type = 'PROJECT'
     WHERE ll.enterprise_id = ${enterpriseId}
       AND ll.created_at >= ${start} AND ll.created_at < ${end}
       AND project.id IS NOT NULL
  `.execute(db);
  return Number(result.rows[0]?.cnt ?? "0");
}
