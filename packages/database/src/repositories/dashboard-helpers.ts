import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../kysely.js";
import type { DashboardSummary } from "./dashboard-types.js";

export function sumDecimalTexts(values: string[]): string {
  const scale = values.reduce(
    (current, value) => Math.max(current, value.split(".")[1]?.length ?? 0), 0,
  );
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    return sum + BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  }, 0n);
  if (scale === 0) return total.toString();
  const padded = total.toString().padStart(scale + 1, "0");
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

export function decimalTextsEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  };
  return units(left) === units(right);
}

export function shanghaiNaturalMonth(now: Date): { start: Date; end: Date } {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  return {
    start: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset),
    end: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - offset),
  };
}

export function shanghaiNaturalDay(now: Date): { start: Date; end: Date } {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  return {
    start: new Date(Date.UTC(
      local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    ) - offset),
    end: new Date(Date.UTC(
      local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1,
    ) - offset),
  };
}

export async function getMonthlyTokenUsage(
  db: Kysely<Database>, enterpriseId: string, monthStart: Date, monthEnd: Date,
): Promise<DashboardSummary["monthlyTokenUsage"]> {
  const totals = await sql<{
    input_tokens: string; output_tokens: string; cache_tokens: string;
    reasoning_tokens: string; total_tokens: string;
  }>`
    SELECT COALESCE(SUM(total_input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(total_output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(total_cache_tokens), 0)::text AS cache_tokens,
           COALESCE(SUM(total_reasoning_tokens), 0)::text AS reasoning_tokens,
           COALESCE(SUM(total_input_tokens + total_output_tokens), 0)::text AS total_tokens
      FROM ledger_transaction
     WHERE enterprise_id = ${enterpriseId} AND status = 'SETTLED'
       AND created_at >= ${monthStart} AND created_at < ${monthEnd}
  `.execute(db);
  const total = totals.rows[0] ?? {
    input_tokens: "0", output_tokens: "0", cache_tokens: "0", reasoning_tokens: "0", total_tokens: "0",
  };
  const ranking = await sql<{
    principal_id: string; principal_name: string; input_tokens: string;
    output_tokens: string; cache_tokens: string; reasoning_tokens: string;
    total_tokens: string; share: string;
  }>`
    SELECT p.id AS principal_id, p.name AS principal_name,
           SUM(lt.total_input_tokens)::text AS input_tokens,
           SUM(lt.total_output_tokens)::text AS output_tokens,
           SUM(lt.total_cache_tokens)::text AS cache_tokens,
           SUM(lt.total_reasoning_tokens)::text AS reasoning_tokens,
           SUM(lt.total_input_tokens + lt.total_output_tokens)::text AS total_tokens,
           CASE WHEN ${total.total_tokens}::numeric = 0 THEN '0'
                ELSE (SUM(lt.total_input_tokens + lt.total_output_tokens)::numeric /
                      ${total.total_tokens}::numeric)::text END AS share
      FROM ledger_transaction lt
      JOIN principal p ON p.id = lt.principal_id AND p.enterprise_id = ${enterpriseId}
     WHERE lt.enterprise_id = ${enterpriseId} AND lt.status = 'SETTLED'
       AND lt.created_at >= ${monthStart} AND lt.created_at < ${monthEnd}
       AND p.type = 'EMPLOYEE' AND p.status = 'ACTIVE' AND p.archived_at IS NULL
     GROUP BY p.id, p.name
     ORDER BY SUM(lt.total_input_tokens + lt.total_output_tokens) DESC, p.name ASC, p.id ASC
     LIMIT 10
  `.execute(db);
  return {
    totalInputTokens: total.input_tokens, totalOutputTokens: total.output_tokens,
    totalCacheTokens: total.cache_tokens, totalReasoningTokens: total.reasoning_tokens,
    totalTokens: total.total_tokens,
    employeeRanking: ranking.rows.map((row) => ({
      principalId: row.principal_id, principalName: row.principal_name,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens, reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens, share: row.share,
    })),
  };
}

