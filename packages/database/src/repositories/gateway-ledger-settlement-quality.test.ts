import { describe, expect, it } from "vitest";

import type {
  CreateAttemptInput,
  CreateLedgerTransactionInput,
  CreateUsageLedgerLineInput,
  LedgerLine,
  LedgerTransaction,
  UpstreamAttempt,
  UsageEvent,
} from "./gateway-ledger-types.js";
import {
  assertAttemptMatches,
  assertLineMatches,
  assertTransactionMatches,
  assertUsageLineInputCoherent,
  assertUsageMatches,
  optionalBigintEquals,
  optionalDecimalEquals,
  settleRequestAccounting,
  stableJson,
  summarizeLedgerUsageQuality,
} from "./gateway-ledger-settlement.js";
import {
  assertGuardedLedgerIdentity,
  hasSettlementFacts,
  isSameTerminalRequest,
} from "./gateway-ledger-guarded-writes.js";

const attemptInput: CreateAttemptInput = {
  ai_request_id: "request-1",
  enterprise_id: "enterprise-1",
  attempt_no: 1,
  provider_resource_id: "resource-1",
  upstream_model: "deepseek-chat",
};

const settlementInput: CreateUsageLedgerLineInput = {
  usage: {
    ai_request_id: "request-1",
    enterprise_id: "enterprise-1",
    upstream_attempt_id: "attempt-1",
    provider_resource_id: "resource-1",
    input_tokens: 40n,
    output_tokens: 5n,
    cache_tokens: 3n,
    reasoning_tokens: 2n,
    usage_quality: "PROVIDER_REPORTED",
    dedup_key: "dedup-1",
    upstream_usage_id: "provider-usage-1",
  },
  ledger_line: {
    ai_request_id: "request-1",
    enterprise_id: "enterprise-1",
    upstream_attempt_id: "attempt-1",
    provider_resource_id: "resource-1",
    principal_id: "principal-1",
    resource_mode: "API",
    raw_input_tokens: 40n,
    raw_output_tokens: 5n,
    raw_cache_tokens: 3n,
    raw_reasoning_tokens: 2n,
    deducted_quota: 48n,
    api_cost: "0.40000000",
    usage_quality: "PROVIDER_REPORTED",
    billing_rule_id: "rule-1",
    rule_version: "v1",
    multiplier: "1.25000000",
    billing_rule_snapshot: { price: "0.4", source: "POOL-043" },
  },
};

const transactionInput: CreateLedgerTransactionInput = {
  ai_request_id: "request-1",
  enterprise_id: "enterprise-1",
  principal_id: "principal-1",
  total_input_tokens: 40n,
  total_output_tokens: 5n,
  total_cache_tokens: 3n,
  total_reasoning_tokens: 2n,
  total_deducted_quota: 48n,
  total_api_cost: "0.40000000",
  overage: true,
  usage_quality: "PROVIDER_REPORTED",
  attempt_count: 1,
};

function asAttempt(overrides: Partial<UpstreamAttempt> = {}): UpstreamAttempt {
  return {
    id: "attempt-1",
    ...attemptInput,
    started_at: new Date("2026-08-09T00:00:00.000Z"),
    first_byte_at: null,
    finished_at: null,
    http_status: null,
    response_committed: false,
    error_classification: null,
    error_code: null,
    failure_layer: null,
    switch_reason: null,
    ...overrides,
  } as UpstreamAttempt;
}

function asUsage(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "usage-1",
    ...settlementInput.usage,
    reasoning_tokens: 2n,
    upstream_usage_id: "provider-usage-1",
    created_at: new Date("2026-08-09T00:00:00.000Z"),
    ...overrides,
  } as UsageEvent;
}

function asLine(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    id: "line-1",
    usage_event_id: "usage-1",
    ...settlementInput.ledger_line,
    raw_reasoning_tokens: 2n,
    deducted_quota: 48n,
    api_cost: "0.40000000",
    billing_rule_id: "rule-1",
    rule_version: "v1",
    multiplier: "1.25000000",
    billing_rule_snapshot: { source: "POOL-043", price: "0.4" },
    created_at: new Date("2026-08-09T00:00:00.000Z"),
    ...overrides,
  } as LedgerLine;
}

