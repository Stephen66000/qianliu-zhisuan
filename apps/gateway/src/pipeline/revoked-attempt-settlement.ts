import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type {
  Database,
  GatewayLedgerRepository,
  HalfOpenProbeLease,
  QuotaGateRepository,
  ResourcePoolRepository,
} from "@qianliu/database";
import {
  pickWinner,
  scoreAndSelect,
  type RoutingCandidateInput,
} from "@qianliu/domain";

import {
  finalizeRejectedAttemptBeforeUpstream,
  persistRejectedAttemptBeforeUpstreamEvidence,
} from "./attempt-usage-settlement.js";

interface QuotaSettlement {
  grant_id: string;
  reserved_estimate: bigint;
  actual_deducted: bigint;
}

export type RevokedAttemptSettlementResult =
  | { kind: "FAILOVER"; remainingCandidates: RoutingCandidateInput[] }
  | {
      kind: "REJECT";
      errorCode: string;
      statusCode: 403 | 503;
      message: string;
      type: "authentication_error" | "server_error";
      retryable: boolean;
    };

export interface SettleRevokedAttemptInput {
  db: Kysely<Database>;
  ledgerRepo: GatewayLedgerRepository;
  quotaRepo: QuotaGateRepository;
  poolRepo: ResourcePoolRepository;
  log: FastifyBaseLogger;
  enterpriseId: string;
  principalId: string;
  keyId: string;
  modelAlias: string;
  requestId: string;
  attemptId: string;
  attemptNo: number;
  candidate: RoutingCandidateInput;
  candidates: RoutingCandidateInput[];
  triedResourceIds: Set<string>;
  affinityResourceId: string | null;
  maxAttempts: number;
  grantId: string | null;
  reservedEstimate: bigint;
  leaseId: string | null;
  pendingQuotaSettlements: QuotaSettlement[];
  pendingLeaseIds: string[];
  requestOverage: boolean;
  probeLease: HalfOpenProbeLease | null;
}

/**
 * 最终授权栅栏拒绝后的唯一清算入口。
 *
 * 可切换时，零消费事实、当前 Attempt 的额度退回和租约释放由数据库仓储同事务
 * 提交，request 保持 IN_PROGRESS；不可切换时沿 POOL-043 terminal finalize 发布终态。
 */
export async function settleRevokedAttempt(
  input: SettleRevokedAttemptInput,
): Promise<RevokedAttemptSettlementResult> {
  const keyIsCurrent = await hasCurrentKeyModelAuthorization(
    input.db,
    input.enterpriseId,
    input.principalId,
    input.keyId,
    input.modelAlias,
  );
  const grantIsCurrent = keyIsCurrent && await input.quotaRepo.hasActiveGrant({
    enterpriseId: input.enterpriseId,
    principalId: input.principalId,
    provider: input.candidate.providerCode,
    modelAlias: input.modelAlias,
  });
  const errorCode = !keyIsCurrent
    ? "key_or_model_authorization_revoked"
    : !grantIsCurrent
      ? "principal_grant_required"
      : "candidate_admission_revoked";
  const attemptResult = {
    http_status: errorCode === "candidate_admission_revoked" ? 503 : 403,
    response_committed: false,
    finished_at: new Date(),
    error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
    error_code: errorCode,
    switch_reason: null,
  };

  const currentQuotaSettlement = input.grantId
    ? [{
        grant_id: input.grantId,
        reserved_estimate: input.reservedEstimate,
        actual_deducted: 0n,
      }]
    : [];
  const currentLeaseIds = input.leaseId ? [input.leaseId] : [];
  if (errorCode === "candidate_admission_revoked") {
    const remainingCandidates = excludeRevokedCandidateRoute(
      input.candidates,
      input.candidate,
      input.triedResourceIds,
    );
    const canFailOver = input.attemptNo < input.maxAttempts
      && pickWinner(scoreAndSelect(
        remainingCandidates,
        input.affinityResourceId,
        input.triedResourceIds,
      )) !== undefined;
    if (canFailOver) {
      await persistRejectedAttemptBeforeUpstreamEvidence({
        ledgerRepo: input.ledgerRepo,
        requestId: input.requestId,
        enterpriseId: input.enterpriseId,
        principalId: input.principalId,
        attemptId: input.attemptId,
        attemptNo: input.attemptNo,
        resourceId: input.candidate.resourceId,
        resourceMode: input.candidate.mode,
        attemptResult,
        quotaSettlements: currentQuotaSettlement,
        releaseLeaseIds: currentLeaseIds,
      });
      await releaseProbeBestEffort(input);
      return { kind: "FAILOVER", remainingCandidates };
    }
  }

  // terminal 路径把 Attempt、零事实、FAILED、额度和租约交给数据库一次提交。
  await finalizeRejectedAttemptBeforeUpstream({
    ledgerRepo: input.ledgerRepo,
    requestId: input.requestId,
    enterpriseId: input.enterpriseId,
    principalId: input.principalId,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    resourceId: input.candidate.resourceId,
    resourceMode: input.candidate.mode,
    errorCode,
    attemptResult,
    quotaSettlements: [...input.pendingQuotaSettlements, ...currentQuotaSettlement],
    releaseLeaseIds: [...input.pendingLeaseIds, ...currentLeaseIds],
    overage: input.requestOverage,
  });
  await releaseProbeBestEffort(input);
  return { kind: "REJECT", errorCode, ...currentAuthorizationRejection(errorCode) };
}