export async function getTodayEmployeeUsage(
  db: Kysely<Database>, enterpriseId: string, dayStart: Date, asOf: Date,
): Promise<DashboardSummary["todayEmployeeUsage"]> {
  const totals = await sql<{
    input_tokens: string; output_tokens: string; cache_tokens: string;
    reasoning_tokens: string; total_tokens: string;
  }>`
    SELECT COALESCE(SUM(lt.total_input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(lt.total_output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(lt.total_cache_tokens), 0)::text AS cache_tokens,
           COALESCE(SUM(lt.total_reasoning_tokens), 0)::text AS reasoning_tokens,
           COALESCE(SUM(lt.total_input_tokens + lt.total_output_tokens), 0)::text AS total_tokens
      FROM ledger_transaction lt
      JOIN ai_request ar ON ar.id = lt.ai_request_id AND ar.enterprise_id = ${enterpriseId}
      JOIN principal p ON p.id = lt.principal_id AND p.enterprise_id = ${enterpriseId}
     WHERE lt.enterprise_id = ${enterpriseId} AND lt.status = 'SETTLED'
       AND ar.started_at >= ${dayStart} AND ar.started_at < ${asOf}
       AND p.type = 'EMPLOYEE' AND p.status = 'ACTIVE' AND p.archived_at IS NULL
  `.execute(db);
  const total = totals.rows[0] ?? {
    input_tokens: "0", output_tokens: "0", cache_tokens: "0",
    reasoning_tokens: "0", total_tokens: "0",
  };
  const ranking = await sql<{
    principal_id: string; principal_name: string; input_tokens: string;
    output_tokens: string; cache_tokens: string; reasoning_tokens: string;
    total_tokens: string; share: string;
  }>`
    SELECT p.id AS principal_id, p.name AS principal_name,
           SUM(lt.total_input_tokens)::text AS input_tokens,
           SUM(lt.total_output_tokens)::text AS output_tokens,
           SUM(lt.total_cache_tokens)::text AS cache_tokens,
           SUM(lt.total_reasoning_tokens)::text AS reasoning_tokens,
           SUM(lt.total_input_tokens + lt.total_output_tokens)::text AS total_tokens,
           CASE WHEN ${total.total_tokens}::numeric = 0 THEN '0'
                ELSE (SUM(lt.total_input_tokens + lt.total_output_tokens)::numeric /
                      ${total.total_tokens}::numeric)::text END AS share
      FROM ledger_transaction lt
      JOIN ai_request ar ON ar.id = lt.ai_request_id AND ar.enterprise_id = ${enterpriseId}
      JOIN principal p ON p.id = lt.principal_id AND p.enterprise_id = ${enterpriseId}
     WHERE lt.enterprise_id = ${enterpriseId} AND lt.status = 'SETTLED'
       AND ar.started_at >= ${dayStart} AND ar.started_at < ${asOf}
       AND p.type = 'EMPLOYEE' AND p.status = 'ACTIVE' AND p.archived_at IS NULL
     GROUP BY p.id, p.name
     ORDER BY SUM(lt.total_input_tokens + lt.total_output_tokens) DESC, p.name ASC, p.id ASC
     LIMIT 10
  `.execute(db);
  const hourlyRows = await sql<{
    hour: number; total_tokens: string; missing: boolean;
  }>`
    SELECT EXTRACT(HOUR FROM ar.started_at AT TIME ZONE 'Asia/Shanghai')::integer AS hour,
           COALESCE(SUM(
             CASE WHEN lt.status = 'SETTLED'
                  THEN lt.total_input_tokens + lt.total_output_tokens ELSE 0 END
           ), 0)::text AS total_tokens,
           BOOL_OR(
             ar.status = 'SUCCEEDED' AND (lt.id IS NULL OR lt.status <> 'SETTLED')
           ) AS missing
      FROM ai_request ar
      JOIN principal p ON p.id = ar.principal_id AND p.enterprise_id = ${enterpriseId}
      LEFT JOIN ledger_transaction lt
        ON lt.ai_request_id = ar.id AND lt.enterprise_id = ${enterpriseId}
     WHERE ar.enterprise_id = ${enterpriseId}
       AND ar.started_at >= ${dayStart} AND ar.started_at < ${asOf}
       AND p.type = 'EMPLOYEE' AND p.status = 'ACTIVE' AND p.archived_at IS NULL
     GROUP BY EXTRACT(HOUR FROM ar.started_at AT TIME ZONE 'Asia/Shanghai')
  `.execute(db);
  const byHour = new Map(hourlyRows.rows.map((row) => [Number(row.hour), row]));
  const shanghaiHour = new Date(asOf.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
  return {
    totalInputTokens: total.input_tokens,
    totalOutputTokens: total.output_tokens,
    totalCacheTokens: total.cache_tokens,
    totalReasoningTokens: total.reasoning_tokens,
    totalTokens: total.total_tokens,
    employeeRanking: ranking.rows.map((row) => ({
      principalId: row.principal_id, principalName: row.principal_name,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens, reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens, share: row.share,
    })),
    hourly: Array.from({ length: shanghaiHour + 1 }, (_, hour) => {
      const row = byHour.get(hour);
      return {
        hour,
        totalTokens: row?.total_tokens ?? "0",
        collectionStatus: row?.missing ? "MISSING" as const : "COMPLETE" as const,
      };
    }),
  };
}
