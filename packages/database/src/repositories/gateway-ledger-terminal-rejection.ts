import type { Kysely, Transaction } from "kysely";

import type { Database } from "../kysely.js";
import {
  assertLineMatches,
  assertTransactionMatches,
  assertUsageLineInputCoherent,
  assertUsageMatches,
  GatewayLedgerSettlementConflictError,
} from "./gateway-ledger-settlement-assertions.js";
import { loadRequestSettlementFacts } from "./gateway-ledger-request-facts.js";
import {
  insertLedgerTransaction,
  persistUsageLedgerLine,
  settleRequestAccounting,
  summarizeLedgerUsageQuality,
} from "./gateway-ledger-settlement.js";
import type {
  FinalizeLedgerSettlementInput,
  FinalizeRejectedAttemptSettlementInput,
  LedgerTransaction,
} from "./gateway-ledger-types.js";
import { ensureRequestAttributionSnapshot } from "./request-attribution-writer.js";

/**
 * 上游访问前的 terminal 拒绝只允许走此入口：request → attempt → 账本屏障 →
 * 排序 quota → 排序 lease，同一 PostgreSQL 事务提交全部结算事实和 FAILED 终态。
 */
export async function finalizeRejectedAttemptSettlementAtomically(
  db: Kysely<Database>,
  input: FinalizeRejectedAttemptSettlementInput,
): Promise<LedgerTransaction> {
  assertUsageLineInputCoherent(input);
  assertTerminalRejectionInput(input);
  return db.transaction().execute(async (trx) => {
    const request = await trx.selectFrom("ai_request").select([
      "status", "principal_id", "error_classification", "error_code",
    ]).where("id", "=", input.usage.ai_request_id)
      .where("enterprise_id", "=", input.usage.enterprise_id)
      .forUpdate().executeTakeFirst();
    if (!request) throw new GatewayLedgerSettlementConflictError("settlement_request_not_found");
    if (request.principal_id !== input.ledger_line.principal_id) {
      throw new GatewayLedgerSettlementConflictError("settlement_principal_conflict");
    }

    const existing = await trx.selectFrom("ledger_transaction").selectAll()
      .where("ai_request_id", "=", input.usage.ai_request_id).executeTakeFirst();
    if (request.status !== "IN_PROGRESS") {
      if (request.status !== "FAILED" || !existing
        || request.error_classification !== input.error_classification
        || request.error_code !== input.error_code) {
        throw new GatewayLedgerSettlementConflictError("settlement_terminal_conflict");
      }
      await assertRejectedAttemptEvidence(trx, input);
      const finalization = await buildFinalization(trx, input);
      assertTransactionMatches(existing, finalization);
      await ensureRequestAttributionSnapshot(
        trx, input.usage.enterprise_id, input.usage.ai_request_id,
      );
      return existing;
    }

    await persistUsageLedgerLine(trx, input, input.attempt_result);
    const finalization = await buildFinalization(trx, input);
    const finishedAt = new Date();
    await settleRequestAccounting(trx, finalization, finishedAt);
    const transaction = existing ?? await insertLedgerTransaction(trx, finalization);
    assertTransactionMatches(transaction, finalization);
    await ensureRequestAttributionSnapshot(
      trx, input.usage.enterprise_id, input.usage.ai_request_id,
    );
    const updated = await trx.updateTable("ai_request").set({
      status: "FAILED",
      finished_at: finishedAt,
      error_classification: input.error_classification,
      error_code: input.error_code,
    }).where("id", "=", input.usage.ai_request_id)
      .where("enterprise_id", "=", input.usage.enterprise_id)
      .where("status", "=", "IN_PROGRESS").executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new GatewayLedgerSettlementConflictError("settlement_status_conflict");
    }
    return transaction;
  });
}