export async function hasCurrentKeyModelAuthorization(
  db: Kysely<Database>,
  enterpriseId: string,
  principalId: string,
  keyId: string,
  modelAlias: string,
): Promise<boolean> {
  const key = await db
    .selectFrom("principal_key")
    .innerJoin("principal", "principal.id", "principal_key.principal_id")
    .select([
      "principal_key.allowed_model_ids as allowed_model_ids",
      "principal_key.expires_at as expires_at",
    ])
    .where("principal_key.id", "=", keyId)
    .where("principal_key.enterprise_id", "=", enterpriseId)
    .where("principal_key.principal_id", "=", principalId)
    .where("principal_key.status", "=", "ACTIVE")
    .where("principal.status", "=", "ACTIVE")
    .executeTakeFirst();
  if (!key || (key.expires_at !== null && key.expires_at.getTime() <= Date.now())) return false;
  const allowedModelIds = key.allowed_model_ids ?? [];
  if (allowedModelIds.length === 0) return false;
  return (await db.selectFrom("unified_model").select("id")
    .where("enterprise_id", "=", enterpriseId)
    .where("alias", "=", modelAlias)
    .where("status", "=", "ACTIVE")
    .where("id", "in", allowedModelIds)
    .executeTakeFirst()) !== undefined;
}

function excludeRevokedCandidateRoute(
  candidates: RoutingCandidateInput[],
  candidate: RoutingCandidateInput,
  triedResourceIds: Set<string>,
): RoutingCandidateInput[] {
  if (candidate.routeId === undefined) {
    triedResourceIds.add(candidate.resourceId);
    return candidates;
  }
  return candidates.filter((item) => item.routeId !== candidate.routeId);
}

function currentAuthorizationRejection(errorCode: string): Omit<
  Extract<RevokedAttemptSettlementResult, { kind: "REJECT" }>,
  "kind" | "errorCode"
> {
  if (errorCode === "candidate_admission_revoked") {
    return {
      statusCode: 503,
      message: "已选路由、厂商资源、厂商或计费规则在访问上游前已失效",
      type: "server_error",
      retryable: true,
    };
  }
  return {
    statusCode: 403,
    message: errorCode === "key_or_model_authorization_revoked"
      ? "Key 或模型授权在访问上游前已失效"
      : "主体授权在访问上游前已失效",
    type: "authentication_error",
    retryable: false,
  };
}

async function releaseProbeBestEffort(input: SettleRevokedAttemptInput): Promise<void> {
  if (!input.probeLease) return;
  try {
    await input.poolRepo.releaseHalfOpenProbe(
      input.probeLease.resourceId,
      input.probeLease.acquiredAt,
    );
  } catch (error) {
    // 即时释放失败不会永久卡死：last_probe_at 的 11 分钟 TTL 允许新请求接管，
    // fencing token 同时阻止本请求迟到释放已被接管的新租约。
    input.log.error({ err: error, action: "release revoked half-open probe" },
      "post-settlement side effect failed");
  }
}
