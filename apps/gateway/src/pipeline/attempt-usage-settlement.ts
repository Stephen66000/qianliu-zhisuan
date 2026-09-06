import type { Outcome } from "@qianliu/contracts";
import {
  type CreateUsageLedgerLineInput,
  summarizeLedgerUsageQuality,
  type FinalizeRejectedAttemptSettlementInput,
  type GatewayLedgerRepository,
  type PersistAttemptUsageAccountingInput,
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
  attemptResult: PersistAttemptUsageAccountingInput["attempt_result"];
  quotaSettlements?: FinalizeRejectedAttemptSettlementInput["quota_settlements"];
  releaseLeaseIds?: string[];
  overage?: boolean;
}

export interface PersistRejectedAttemptEvidenceInput extends Omit<
  FinalizeRejectedAttemptInput,
  "errorCode" | "overage" | "attemptResult"
> {
  /** failover 分支必填；Attempt 结果与零事实、额度、租约一起提交。 */
  attemptResult?: PersistAttemptUsageAccountingInput["attempt_result"];
}

export interface FinalizeFailedRequestFromPersistedFactsInput {
  ledgerRepo: GatewayLedgerRepository;
  requestId: string;
  enterpriseId: string;
  principalId: string;
  errorClassification: string;
  errorCode: string;
  quotaSettlements?: FinalizeRejectedAttemptSettlementInput["quota_settlements"];
  releaseLeaseIds?: string[];
  overage?: boolean;
}

/**
 * 每个已创建的真实 Attempt 都冻结 usage + ledger：已访问上游的结果按返回 Usage
 * 计量；确认未访问上游的 Attempt 由下方 helper 冻结为 UNKNOWN／零 Token 事实。
 */
export async function persistAttemptUsageEvidence(
  input: PersistAttemptUsageEvidenceInput,
): Promise<bigint | null> {
  const usage = input.outcome.usage;
  const billing = await resolveBilling(input, usage);
  const pricedApi = input.resourceMode === "API" && billing.apiCost !== null
    && (billing.currency === "CNY" || billing.currency === "USD");
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
      api_cost: pricedApi ? billing.apiCost : null,
      api_cost_currency: pricedApi ? billing.currency as "CNY" | "USD" : null,
      api_cost_status: input.resourceMode === "CODING_PLAN" ? "NOT_APPLICABLE"
        : pricedApi ? "PRICED_USAGE" : "UNKNOWN_COST",
      settled_at: new Date(),
      usage_quality: usage.quality,
      billing_rule_id: billing.ruleId,
      rule_version: billing.ruleVersion,
      multiplier: billing.multiplier,
      billing_rule_snapshot: billing.ruleSnapshot ? { ...billing.ruleSnapshot,
        pricingAt: new Date(input.attemptStartedAt).toISOString(), apiCost: billing.apiCost,
        deductedQuota: billing.deductedQuota, usageQuality: usage.quality } : null,
    },
  });
  return settlement.line.deducted_quota === null
    ? null
    : BigInt(settlement.line.deducted_quota);
}

/**
 * 已创建 Attempt、但最终授权栅栏在上游前拒绝时，冻结明确的零消费事实。
 * failover 分支同时原子完成 Attempt/额度/租约；terminal 分支仍交给 finalize 发布终态。
 */
export async function persistRejectedAttemptBeforeUpstreamEvidence(
  input: PersistRejectedAttemptEvidenceInput,
): Promise<void> {
  const evidence = rejectedAttemptEvidence(input);
  if (input.attemptResult) {
    await input.ledgerRepo.persistAttemptUsageAccountingIfAbsent({
      ...evidence,
      attempt_result: input.attemptResult,
      quota_settlements: input.quotaSettlements,
      release_lease_ids: input.releaseLeaseIds,
    });
    return;
  }
  if ((input.quotaSettlements?.length ?? 0) > 0 || (input.releaseLeaseIds?.length ?? 0) > 0) {
    throw new Error("nonterminal_attempt_result_required");
  }
  await input.ledgerRepo.createUsageAndLedgerLineIfAbsent(evidence);
}