function asTransaction(overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
  return {
    id: "transaction-1",
    ...transactionInput,
    total_reasoning_tokens: 2n,
    overage: true,
    status: "SETTLED",
    created_at: new Date("2026-08-09T00:00:00.000Z"),
    ...overrides,
  } as LedgerTransaction;
}

function expectConflict(run: () => void, message: string): void {
  expect(run).toThrow(message);
}

function tracedAccountingDb(trace: {
  grantLocks: string[];
  quotaUpdates: Array<{ grantId: string; used: bigint }>;
  selectedLeases: string[];
  releasedLeases: string[];
  leaseOrderBy: Array<[string, string]>;
}): Parameters<typeof settleRequestAccounting>[0] {
  return {
    selectFrom(table: string) {
      let grantId = "";
      let leaseIds: string[] = [];
      const builder = {
        selectAll: () => builder,
        select: () => builder,
        where: (column: string, operator: string, value: unknown) => {
          if ((table === "quota_counter" && column === "grant_id")
            || (table === "principal_grant" && column === "id")) grantId = String(value);
          if (table === "concurrency_lease" && column === "id" && operator === "in") {
            leaseIds = value as string[];
          }
          return builder;
        },
        orderBy: (column: string, direction: string) => {
          trace.leaseOrderBy.push([column, direction]);
          return builder;
        },
        forUpdate: () => builder,
        executeTakeFirst: async () => {
          if (table === "quota_counter") {
            trace.grantLocks.push(grantId);
            return { used_value: 20n };
          }
          return {
            id: grantId,
            enterprise_id: "enterprise-1",
            principal_id: "principal-1",
            quota_value: 100n,
          };
        },
        execute: async () => {
          trace.selectedLeases = [...leaseIds];
          return leaseIds.map((id) => ({ id }));
        },
      };
      return builder;
    },
    updateTable(table: string) {
      let values: Record<string, unknown> = {};
      let grantId = "";
      let leaseIds: string[] = [];
      const builder = {
        set: (input: Record<string, unknown>) => {
          values = input;
          return builder;
        },
        where: (column: string, operator: string, value: unknown) => {
          if (table === "quota_counter" && column === "grant_id") grantId = String(value);
          if (table === "concurrency_lease" && column === "id" && operator === "in") {
            leaseIds = value as string[];
          }
          return builder;
        },
        execute: async () => {
          if (table === "quota_counter") {
            trace.quotaUpdates.push({ grantId, used: values.used_value as bigint });
          } else {
            trace.releasedLeases = [...leaseIds];
          }
          return [];
        },
      };
      return builder;
    },
  } as unknown as Parameters<typeof settleRequestAccounting>[0];
}

describe("POOL-043 transaction 用量质量", () => {
  it("无明细 fail-closed 为 UNKNOWN", () => {
    expect(summarizeLedgerUsageQuality([])).toBe("UNKNOWN");
  });

  it("单一质量原样冻结", () => {
    expect(summarizeLedgerUsageQuality([{ usage_quality: "PROVIDER_REPORTED" }]))
      .toBe("PROVIDER_REPORTED");
  });

  it("多质量排序后生成稳定 MIXED 口径，不依赖行顺序", () => {
    const forward = summarizeLedgerUsageQuality([
      { usage_quality: "UNKNOWN" },
      { usage_quality: "PROVIDER_REPORTED" },
      { usage_quality: "UNKNOWN" },
    ]);
    const reverse = summarizeLedgerUsageQuality([
      { usage_quality: "PROVIDER_REPORTED" },
      { usage_quality: "UNKNOWN" },
    ]);
    expect(forward).toBe("MIXED:PROVIDER_REPORTED+UNKNOWN");
    expect(reverse).toBe(forward);
  });
});

