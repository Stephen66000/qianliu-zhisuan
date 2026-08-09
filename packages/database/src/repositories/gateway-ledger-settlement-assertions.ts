import { Decimal } from "decimal.js";

import type {
  CreateAttemptInput,
  CreateLedgerTransactionInput,
  CreateUsageLedgerLineInput,
  LedgerLine,
  LedgerTransaction,
  UpstreamAttempt,
  UsageEvent,
} from "./gateway-ledger-types.js";

export class GatewayLedgerSettlementConflictError extends Error {}

/** @internal 供结算不变量的定向变异测试复用。 */
export function assertAttemptMatches(attempt: UpstreamAttempt, input: CreateAttemptInput): void {
  if (attempt.enterprise_id !== input.enterprise_id
    || attempt.ai_request_id !== input.ai_request_id
    || attempt.attempt_no !== input.attempt_no
    || attempt.provider_resource_id !== input.provider_resource_id
    || attempt.upstream_model !== input.upstream_model) {
    throw new GatewayLedgerSettlementConflictError("attempt_identity_conflict");
  }
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function assertUsageMatches(usage: UsageEvent, input: CreateUsageLedgerLineInput): void {
  const expected = input.usage;
  if (usage.ai_request_id !== expected.ai_request_id
    || usage.enterprise_id !== expected.enterprise_id
    || usage.upstream_attempt_id !== expected.upstream_attempt_id
    || usage.provider_resource_id !== expected.provider_resource_id
    || BigInt(usage.input_tokens) !== expected.input_tokens
    || BigInt(usage.output_tokens) !== expected.output_tokens
    || BigInt(usage.cache_tokens) !== expected.cache_tokens
    || BigInt(usage.reasoning_tokens) !== (expected.reasoning_tokens ?? 0n)
    || usage.usage_quality !== expected.usage_quality
    || usage.upstream_usage_id !== (expected.upstream_usage_id ?? null)) {
    throw new GatewayLedgerSettlementConflictError("usage_dedup_conflict");
  }
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function assertLineMatches(line: LedgerLine, input: CreateUsageLedgerLineInput): void {
  const expected = input.ledger_line;
  if (line.ai_request_id !== expected.ai_request_id
    || line.enterprise_id !== expected.enterprise_id
    || line.upstream_attempt_id !== expected.upstream_attempt_id
    || line.provider_resource_id !== expected.provider_resource_id
    || line.principal_id !== expected.principal_id
    || line.resource_mode !== expected.resource_mode
    || BigInt(line.raw_input_tokens) !== expected.raw_input_tokens
    || BigInt(line.raw_output_tokens) !== expected.raw_output_tokens
    || BigInt(line.raw_cache_tokens) !== expected.raw_cache_tokens
    || BigInt(line.raw_reasoning_tokens) !== (expected.raw_reasoning_tokens ?? 0n)
    || !optionalBigintEquals(line.deducted_quota, expected.deducted_quota)
    || !optionalDecimalEquals(line.api_cost, expected.api_cost)
    || line.usage_quality !== expected.usage_quality
    || line.billing_rule_id !== (expected.billing_rule_id ?? null)
    || line.rule_version !== (expected.rule_version ?? null)
    || !optionalDecimalEquals(line.multiplier, expected.multiplier)
    || stableJson(line.billing_rule_snapshot) !== stableJson(expected.billing_rule_snapshot ?? null)) {
    throw new GatewayLedgerSettlementConflictError("ledger_line_conflict");
  }
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function assertTransactionMatches(
  transaction: LedgerTransaction,
  input: CreateLedgerTransactionInput,
): void {
  if (transaction.ai_request_id !== input.ai_request_id
    || transaction.enterprise_id !== input.enterprise_id
    || transaction.principal_id !== input.principal_id
    || BigInt(transaction.total_input_tokens) !== input.total_input_tokens
    || BigInt(transaction.total_output_tokens) !== input.total_output_tokens
    || BigInt(transaction.total_cache_tokens) !== input.total_cache_tokens
    || BigInt(transaction.total_reasoning_tokens) !== (input.total_reasoning_tokens ?? 0n)
    || BigInt(transaction.total_deducted_quota) !== input.total_deducted_quota
    || !new Decimal(transaction.total_api_cost).eq(input.total_api_cost)
    || transaction.overage !== (input.overage ?? false)
    || transaction.usage_quality !== input.usage_quality
    || transaction.attempt_count !== input.attempt_count
    || transaction.status !== "SETTLED") {
    throw new GatewayLedgerSettlementConflictError("ledger_transaction_conflict");
  }
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function optionalBigintEquals(
  actual: bigint | null,
  expected: bigint | null | undefined,
): boolean {
  return actual === null
    ? expected === null || expected === undefined
    : expected !== null && expected !== undefined && BigInt(actual) === expected;
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function assertUsageLineInputCoherent(input: CreateUsageLedgerLineInput): void {
  const usage = input.usage;
  const line = input.ledger_line;
  if (line.ai_request_id !== usage.ai_request_id
    || line.enterprise_id !== usage.enterprise_id
    || line.upstream_attempt_id !== usage.upstream_attempt_id
    || line.provider_resource_id !== usage.provider_resource_id
    || line.raw_input_tokens !== usage.input_tokens
    || line.raw_output_tokens !== usage.output_tokens
    || line.raw_cache_tokens !== usage.cache_tokens
    || (line.raw_reasoning_tokens ?? 0n) !== (usage.reasoning_tokens ?? 0n)
    || line.usage_quality !== usage.usage_quality) {
    throw new GatewayLedgerSettlementConflictError("usage_ledger_input_conflict");
  }
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function optionalDecimalEquals(
  actual: string | null,
  expected: string | null | undefined,
): boolean {
  return actual === null
    ? expected === null || expected === undefined
    : expected !== null && expected !== undefined && new Decimal(actual).eq(expected);
}

/** @internal 供结算不变量的定向变异测试复用。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "undefined";
}
