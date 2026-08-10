import type { GatewayLedgerRepository } from "@qianliu/database";
import { describe, expect, it, vi } from "vitest";

import {
  finalizeFailedRequestFromPersistedFactsIfAny,
  finalizeRejectedAttemptBeforeUpstream,
} from "./attempt-usage-settlement.js";

describe("POOL-043 上游前撤权结算", () => {
  it("把 Attempt、零消费事实、资源结算和失败终态交给单一原子入口", async () => {
    const finalizeRejectedAttemptSettlementIfAbsent = vi.fn().mockResolvedValue(undefined);
    const ledgerRepo = {
      finalizeRejectedAttemptSettlementIfAbsent,
    } as unknown as GatewayLedgerRepository;
    const attemptResult = {
      http_status: 403,
      response_committed: false,
      finished_at: new Date("2026-08-10T00:00:00Z"),
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "principal_grant_required",
      switch_reason: null,
    };

    await finalizeRejectedAttemptBeforeUpstream({
      ledgerRepo,
      requestId: "request-1",
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      attemptId: "attempt-2",
      attemptNo: 2,
      resourceId: "resource-1",
      resourceMode: "CODING_PLAN",
      errorCode: "principal_grant_required",
      attemptResult,
      quotaSettlements: [{
        grant_id: "grant-1", reserved_estimate: 18n, actual_deducted: 0n,
      }],
      releaseLeaseIds: ["lease-1"],
      overage: true,
    });

    expect(finalizeRejectedAttemptSettlementIfAbsent).toHaveBeenCalledTimes(1);
    expect(finalizeRejectedAttemptSettlementIfAbsent).toHaveBeenCalledWith({
      usage: expect.objectContaining({
        ai_request_id: "request-1",
        upstream_attempt_id: "attempt-2",
        input_tokens: 0n,
        output_tokens: 0n,
        cache_tokens: 0n,
        reasoning_tokens: 0n,
        usage_quality: "UNKNOWN",
        dedup_key: "request-1:attempt2",
      }),
      ledger_line: expect.objectContaining({
        principal_id: "principal-1",
        resource_mode: "CODING_PLAN",
        deducted_quota: null,
        api_cost: null,
        usage_quality: "UNKNOWN",
        billing_rule_id: null,
        rule_version: null,
      }),
      attempt_result: attemptResult,
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "principal_grant_required",
      quota_settlements: [{
        grant_id: "grant-1", reserved_estimate: 18n, actual_deducted: 0n,
      }],
      release_lease_ids: ["lease-1"],
      overage: true,
    });
  });

  it("failover 已有结算事实时聚合发布 FAILED，且不重复结算已释放资源", async () => {
    const finalizeLedgerSettlementIfAbsent = vi.fn().mockResolvedValue(undefined);
    const ledgerRepo = {
      listLedgerLines: vi.fn().mockResolvedValue([{
        raw_input_tokens: 12n,
        raw_output_tokens: 4n,
        raw_cache_tokens: 2n,
        raw_reasoning_tokens: 1n,
        deducted_quota: null,
        api_cost: "0.12345678",
        resource_mode: "API",
        usage_quality: "PROVIDER_REPORTED",
        provider_resource_id: "resource-1",
        billing_rule_id: "rule-1",
        rule_version: "v1",
        billing_rule_snapshot: {},
      }, {
        raw_input_tokens: 3n,
        raw_output_tokens: 5n,
        raw_cache_tokens: 1n,
        raw_reasoning_tokens: 2n,
        deducted_quota: 7n,
        api_cost: null,
        resource_mode: "CODING_PLAN",
        usage_quality: "UNKNOWN",
        provider_resource_id: "resource-2",
        billing_rule_id: "rule-2",
        rule_version: "v2",
        billing_rule_snapshot: {},
      }]),
      listAttempts: vi.fn().mockResolvedValue([{ id: "attempt-1" }, { id: "attempt-2" }]),
      finalizeLedgerSettlementIfAbsent,
    } as unknown as GatewayLedgerRepository;

    await expect(finalizeFailedRequestFromPersistedFactsIfAny({
      ledgerRepo,
      requestId: "request-1",
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      errorClassification: "DOWNSTREAM_AUTH_OR_QUOTA",
      errorCode: "principal_grant_required",
      overage: true,
    })).resolves.toBe(true);

    expect(finalizeLedgerSettlementIfAbsent).toHaveBeenCalledTimes(1);
    expect(finalizeLedgerSettlementIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      ai_request_id: "request-1",
      total_input_tokens: 15n,
      total_output_tokens: 9n,
      total_cache_tokens: 3n,
      total_reasoning_tokens: 3n,
      total_deducted_quota: 7n,
      total_api_cost: "0.12345678",
      usage_quality: "MIXED:PROVIDER_REPORTED+UNKNOWN",
      attempt_count: 2,
      request_status: "FAILED",
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "principal_grant_required",
      overage: true,
      quota_settlements: undefined,
      release_lease_ids: undefined,
    }));
  });

  it("仅有套餐零事实时 API 成本回落为零且默认不标记超额", async () => {
    const finalizeLedgerSettlementIfAbsent = vi.fn().mockResolvedValue(undefined);
    const ledgerRepo = {
      listLedgerLines: vi.fn().mockResolvedValue([{
        raw_input_tokens: 0n,
        raw_output_tokens: 0n,
        raw_cache_tokens: 0n,
        raw_reasoning_tokens: 0n,
        deducted_quota: null,
        api_cost: null,
        resource_mode: "CODING_PLAN",
        usage_quality: "UNKNOWN",
        provider_resource_id: "resource-1",
        billing_rule_id: null,
        rule_version: null,
        billing_rule_snapshot: null,
      }]),
      listAttempts: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
      finalizeLedgerSettlementIfAbsent,
    } as unknown as GatewayLedgerRepository;

    await finalizeFailedRequestFromPersistedFactsIfAny({
      ledgerRepo,
      requestId: "request-2",
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      errorClassification: "NO_HEALTHY_CANDIDATE",
      errorCode: "no_healthy_candidate",
    });

    expect(finalizeLedgerSettlementIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      total_api_cost: "0.00000000",
      overage: false,
    }));
  });

  it("尚无账本事实时保留普通状态更新路径", async () => {
    const finalizeLedgerSettlementIfAbsent = vi.fn();
    const ledgerRepo = {
      listLedgerLines: vi.fn().mockResolvedValue([]),
      listAttempts: vi.fn(),
      finalizeLedgerSettlementIfAbsent,
    } as unknown as GatewayLedgerRepository;

    await expect(finalizeFailedRequestFromPersistedFactsIfAny({
      ledgerRepo,
      requestId: "request-2",
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      errorClassification: "NO_HEALTHY_CANDIDATE",
      errorCode: "no_healthy_candidate",
    })).resolves.toBe(false);
    expect(ledgerRepo.listAttempts).not.toHaveBeenCalled();
    expect(finalizeLedgerSettlementIfAbsent).not.toHaveBeenCalled();
  });
});