describe("POOL-043 资源结算锁序", () => {
  it("Grant 与 Lease 去重排序后锁定，并合并同 Grant 调整", async () => {
    const trace = {
      grantLocks: [] as string[],
      quotaUpdates: [] as Array<{ grantId: string; used: bigint }>,
      selectedLeases: [] as string[],
      releasedLeases: [] as string[],
      leaseOrderBy: [] as Array<[string, string]>,
    };
    await settleRequestAccounting(tracedAccountingDb(trace), {
      ai_request_id: "request-1",
      enterprise_id: "enterprise-1",
      principal_id: "principal-1",
      quota_settlements: [
        { grant_id: "grant-z", reserved_estimate: 10n, actual_deducted: 2n },
        { grant_id: "grant-a", reserved_estimate: 4n, actual_deducted: 1n },
        { grant_id: "grant-z", reserved_estimate: 5n, actual_deducted: 3n },
      ],
      release_lease_ids: ["lease-z", "lease-a", "lease-z"],
    }, new Date("2026-08-10T00:00:00Z"));

    expect(trace.grantLocks).toEqual(["grant-a", "grant-z"]);
    expect(trace.quotaUpdates).toEqual([
      { grantId: "grant-a", used: 17n },
      { grantId: "grant-z", used: 10n },
    ]);
    expect(trace.selectedLeases).toEqual(["lease-a", "lease-z"]);
    expect(trace.releasedLeases).toEqual(["lease-a", "lease-z"]);
    expect(trace.leaseOrderBy).toEqual([["id", "asc"]]);
  });
});