function assertTerminalRejectionInput(input: FinalizeRejectedAttemptSettlementInput): void {
  const usage = input.usage;
  const line = input.ledger_line;
  const result = input.attempt_result;
  const apiCostValid = line.resource_mode === "API"
    ? line.api_cost === "0.00000000"
    : line.api_cost === null || line.api_cost === undefined;
  const conflicts = [
    usage.input_tokens !== 0n,
    usage.output_tokens !== 0n,
    usage.cache_tokens !== 0n,
    (usage.reasoning_tokens ?? 0n) !== 0n,
    usage.usage_quality !== "UNKNOWN",
    (usage.upstream_usage_id ?? null) !== null,
    line.raw_input_tokens !== 0n,
    line.raw_output_tokens !== 0n,
    line.raw_cache_tokens !== 0n,
    (line.raw_reasoning_tokens ?? 0n) !== 0n,
    (line.deducted_quota ?? null) !== null,
    line.usage_quality !== "UNKNOWN",
    !apiCostValid,
    (line.billing_rule_id ?? null) !== null,
    (line.rule_version ?? null) !== null,
    (line.multiplier ?? null) !== null,
    (line.billing_rule_snapshot ?? null) !== null,
    result.response_committed,
    result.switch_reason !== null,
    result.error_classification !== input.error_classification,
    result.error_code !== input.error_code,
  ];
  if (conflicts.includes(true)) {
    throw new GatewayLedgerSettlementConflictError("terminal_rejection_fact_conflict");
  }
}

async function buildFinalization(
  trx: Transaction<Database>,
  input: FinalizeRejectedAttemptSettlementInput,
): Promise<FinalizeLedgerSettlementInput> {
  const facts = await loadRequestSettlementFacts(
    trx, input.usage.enterprise_id, input.usage.ai_request_id,
  );
  return {
    ai_request_id: input.usage.ai_request_id,
    enterprise_id: input.usage.enterprise_id,
    principal_id: input.ledger_line.principal_id,
    total_input_tokens: facts.totalInputTokens,
    total_output_tokens: facts.totalOutputTokens,
    total_cache_tokens: facts.totalCacheTokens,
    total_reasoning_tokens: facts.totalReasoningTokens,
    total_deducted_quota: facts.totalDeductedQuota,
    total_api_cost: facts.totalApiCost,
    usage_quality: summarizeLedgerUsageQuality(
      facts.usageQualities.map((usage_quality) => ({ usage_quality })),
    ),
    attempt_count: facts.attemptCount,
    overage: input.overage ?? false,
    request_status: "FAILED",
    error_classification: input.error_classification,
    error_code: input.error_code,
    quota_settlements: input.quota_settlements,
    release_lease_ids: input.release_lease_ids,
  };
}

async function assertRejectedAttemptEvidence(
  trx: Transaction<Database>,
  input: FinalizeRejectedAttemptSettlementInput,
): Promise<void> {
  const attempt = await trx.selectFrom("upstream_attempt")
    .innerJoin("provider_resource", "provider_resource.id", "upstream_attempt.provider_resource_id")
    .select([
      "upstream_attempt.finished_at", "upstream_attempt.http_status",
      "upstream_attempt.response_committed", "upstream_attempt.error_classification",
      "upstream_attempt.error_code", "upstream_attempt.switch_reason", "provider_resource.mode",
    ]).where("upstream_attempt.id", "=", input.usage.upstream_attempt_id)
    .where("upstream_attempt.enterprise_id", "=", input.usage.enterprise_id)
    .where("upstream_attempt.ai_request_id", "=", input.usage.ai_request_id)
    .where("upstream_attempt.provider_resource_id", "=", input.usage.provider_resource_id)
    .where("provider_resource.enterprise_id", "=", input.usage.enterprise_id)
    .executeTakeFirst();
  const result = input.attempt_result;
  if (!attempt || attempt.finished_at === null || attempt.mode !== input.ledger_line.resource_mode
    || attempt.http_status !== result.http_status
    || attempt.response_committed !== result.response_committed
    || attempt.error_classification !== result.error_classification
    || attempt.error_code !== result.error_code
    || attempt.switch_reason !== result.switch_reason) {
    throw new GatewayLedgerSettlementConflictError("settlement_attempt_result_conflict");
  }
  const usage = await trx.selectFrom("usage_event").selectAll()
    .where("dedup_key", "=", input.usage.dedup_key).executeTakeFirst();
  if (!usage) throw new GatewayLedgerSettlementConflictError("settlement_usage_missing");
  assertUsageMatches(usage, input);
  const lines = await trx.selectFrom("ledger_line").selectAll()
    .where("usage_event_id", "=", usage.id).execute();
  if (lines.length !== 1) {
    throw new GatewayLedgerSettlementConflictError("duplicate_ledger_line");
  }
  assertLineMatches(lines[0]!, input);
}
