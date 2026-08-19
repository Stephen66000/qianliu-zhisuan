import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../kysely.js";
import type { DashboardSummary } from "./dashboard-types.js";
import { summarizeUsageQuality } from "./usage-quality.js";

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

export async function getMonthlyTokenUsage(
  db: Kysely<Database>, enterpriseId: string, monthStart: Date, monthEnd: Date,
): Promise<DashboardSummary["monthlyTokenUsage"]> {
  const totals = await sql<{
    input_tokens: string; output_tokens: string; cache_tokens: string;
    reasoning_tokens: string; total_tokens: string; settled_count: string;
    provider_reported_count: string; estimated_count: string;
    account_aggregated_count: string; mixed_count: string; unknown_count: string;
  }>`
    SELECT COALESCE(SUM(total_input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(total_output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(total_cache_tokens), 0)::text AS cache_tokens,
           COALESCE(SUM(total_reasoning_tokens), 0)::text AS reasoning_tokens,
           COALESCE(SUM(total_input_tokens + total_output_tokens), 0)::text AS total_tokens,
           COUNT(*)::text AS settled_count,
           COUNT(*) FILTER (WHERE usage_quality IN ('PROVIDER_REPORTED', 'UPSTREAM_REPORTED'))::text AS provider_reported_count,
           COUNT(*) FILTER (
             WHERE usage_quality = 'ESTIMATED' OR usage_quality LIKE 'MIXED:%ESTIMATED%'
           )::text AS estimated_count,
           COUNT(*) FILTER (WHERE usage_quality = 'ACCOUNT_AGGREGATED')::text AS account_aggregated_count,
           COUNT(*) FILTER (
             WHERE usage_quality LIKE 'MIXED%'
               AND usage_quality NOT LIKE '%ESTIMATED%'
               AND usage_quality NOT LIKE '%UNKNOWN%'
           )::text AS mixed_count,
           COUNT(*) FILTER (
             WHERE usage_quality = 'UNKNOWN' OR usage_quality LIKE 'MIXED:%UNKNOWN%'
           )::text AS unknown_count
      FROM ledger_transaction
     WHERE enterprise_id = ${enterpriseId} AND status = 'SETTLED'
       AND created_at >= ${monthStart} AND created_at < ${monthEnd}
  `.execute(db);
  const total = totals.rows[0] ?? {
    input_tokens: "0", output_tokens: "0", cache_tokens: "0", reasoning_tokens: "0",
    total_tokens: "0", settled_count: "0", provider_reported_count: "0",
    estimated_count: "0", account_aggregated_count: "0", mixed_count: "0", unknown_count: "0",
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
  const settledTransactionCount = Number(total.settled_count);
  const providerReportedTransactionCount = Number(total.provider_reported_count);
  const estimatedTransactionCount = Number(total.estimated_count);
  const accountAggregatedTransactionCount = Number(total.account_aggregated_count);
  const mixedTransactionCount = Number(total.mixed_count);
  const unknownTransactionCount = Number(total.unknown_count);
  return {
    totalInputTokens: total.input_tokens, totalOutputTokens: total.output_tokens,
    totalCacheTokens: total.cache_tokens, totalReasoningTokens: total.reasoning_tokens,
    totalTokens: total.total_tokens,
    usageQuality: summarizeUsageQuality(settledTransactionCount, {
      providerReportedCount: providerReportedTransactionCount,
      estimatedCount: estimatedTransactionCount,
      accountAggregatedCount: accountAggregatedTransactionCount,
      mixedCount: mixedTransactionCount,
      unknownCount: unknownTransactionCount,
    }),
    settledTransactionCount,
    providerReportedTransactionCount,
    estimatedTransactionCount,
    accountAggregatedTransactionCount,
    mixedTransactionCount,
    unknownTransactionCount,
    attributionBasis: "LEDGER_TRANSACTION_SETTLED_AT",
    rangeStart: monthStart.toISOString(),
    rangeEndExclusive: monthEnd.toISOString(),
    employeeRanking: ranking.rows.map((row) => ({
      principalId: row.principal_id, principalName: row.principal_name,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens, reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens, share: row.share,
    })),
  };
}
