import type { GatewayLedgerRepository } from "@qianliu/database";
import { describe, expect, it, vi } from "vitest";

import { finalizeRejectedAttemptBeforeUpstream } from "./attempt-usage-settlement.js";

describe("POOL-043 上游前撤权结算", () => {
  it("冻结零消费事实并按实际 Attempt 数发布失败终态", async () => {
    const createUsageAndLedgerLineIfAbsent = vi.fn().mockResolvedValue({
      line: { deducted_quota: null },
    });
    const listAttempts = vi.fn().mockResolvedValue([{ id: "attempt-1" }, { id: "attempt-2" }]);
    const listLedgerLines = vi.fn().mockResolvedValue([
      {
        raw_input_tokens: 12n, raw_output_tokens: 3n, raw_cache_tokens: 2n,
        raw_reasoning_tokens: 1n, deducted_quota: 18n, api_cost: null,
        resource_mode: "CODING_PLAN", usage_quality: "PROVIDER_REPORTED",
      },
      {
        raw_input_tokens: 0n, raw_output_tokens: 0n, raw_cache_tokens: 0n,
        raw_reasoning_tokens: 0n, deducted_quota: null, api_cost: null,
        resource_mode: "CODING_PLAN", usage_quality: "UNKNOWN",
      },
    ]);
    const finalizeLedgerSettlementIfAbsent = vi.fn().mockResolvedValue(undefined);
    const ledgerRepo = {
      createUsageAndLedgerLineIfAbsent,
      listAttempts,
      listLedgerLines,
      finalizeLedgerSettlementIfAbsent,
    } as unknown as GatewayLedgerRepository;

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
    });

    expect(createUsageAndLedgerLineIfAbsent).toHaveBeenCalledWith({
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
    });
    expect(listAttempts).toHaveBeenCalledWith("request-1");
    expect(finalizeLedgerSettlementIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      ai_request_id: "request-1",
      total_input_tokens: 12n,
      total_output_tokens: 3n,
      total_deducted_quota: 18n,
      total_api_cost: "0.00000000",
      usage_quality: "MIXED:PROVIDER_REPORTED+UNKNOWN",
      attempt_count: 2,
      request_status: "FAILED",
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "principal_grant_required",
    }));
  });
});
