import { Decimal } from "decimal.js";
import { sql, type Transaction } from "kysely";

import type { Database } from "../kysely.js";
import { GatewayLedgerSettlementConflictError } from "./gateway-ledger-settlement-assertions.js";

export interface RequestSettlementFacts {
  attemptCount: number;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  totalCacheTokens: bigint;
  totalReasoningTokens: bigint;
  totalDeductedQuota: bigint;
  totalApiCost: string;
  usageQualities: string[];
}

/** request 行已锁定后，从 PostgreSQL 事实读取并验证完整结算汇总。 */
export async function loadRequestSettlementFacts(
  db: Transaction<Database>,
  enterpriseId: string,
  requestId: string,
): Promise<RequestSettlementFacts> {
  const attempt = await db.selectFrom("upstream_attempt").select((eb) => [
    eb.fn.countAll<string>().as("total"),
    eb.fn.count<string>("finished_at").as("finished"),
  ]).where("enterprise_id", "=", enterpriseId)
    .where("ai_request_id", "=", requestId).executeTakeFirstOrThrow();
  if (attempt.finished !== attempt.total) {
    throw new GatewayLedgerSettlementConflictError("settlement_attempt_incomplete");
  }
  const missingLine = await sql<{ missing: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM usage_event usage
       WHERE usage.enterprise_id = ${enterpriseId}
         AND usage.ai_request_id = ${requestId}
         AND NOT EXISTS (
           SELECT 1 FROM ledger_line line
            WHERE line.enterprise_id = usage.enterprise_id
              AND line.usage_event_id = usage.id
         )
    ) AS missing
  `.execute(db);
  if (missingLine.rows[0]?.missing) {
    throw new GatewayLedgerSettlementConflictError("settlement_usage_without_line");
  }
  const missingAttemptFact = await sql<{ missing: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM upstream_attempt attempt
       WHERE attempt.enterprise_id = ${enterpriseId}
         AND attempt.ai_request_id = ${requestId}
         AND NOT EXISTS (
           SELECT 1 FROM usage_event usage
           JOIN ledger_line line
             ON line.enterprise_id = usage.enterprise_id
            AND line.usage_event_id = usage.id
            AND line.upstream_attempt_id = attempt.id
            WHERE usage.enterprise_id = attempt.enterprise_id
              AND usage.ai_request_id = attempt.ai_request_id
              AND usage.upstream_attempt_id = attempt.id
         )
    ) AS missing
  `.execute(db);
  if (missingAttemptFact.rows[0]?.missing) {
    throw new GatewayLedgerSettlementConflictError("settlement_attempt_fact_missing");
  }
  const totals = await sql<{
    input_tokens: string;
    output_tokens: string;
    cache_tokens: string;
    reasoning_tokens: string;
    deducted_quota: string;
    api_cost: string;
    api_cost_known: boolean;
    usage_qualities: string[] | null;
  }>`
    SELECT COALESCE(SUM(raw_input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(raw_output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(raw_cache_tokens), 0)::text AS cache_tokens,
           COALESCE(SUM(raw_reasoning_tokens), 0)::text AS reasoning_tokens,
           COALESCE(SUM(deducted_quota), 0)::text AS deducted_quota,
           COALESCE(SUM(api_cost) FILTER (WHERE resource_mode = 'API'), 0)::text AS api_cost,
           COUNT(*) FILTER (WHERE resource_mode = 'API')
             = COUNT(api_cost) FILTER (WHERE resource_mode = 'API') AS api_cost_known,
           ARRAY_AGG(DISTINCT usage_quality) AS usage_qualities
      FROM ledger_line
     WHERE enterprise_id = ${enterpriseId}
       AND ai_request_id = ${requestId}
  `.execute(db);
  const total = totals.rows[0]!;
  return {
    attemptCount: Number(attempt.total),
    totalInputTokens: BigInt(total.input_tokens),
    totalOutputTokens: BigInt(total.output_tokens),
    totalCacheTokens: BigInt(total.cache_tokens),
    totalReasoningTokens: BigInt(total.reasoning_tokens),
    totalDeductedQuota: BigInt(total.deducted_quota),
    totalApiCost: new Decimal(total.api_cost_known ? total.api_cost : "0").toFixed(8),
    usageQualities: total.usage_qualities ?? [],
  };
}