function rejectedAttemptEvidence(input: Pick<
  FinalizeRejectedAttemptInput,
  "requestId" | "enterpriseId" | "principalId" | "attemptId" | "attemptNo"
  | "resourceId" | "resourceMode"
>): CreateUsageLedgerLineInput {
  return {
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
      // 已确认未访问上游：API 成本是精确 0，不是“未知”。否则后续成功
      // Attempt 的真实费用会被请求级未知行吞掉，错误聚合成 0。
      api_cost: input.resourceMode === "API" ? "0.00000000" : null,
      api_cost_currency: null,
      api_cost_status: input.resourceMode === "API"
        ? "CONFIRMED_ZERO_NO_UPSTREAM" : "NOT_APPLICABLE",
      settled_at: new Date(),
      usage_quality: "UNKNOWN",
      billing_rule_id: null,
      rule_version: null,
      multiplier: null,
      billing_rule_snapshot: null,
    },
  };
}

/** Attempt、零消费事实、请求失败终态及额度／租约由数据库一次提交。 */
export async function finalizeRejectedAttemptBeforeUpstream(
  input: FinalizeRejectedAttemptInput,
): Promise<void> {
  await input.ledgerRepo.finalizeRejectedAttemptSettlementIfAbsent({
    ...rejectedAttemptEvidence(input),
    attempt_result: input.attemptResult,
    overage: input.overage ?? false,
    error_classification: input.attemptResult.error_classification,
    error_code: input.errorCode,
    quota_settlements: input.quotaSettlements,
    release_lease_ids: input.releaseLeaseIds,
  });
}

/**
 * Attempt 已经冻结账本事实、但后续候选在创建 Attempt 前耗尽时，不能绕过请求级
 * 原子终结直接写 FAILED。仅在确有 ledger_line 时聚合并发布 transaction；额度和
 * 租约只接收尚未结算的 pending 项，已由非终态 Attempt 清算的资源不会重复处理。
 */
export async function finalizeFailedRequestFromPersistedFactsIfAny(
  input: FinalizeFailedRequestFromPersistedFactsInput,
): Promise<boolean> {
  const lines = await input.ledgerRepo.listLedgerLines(input.requestId);
  if (lines.length === 0) return false;
  const attempts = await input.ledgerRepo.listAttempts(input.requestId);
  const pricing = summarizePricingEvidence(lines);
  await input.ledgerRepo.finalizeLedgerSettlementIfAbsent({
    ai_request_id: input.requestId,
    enterprise_id: input.enterpriseId,
    principal_id: input.principalId,
    total_input_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_input_tokens), 0n),
    total_output_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_output_tokens), 0n),
    total_cache_tokens: lines.reduce((sum, line) => sum + BigInt(line.raw_cache_tokens), 0n),
    total_reasoning_tokens: lines.reduce(
      (sum, line) => sum + BigInt(line.raw_reasoning_tokens), 0n,
    ),
    total_deducted_quota: lines.reduce(
      (sum, line) => sum + BigInt(line.deducted_quota ?? 0), 0n,
    ),
    total_api_cost: pricing.actualCost ?? "0.00000000",
    usage_quality: summarizeLedgerUsageQuality(lines),
    attempt_count: attempts.length,
    overage: input.overage ?? false,
    request_status: "FAILED",
    error_classification: input.errorClassification,
    error_code: input.errorCode,
    quota_settlements: input.quotaSettlements,
    release_lease_ids: input.releaseLeaseIds,
  });
  return true;
}

async function resolveBilling(
  input: PersistAttemptUsageEvidenceInput,
  usage: Outcome["usage"],
): Promise<BillingOutcome> {
  if (usage.quality === "UNKNOWN"
    || (!hasMeasuredTokens(input.outcome) && usage.quality !== "PROVIDER_REPORTED")) {
    return {
      apiCost: null,
      currency: null,
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
