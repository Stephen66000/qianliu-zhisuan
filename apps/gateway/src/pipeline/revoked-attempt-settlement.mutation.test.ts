import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type {
  Database,
  GatewayLedgerRepository,
  QuotaGateRepository,
  ResourcePoolRepository,
} from "@qianliu/database";
import type { RoutingCandidateInput } from "@qianliu/domain";

import { persistRejectedAttemptBeforeUpstreamEvidence } from "./attempt-usage-settlement.js";
import {
  hasCurrentKeyModelAuthorization,
  settleRevokedAttempt,
  type SettleRevokedAttemptInput,
} from "./revoked-attempt-settlement.js";

function authorizationDb(options: {
  key?: { allowed_model_ids: string[] | null; expires_at: Date | null } | false;
  modelExists?: boolean;
} = {}): Kysely<Database> {
  const results = [
    options.key === false
      ? undefined
      : options.key ?? { allowed_model_ids: ["model-1"], expires_at: null },
    options.modelExists === false ? undefined : { id: "model-1" },
  ];
  let query = 0;
  const selectFrom = vi.fn((table: string) => {
    const keyQuery = query === 0;
    let valid = table === (keyQuery ? "principal_key" : "unified_model");
    let whereIndex = 0;
    const expectedWhere = keyQuery
      ? [
          ["principal_key.id", "=", "key-1"],
          ["principal_key.enterprise_id", "=", "enterprise-1"],
          ["principal_key.principal_id", "=", "principal-1"],
          ["principal_key.status", "=", "ACTIVE"],
          ["principal.status", "=", "ACTIVE"],
        ]
      : [
          ["enterprise_id", "=", "enterprise-1"],
          ["alias", "=", "qianliu-kimi-k3"],
          ["status", "=", "ACTIVE"],
          ["id", "in", ["model-1"]],
        ];
    const same = (actual: unknown[], expected: unknown[]) =>
      JSON.stringify(actual) === JSON.stringify(expected);
    const builder = {
      innerJoin: vi.fn((...args: unknown[]) => {
        valid &&= keyQuery && same(args, ["principal", "principal.id", "principal_key.principal_id"]);
        return builder;
      }),
      select: vi.fn((selection: unknown) => {
        valid &&= same(
          [selection],
          keyQuery
            ? [[
                "principal_key.allowed_model_ids as allowed_model_ids",
                "principal_key.expires_at as expires_at",
              ]]
            : ["id"],
        );
        return builder;
      }),
      where: vi.fn((...args: unknown[]) => {
        valid &&= same(args, expectedWhere[whereIndex] ?? []);
        whereIndex += 1;
        return builder;
      }),
      executeTakeFirst: vi.fn(async () => {
        if (!valid || whereIndex !== expectedWhere.length) {
          throw new Error("unexpected authorization query");
        }
        const result = results[query];
        query += 1;
        return result;
      }),
    };
    return builder;
  });
  return { selectFrom } as unknown as Kysely<Database>;
}

function candidate(id: string, routeId: string): RoutingCandidateInput {
  return {
    routeId,
    resourceId: id,
    upstreamModel: "kimi-k3",
    priority: 100,
    weight: 1,
    status: "ACTIVE",
    probe: false,
    mode: "CODING_PLAN",
    providerCode: "kimi",
  };
}

function ledgerMock() {
  return {
    persistAttemptUsageAccountingIfAbsent: vi.fn().mockResolvedValue(undefined),
    createUsageAndLedgerLineIfAbsent: vi.fn().mockResolvedValue(undefined),
    updateAttemptResult: vi.fn().mockResolvedValue(undefined),
    listAttempts: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
    listLedgerLines: vi.fn().mockResolvedValue([]),
    finalizeLedgerSettlementIfAbsent: vi.fn().mockResolvedValue(undefined),
    finalizeRejectedAttemptSettlementIfAbsent: vi.fn().mockResolvedValue(undefined),
  };
}

