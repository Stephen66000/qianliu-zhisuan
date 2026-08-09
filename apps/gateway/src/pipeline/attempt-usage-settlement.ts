import type { Outcome } from "@qianliu/contracts";
import {
  summarizeLedgerUsageQuality,
  type FinalizeLedgerSettlementInput,
  type GatewayLedgerRepository,
} from "@qianliu/database";
import type { BillingRule } from "@qianliu/domain";

import { computeBillingFromRule, type BillingOutcome } from "./billing.js";
import { summarizePricingEvidence } from "./pricing-evidence.js";

export interface PersistAttemptUsageEvidenceInput {
  ledgerRepo: GatewayLedgerRepository;
  outcome: Outcome;
  requestId: string;
  enterpriseId: string;
  principalId: string;
  attemptId: string;
  attemptNo: number;
  attemptStartedAt: number;
  resourceId: string;
  resourceMode: "API" | "CODING_PLAN";
  upstreamModel: string;
  billingRule: BillingRule;
}

export interface FinalizeRejectedAttemptInput {
  ledgerRepo: GatewayLedgerRepository;
  requestId: string;
  enterpriseId: string;
  principalId: string;
  attemptId: string;
  attemptNo: number;
  resourceId: string;
  resourceMode: "API" | "CODING_PLAN";
  errorCode: string;
  quotaSettlements?: FinalizeLedgerSettlementInput["quota_settlements"];
  releaseLeaseIds?: string[];
  overage?: boolean;
}

/**
 * 每个可能产生消费的真实 Attempt 都冻结 usage + ledger。
 * 上游前即失败且 UNKNOWN/零 Token 的 Attempt 不进入经营账；已提交流、
 * 非 UNKNOWN 或携带任一 Token 事实的结果必须可在请求明细中追溯。
 */
export async function persistAttemptUsageEvidence(
  input: PersistAttemptUsageEvidenceInput,
): Promise<bigint | null> {
  const usage = input.outcome.usage;
  const billing = await resolveBilling(input, usage);
  const settlement = await input.ledgerRepo.createUsageAndLedgerLineIfAbsent({
    usage: {
      ai_request_id: input.requestId,
      enterprise_id: input.enterpriseId,
      upstream_attempt_id: input.attemptId,
      provider_resource_id: input.resourceId,
      input_tokens: BigInt(usage.input),
      output_tokens: BigInt(usage.output),
      cache_tokens: BigInt(usage.cache),
      reasoning_tokens: BigInt(usage.reasoning ?? 0),
      usage_quality: usage.quality,
      dedup_key: `${input.requestId}:attempt${input.attemptNo}`,
    },
    ledger_line: {
      ai_request_id: input.requestId,
      enterprise_id: input.enterpriseId,
      upstream_attempt_id: input.attemptId,
      provider_resource_id: input.resourceId,
      principal_id: input.principalId,
      resource_mode: input.resourceMode,
      raw_input_tokens: BigInt(usage.input),
      raw_output_tokens: BigInt(usage.output),
      raw_cache_tokens: BigInt(usage.cache),
      raw_reasoning_tokens: BigInt(usage.reasoning ?? 0),
      deducted_quota: billing.deductedQuota === null ? null : BigInt(billing.deductedQuota),
      api_cost: billing.apiCost,
      usage_quality: usage.quality,
      billing_rule_id: billing.ruleId,
      rule_version: billing.ruleVersion,
      multiplier: billing.multiplier,
      billing_rule_snapshot: billing.ruleSnapshot,
    },
  });
  return settlement.line.deducted_quota === null
    ? null
    : BigInt(settlement.line.deducted_quota);
}

/**
 * 已创建 Attempt、但最终授权栅栏在上游前拒绝时，冻结明确的零消费事实并原子发布终态。
 * 这样 completed Attempt 不会绕过 finalize，也不会把“无 ledger”误解释为未知丢账。
 */
export async function finalizeRejectedAttemptBeforeUpstream(
  input: FinalizeRejectedAttemptInput,
): Promise<void> {
  await input.ledgerRepo.createUsageAndLedgerLineIfAbsent({
    usage: {
      ai_request_id: input.requestId,
      enterprise_id: input.enterpriseId,
      upstream_attempt_id: input.attemptId,
      provider_resource_id: input.resourceId,
      input_tokens: 0n,
      output_tokens: 0n,
      cache_tokens: 0n,
      reasoning_tokens: 0n,
      usage_quality: "UNKNOWN",
      dedup_key: `${input.requestId}:attempt${input.attemptNo}`,
    },
    ledger_line: {
      ai_request_id: input.requestId,
      enterprise_id: input.enterpriseId,
      upstream_attempt_id: input.attemptId,
      provider_resource_id: input.resourceId,
      principal_id: input.principalId,
      resource_mode: input.resourceMode,
      raw_input_tokens: 0n,
      raw_output_tokens: 0n,
      raw_cache_tokens: 0n,
      raw_reasoning_tokens: 0n,
      deducted_quota: null,
      api_cost: null,
      usage_quality: "UNKNOWN",
      billing_rule_id: null,
      rule_version: null,
      multiplier: null,
      billing_rule_snapshot: null,
    },
  });
  const [attempts, lines] = await Promise.all([
    input.ledgerRepo.listAttempts(input.requestId),
    input.ledgerRepo.listLedgerLines(input.requestId),
  ]);
  const pricing = summarizePricingEvidence(lines);
  await input.ledgerRepo.finalizeLedgerSettlementIfAbsent({
    ai_request_id: input.requestId,
    enterprise_id: input.enterpriseId,
    principal_id: input.principalId,
    total_input_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_input_tokens), 0n),
    total_output_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_output_tokens), 0n),
    total_cache_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_cache_tokens), 0n),
    total_reasoning_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_reasoning_tokens), 0n),
    total_deducted_quota: lines.reduce((sum, line) => sum + BigInt(line.deducted_quota ?? 0), 0n),
    total_api_cost: pricing.actualCost ?? "0.00000000",
    usage_quality: summarizeLedgerUsageQuality(lines),
    attempt_count: attempts.length,
    overage: input.overage ?? false,
    request_status: "FAILED",
    error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
    error_code: input.errorCode,
    quota_settlements: input.quotaSettlements,
    release_lease_ids: input.releaseLeaseIds,
  });
}

async function resolveBilling(
  input: PersistAttemptUsageEvidenceInput,
  usage: Outcome["usage"],
): Promise<BillingOutcome> {
  if (usage.quality === "UNKNOWN"
    || (!hasMeasuredTokens(input.outcome) && usage.quality !== "PROVIDER_REPORTED")) {
    return {
      apiCost: null,
      deductedQuota: null,
      ruleId: null,
      ruleVersion: null,
      multiplier: null,
      ruleSnapshot: null,
    };
  }
  return computeBillingFromRule(
    input.billingRule,
    input.resourceMode,
    input.attemptStartedAt,
    usage,
  );
}

function hasMeasuredTokens(outcome: Outcome): boolean {
  const usage = outcome.usage;
  return usage.input > 0
    || usage.output > 0
    || usage.cache > 0
    || (usage.reasoning ?? 0) > 0;
}