describe("POOL-043 结算事实逐字段不变量", () => {
  it("Attempt 的五个身份字段全部参与重复检测", () => {
    expect(() => assertAttemptMatches(asAttempt(), attemptInput)).not.toThrow();
    const mismatches: Array<Partial<UpstreamAttempt>> = [
      { enterprise_id: "enterprise-2" },
      { ai_request_id: "request-2" },
      { attempt_no: 2 },
      { provider_resource_id: "resource-2" },
      { upstream_model: "deepseek-reasoner" },
    ];
    for (const mismatch of mismatches) {
      expectConflict(
        () => assertAttemptMatches(asAttempt(mismatch), attemptInput),
        "attempt_identity_conflict",
      );
    }
  });

  it("Usage 的身份、Token、质量与上游 ID 全部参与去重检测", () => {
    expect(() => assertUsageMatches(asUsage(), settlementInput)).not.toThrow();
    const mismatches: Array<Partial<UsageEvent>> = [
      { ai_request_id: "request-2" },
      { enterprise_id: "enterprise-2" },
      { upstream_attempt_id: "attempt-2" },
      { provider_resource_id: "resource-2" },
      { input_tokens: 41n },
      { output_tokens: 6n },
      { cache_tokens: 4n },
      { reasoning_tokens: 3n },
      { usage_quality: "ESTIMATED" },
      { upstream_usage_id: "provider-usage-2" },
    ];
    for (const mismatch of mismatches) {
      expectConflict(
        () => assertUsageMatches(asUsage(mismatch), settlementInput),
        "usage_dedup_conflict",
      );
    }
    const omitted = {
      ...settlementInput,
      usage: { ...settlementInput.usage, reasoning_tokens: undefined, upstream_usage_id: undefined },
    };
    expect(() => assertUsageMatches(asUsage({ reasoning_tokens: 0n, upstream_usage_id: null }), omitted))
      .not.toThrow();
  });

  it("Ledger Line 的所有冻结事实全部参与去重检测", () => {
    expect(() => assertLineMatches(asLine(), settlementInput)).not.toThrow();
    const mismatches: Array<Partial<LedgerLine>> = [
      { ai_request_id: "request-2" },
      { enterprise_id: "enterprise-2" },
      { upstream_attempt_id: "attempt-2" },
      { provider_resource_id: "resource-2" },
      { principal_id: "principal-2" },
      { resource_mode: "CODING_PLAN" },
      { raw_input_tokens: 41n },
      { raw_output_tokens: 6n },
      { raw_cache_tokens: 4n },
      { raw_reasoning_tokens: 3n },
      { deducted_quota: 49n },
      { api_cost: "0.41" },
      { usage_quality: "ESTIMATED" },
      { billing_rule_id: "rule-2" },
      { rule_version: "v2" },
      { multiplier: "1.3" },
      { billing_rule_snapshot: { source: "changed" } },
    ];
    for (const mismatch of mismatches) {
      expectConflict(
        () => assertLineMatches(asLine(mismatch), settlementInput),
        "ledger_line_conflict",
      );
    }
    const omitted = {
      ...settlementInput,
      ledger_line: {
        ...settlementInput.ledger_line,
        raw_reasoning_tokens: undefined,
        deducted_quota: undefined,
        api_cost: undefined,
        billing_rule_id: undefined,
        rule_version: undefined,
        multiplier: undefined,
        billing_rule_snapshot: undefined,
      },
    };
    expect(() => assertLineMatches(asLine({
      raw_reasoning_tokens: 0n,
      deducted_quota: null,
      api_cost: null,
      billing_rule_id: null,
      rule_version: null,
      multiplier: null,
      billing_rule_snapshot: null,
    }), omitted)).not.toThrow();
  });

  it("Transaction 的汇总、超额、质量、次数与状态全部参与幂等检测", () => {
    expect(() => assertTransactionMatches(asTransaction(), transactionInput)).not.toThrow();
    const mismatches: Array<Partial<LedgerTransaction>> = [
      { ai_request_id: "request-2" },
      { enterprise_id: "enterprise-2" },
      { principal_id: "principal-2" },
      { total_input_tokens: 41n },
      { total_output_tokens: 6n },
      { total_cache_tokens: 4n },
      { total_reasoning_tokens: 3n },
      { total_deducted_quota: 49n },
      { total_api_cost: "0.41" },
      { overage: false },
      { usage_quality: "ESTIMATED" },
      { attempt_count: 2 },
      { status: "PENDING" },
    ];
    for (const mismatch of mismatches) {
      expectConflict(
        () => assertTransactionMatches(asTransaction(mismatch), transactionInput),
        "ledger_transaction_conflict",
      );
    }
    const omitted = {
      ...transactionInput,
      total_reasoning_tokens: undefined,
      overage: undefined,
    };
    expect(() => assertTransactionMatches(asTransaction({
      total_reasoning_tokens: 0n,
      overage: false,
    }), omitted)).not.toThrow();
  });

  it("Usage 与 Ledger 输入必须逐字段一致", () => {
    expect(() => assertUsageLineInputCoherent(settlementInput)).not.toThrow();
    const mismatches: Array<Partial<CreateUsageLedgerLineInput["ledger_line"]>> = [
      { ai_request_id: "request-2" },
      { enterprise_id: "enterprise-2" },
      { upstream_attempt_id: "attempt-2" },
      { provider_resource_id: "resource-2" },
      { raw_input_tokens: 41n },
      { raw_output_tokens: 6n },
      { raw_cache_tokens: 4n },
      { raw_reasoning_tokens: 3n },
      { usage_quality: "ESTIMATED" },
    ];
    for (const mismatch of mismatches) {
      expectConflict(
        () => assertUsageLineInputCoherent({
          ...settlementInput,
          ledger_line: { ...settlementInput.ledger_line, ...mismatch },
        }),
        "usage_ledger_input_conflict",
      );
    }
    expect(() => assertUsageLineInputCoherent({
      usage: { ...settlementInput.usage, reasoning_tokens: undefined },
      ledger_line: { ...settlementInput.ledger_line, raw_reasoning_tokens: undefined },
    })).not.toThrow();
  });

  it("可选 bigint 与 decimal 严格区分空值，并允许数值等价表示", () => {
    expect(optionalBigintEquals(null, undefined)).toBe(true);
    expect(optionalBigintEquals(null, null)).toBe(true);
    expect(optionalBigintEquals(null, 0n)).toBe(false);
    expect(optionalBigintEquals(0n, undefined)).toBe(false);
    expect(optionalBigintEquals(0n, null)).toBe(false);
    expect(optionalBigintEquals(0n, 0n)).toBe(true);
    expect(optionalBigintEquals(1n, 0n)).toBe(false);

    expect(optionalDecimalEquals(null, undefined)).toBe(true);
    expect(optionalDecimalEquals(null, null)).toBe(true);
    expect(optionalDecimalEquals(null, "0")).toBe(false);
    expect(optionalDecimalEquals("0", undefined)).toBe(false);
    expect(optionalDecimalEquals("0", null)).toBe(false);
    expect(optionalDecimalEquals("0.40000000", "0.4")).toBe(true);
    expect(optionalDecimalEquals("0.41", "0.4")).toBe(false);
  });

  it("JSON 快照按键稳定、数组保序，并区分 primitive 与 undefined", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(stableJson({ a: { c: 3, d: 4 }, b: 2 }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(stableJson([2, 1, null])).toBe("[2,1,null]");
    expect(stableJson("POOL-043")).toBe('"POOL-043"');
    expect(stableJson(undefined)).toBe("undefined");
  });
});

describe("POOL-043 兼容写入口纯不变量", () => {
  it("终态幂等同时比较状态、错误分类与错误码", () => {
    const terminal = {
      status: "FAILED",
      error_classification: "UPSTREAM_ERROR",
      error_code: "provider_timeout",
    };
    expect(isSameTerminalRequest(
      terminal, "FAILED", "UPSTREAM_ERROR", "provider_timeout",
    )).toBe(true);
    expect(isSameTerminalRequest(
      terminal, "SUCCEEDED", "UPSTREAM_ERROR", "provider_timeout",
    )).toBe(false);
    expect(isSameTerminalRequest(
      terminal, "FAILED", "CLIENT_ERROR", "provider_timeout",
    )).toBe(false);
    expect(isSameTerminalRequest(
      terminal, "FAILED", "UPSTREAM_ERROR", "different_code",
    )).toBe(false);
  });

  it("任意 attempt、usage、line、transaction 存在都算结算事实", () => {
    expect(hasSettlementFacts(0, undefined, undefined, undefined)).toBe(false);
    expect(hasSettlementFacts(1, undefined, undefined, undefined)).toBe(true);
    expect(hasSettlementFacts(0, { id: "usage" }, undefined, undefined)).toBe(true);
    expect(hasSettlementFacts(0, undefined, { id: "line" }, undefined)).toBe(true);
    expect(hasSettlementFacts(0, undefined, undefined, { id: "transaction" })).toBe(true);
  });

  it("兼容 Ledger 入口逐字段闭合租户、请求、Attempt、资源、模式与主体", () => {
    const usage = {
      ai_request_id: settlementInput.ledger_line.ai_request_id,
      enterprise_id: settlementInput.ledger_line.enterprise_id,
      upstream_attempt_id: settlementInput.ledger_line.upstream_attempt_id,
      provider_resource_id: settlementInput.ledger_line.provider_resource_id,
      resource_enterprise_id: settlementInput.ledger_line.enterprise_id,
      mode: settlementInput.ledger_line.resource_mode,
    };
    expect(() => assertGuardedLedgerIdentity(
      usage, settlementInput.ledger_line.principal_id, {
        ...settlementInput.ledger_line, usage_event_id: "usage-1",
      },
    )).not.toThrow();
    expectConflict(
      () => assertGuardedLedgerIdentity(
        undefined, settlementInput.ledger_line.principal_id, {
          ...settlementInput.ledger_line, usage_event_id: "usage-1",
        },
      ),
      "ledger_usage_conflict",
    );
    const mismatches: Array<[Partial<typeof usage>, string]> = [
      [{ ai_request_id: "request-2" }, settlementInput.ledger_line.principal_id],
      [{ enterprise_id: "enterprise-2" }, settlementInput.ledger_line.principal_id],
      [{ upstream_attempt_id: "attempt-2" }, settlementInput.ledger_line.principal_id],
      [{ provider_resource_id: "resource-2" }, settlementInput.ledger_line.principal_id],
      [{ resource_enterprise_id: "enterprise-2" }, settlementInput.ledger_line.principal_id],
      [{ mode: "CODING_PLAN" }, settlementInput.ledger_line.principal_id],
      [{}, "principal-2"],
    ];
    for (const [changed, principalId] of mismatches) {
      expectConflict(
        () => assertGuardedLedgerIdentity(
          { ...usage, ...changed }, principalId, {
            ...settlementInput.ledger_line, usage_event_id: "usage-1",
          },
        ),
        "ledger_usage_conflict",
      );
    }
  });
});