function revokedInput(options: {
  db?: Kysely<Database>;
  grantCurrent?: boolean;
  attemptNo?: number;
  maxAttempts?: number;
  probeReleaseRejects?: boolean;
  probeLease?: boolean;
  triedResourceIds?: Set<string>;
  hasCurrentReservation?: boolean;
} = {}) {
  const selected = candidate("resource-1", "route-1");
  const backup = candidate("resource-2", "route-2");
  const ledger = ledgerMock();
  const quota = {
    hasActiveGrant: vi.fn().mockResolvedValue(options.grantCurrent ?? true),
  };
  const releaseHalfOpenProbe = options.probeReleaseRejects
    ? vi.fn().mockRejectedValue(new Error("release failed"))
    : vi.fn().mockResolvedValue(undefined);
  const pool = { releaseHalfOpenProbe };
  const log = { error: vi.fn() };
  const input: SettleRevokedAttemptInput = {
    db: options.db ?? authorizationDb(),
    ledgerRepo: ledger as unknown as GatewayLedgerRepository,
    quotaRepo: quota as unknown as QuotaGateRepository,
    poolRepo: pool as unknown as ResourcePoolRepository,
    log: log as unknown as FastifyBaseLogger,
    enterpriseId: "enterprise-1",
    principalId: "principal-1",
    keyId: "key-1",
    modelAlias: "qianliu-kimi-k3",
    requestId: "request-1",
    attemptId: "attempt-1",
    attemptNo: options.attemptNo ?? 1,
    candidate: selected,
    candidates: [selected, backup],
    triedResourceIds: options.triedResourceIds ?? new Set([selected.resourceId]),
    affinityResourceId: null,
    maxAttempts: options.maxAttempts ?? 2,
    grantId: options.hasCurrentReservation === false ? null : "grant-1",
    reservedEstimate: 321n,
    leaseId: options.hasCurrentReservation === false ? null : "lease-1",
    pendingQuotaSettlements: [{
      grant_id: "old-grant",
      reserved_estimate: 10n,
      actual_deducted: 5n,
    }],
    pendingLeaseIds: ["old-lease"],
    requestOverage: true,
    probeLease: options.probeLease === false
      ? null
      : { resourceId: selected.resourceId, acquiredAt: new Date("2026-08-10T00:00:00Z") },
  };
  return { input, selected, backup, ledger, quota, pool, log };
}

describe("POOL-040 mutation：上游前拒绝清算合同", () => {
  it("Key 缺失、过期边界、空白名单和模型缺失均 fail-closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    try {
      const input = ["enterprise-1", "principal-1", "key-1", "qianliu-kimi-k3"] as const;
      await expect(hasCurrentKeyModelAuthorization(authorizationDb({ key: false }), ...input))
        .resolves.toBe(false);
      await expect(hasCurrentKeyModelAuthorization(authorizationDb({
        key: { allowed_model_ids: ["model-1"], expires_at: new Date("2026-08-10T00:00:00Z") },
      }), ...input)).resolves.toBe(false);
      await expect(hasCurrentKeyModelAuthorization(authorizationDb({
        key: { allowed_model_ids: null, expires_at: null },
      }), ...input)).resolves.toBe(false);
      await expect(hasCurrentKeyModelAuthorization(authorizationDb({
        key: { allowed_model_ids: [], expires_at: null },
      }), ...input)).resolves.toBe(false);
      await expect(hasCurrentKeyModelAuthorization(authorizationDb({ modelExists: false }), ...input))
        .resolves.toBe(false);
      await expect(hasCurrentKeyModelAuthorization(authorizationDb({
        key: {
          allowed_model_ids: ["model-1"],
          expires_at: new Date("2026-08-10T00:00:01Z"),
        },
      }), ...input)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有 attemptResult 时只允许无额度、无租约的零事实写入", async () => {
    const ledger = ledgerMock();
    const base = {
      ledgerRepo: ledger as unknown as GatewayLedgerRepository,
      requestId: "request-1",
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      attemptId: "attempt-1",
      attemptNo: 1,
      resourceId: "resource-1",
      resourceMode: "API" as const,
    };

    await expect(persistRejectedAttemptBeforeUpstreamEvidence({
      ...base,
      quotaSettlements: [{ grant_id: "grant-1", reserved_estimate: 10n, actual_deducted: 0n }],
    })).rejects.toThrow("nonterminal_attempt_result_required");
    await expect(persistRejectedAttemptBeforeUpstreamEvidence({
      ...base,
      releaseLeaseIds: ["lease-1"],
    })).rejects.toThrow("nonterminal_attempt_result_required");

    await persistRejectedAttemptBeforeUpstreamEvidence(base);
    expect(ledger.persistAttemptUsageAccountingIfAbsent).not.toHaveBeenCalled();
    expect(ledger.createUsageAndLedgerLineIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      ledger_line: expect.objectContaining({ api_cost: "0.00000000", usage_quality: "UNKNOWN" }),
    }));
  });

  it("有 attemptResult 时把 Attempt、额度退回和租约释放交给同一原子入口", async () => {
    const ledger = ledgerMock();
    const attemptResult = {
      http_status: 503,
      response_committed: false,
      finished_at: new Date("2026-08-10T01:00:00Z"),
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "candidate_admission_revoked",
      switch_reason: null,
    };
    await persistRejectedAttemptBeforeUpstreamEvidence({
      ledgerRepo: ledger as unknown as GatewayLedgerRepository,
      requestId: "request-1",
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      attemptId: "attempt-1",
      attemptNo: 1,
      resourceId: "resource-1",
      resourceMode: "CODING_PLAN",
      attemptResult,
      quotaSettlements: [{ grant_id: "grant-1", reserved_estimate: 10n, actual_deducted: 0n }],
      releaseLeaseIds: ["lease-1"],
    });

    expect(ledger.createUsageAndLedgerLineIfAbsent).not.toHaveBeenCalled();
    expect(ledger.persistAttemptUsageAccountingIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      attempt_result: attemptResult,
      quota_settlements: [{ grant_id: "grant-1", reserved_estimate: 10n, actual_deducted: 0n }],
      release_lease_ids: ["lease-1"],
    }));
  });

  it("候选撤权且仍有重试预算时原子清算当前 Attempt 后按 route 切换", async () => {
    const fixture = revokedInput();
    const result = await settleRevokedAttempt(fixture.input);

    expect(result).toEqual({ kind: "FAILOVER", remainingCandidates: [fixture.backup] });
    expect(fixture.ledger.updateAttemptResult).not.toHaveBeenCalled();
    expect(fixture.ledger.persistAttemptUsageAccountingIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      attempt_result: expect.objectContaining({
        http_status: 503,
        response_committed: false,
        error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
        error_code: "candidate_admission_revoked",
      }),
      quota_settlements: [{ grant_id: "grant-1", reserved_estimate: 321n, actual_deducted: 0n }],
      release_lease_ids: ["lease-1"],
    }));
    expect(fixture.pool.releaseHalfOpenProbe).toHaveBeenCalledWith(
      "resource-1",
      fixture.input.probeLease?.acquiredAt,
    );
    expect(fixture.quota.hasActiveGrant).toHaveBeenCalledWith({
      enterpriseId: "enterprise-1",
      principalId: "principal-1",
      provider: "kimi",
      modelAlias: "qianliu-kimi-k3",
    });
  });

  it("旧候选没有 routeId 时按 resource fallback 标记已尝试资源", async () => {
    const triedResourceIds = new Set<string>();
    const fixture = revokedInput({ triedResourceIds });
    delete fixture.input.candidate.routeId;
    const result = await settleRevokedAttempt(fixture.input);

    expect(result).toEqual({ kind: "FAILOVER", remainingCandidates: fixture.input.candidates });
    expect(triedResourceIds).toContain(fixture.selected.resourceId);
  });

  it("非探针候选撤权时不调用半开探针释放", async () => {
    const fixture = revokedInput({ probeLease: false });
    const result = await settleRevokedAttempt(fixture.input);

    expect(result.kind).toBe("FAILOVER");
    expect(fixture.pool.releaseHalfOpenProbe).not.toHaveBeenCalled();
    expect(fixture.log.error).not.toHaveBeenCalled();
  });

  it("仍有预算但没有可用候选时必须发布终态，不能空 failover", async () => {
    const fixture = revokedInput();
    fixture.input.candidates = [fixture.selected];
    const result = await settleRevokedAttempt(fixture.input);

    expect(result).toMatchObject({
      kind: "REJECT",
      errorCode: "candidate_admission_revoked",
      statusCode: 503,
    });
    expect(fixture.ledger.finalizeRejectedAttemptSettlementIfAbsent).toHaveBeenCalledOnce();
  });

  it("当前 Attempt 没有额度预留和租约时终态只清算历史待处理项", async () => {
    const fixture = revokedInput({ maxAttempts: 1, hasCurrentReservation: false });
    const result = await settleRevokedAttempt(fixture.input);

    expect(result.kind).toBe("REJECT");
    expect(fixture.ledger.finalizeRejectedAttemptSettlementIfAbsent)
      .toHaveBeenCalledWith(expect.objectContaining({
        quota_settlements: [{
          grant_id: "old-grant", reserved_estimate: 10n, actual_deducted: 5n,
        }],
        release_lease_ids: ["old-lease"],
      }));
  });

  it("attemptNo 达到 maxAttempts 时不得继续 failover，并发布 503 终态", async () => {
    const fixture = revokedInput({ attemptNo: 2, maxAttempts: 2 });
    const result = await settleRevokedAttempt(fixture.input);

    expect(result).toEqual({
      kind: "REJECT",
      errorCode: "candidate_admission_revoked",
      statusCode: 503,
      message: "已选路由、厂商资源、厂商或计费规则在访问上游前已失效",
      type: "server_error",
      retryable: true,
    });
    expect(fixture.ledger.updateAttemptResult).not.toHaveBeenCalled();
    expect(fixture.ledger.finalizeRejectedAttemptSettlementIfAbsent)
      .toHaveBeenCalledWith(expect.objectContaining({
      attempt_result: expect.objectContaining({
        http_status: 503,
        error_code: "candidate_admission_revoked",
      }),
      error_code: "candidate_admission_revoked",
      quota_settlements: [
        { grant_id: "old-grant", reserved_estimate: 10n, actual_deducted: 5n },
        { grant_id: "grant-1", reserved_estimate: 321n, actual_deducted: 0n },
      ],
      release_lease_ids: ["old-lease", "lease-1"],
      overage: true,
    }));
  });

  it("Key 撤权时不再查询 Grant，按 403 不可重试合同发布终态", async () => {
    const fixture = revokedInput({
      db: authorizationDb({ key: { allowed_model_ids: [], expires_at: null } }),
    });
    const result = await settleRevokedAttempt(fixture.input);

    expect(fixture.quota.hasActiveGrant).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "REJECT",
      errorCode: "key_or_model_authorization_revoked",
      statusCode: 403,
      message: "Key 或模型授权在访问上游前已失效",
      type: "authentication_error",
      retryable: false,
    });
    expect(fixture.ledger.updateAttemptResult).not.toHaveBeenCalled();
    expect(fixture.ledger.finalizeRejectedAttemptSettlementIfAbsent)
      .toHaveBeenCalledWith(expect.objectContaining({
      attempt_result: expect.objectContaining({
        http_status: 403,
        error_code: "key_or_model_authorization_revoked",
      }),
      error_code: "key_or_model_authorization_revoked",
    }));
  });

  it("Grant 撤权返回主体授权错误；probe 即时释放失败被记录且不覆盖结算结果", async () => {
    const fixture = revokedInput({ grantCurrent: false, probeReleaseRejects: true });
    const result = await settleRevokedAttempt(fixture.input);

    expect(result).toEqual({
      kind: "REJECT",
      errorCode: "principal_grant_required",
      statusCode: 403,
      message: "主体授权在访问上游前已失效",
      type: "authentication_error",
      retryable: false,
    });
    expect(fixture.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        action: "release revoked half-open probe",
      }),
      "post-settlement side effect failed",
    );
  });
});
