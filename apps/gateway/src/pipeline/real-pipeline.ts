/**
 * real pipeline —— 端到端代表链（W08 DeepSeek；W09 多厂商；W12 多候选评分 + 提交前切换）。
 *
 * 把 Adapter（按 providerCode 从注册表解析）+ 路由评分（W12）+ GatewayLedgerRepository 串起来，
 * 完成 TRD §8 行 496-516 的请求流程与 §9 行 568-583 的选路规则：
 *   创建请求意图 → 硬过滤（W11 listServableResources）→ 多因子评分（W12）→
 *   Attempt（失败且 committed=false → 排除已试资源重评，committed=true 绝不切换）→
 *   usage → ledger_line → ledger_transaction。
 *
 * W12 变更：
 *   - deps.findResource（单资源）→ deps.listCandidates（多候选 + priority/weight/providerCode/mode）；
 *   - 每次 Attempt 冻结 route_candidate（score_factors/total_score/reason_code/策略版本，WT-18 可解释）；
 *   - Affinity：deps.resolveAffinity 返回会话最近成功资源（WT-13，仅作评分因子，不绕过硬约束）；
 *   - 失败驱动 W11 状态机（ResourcePoolRepository.recordFailure/recordSuccess）。
 *
 * 真实 HTTP 调用在 DEP-PROVIDER-CREDENTIALS 解锁后把 caller 替换为真实实现。
 */
import type { Kysely } from "kysely";
import type { FastifyReply } from "fastify";
import type { Outcome } from "@qianliu/contracts";
import type {
  ClaimRequestResult,
  Database,
  GatewayLedgerRepository,
  ResourcePoolRepository,
  DispatchPolicyRepository,
  QuotaGateRepository,
  RuntimeAssuranceRepository,
  AvailabilityEvent,
  SignalResult,
} from "@qianliu/database";
import { SecretValue, type UpstreamCaller } from "@qianliu/provider-adapters";
import {
  scoreAndSelect,
  pickWinner,
  ROUTING_POLICY,
  decideDispatch,
  QUOTA_DECISION,
  availabilitySignalSummary,
  identifyClient,
  type DispatchInput,
  type DispatchPolicy,
  type ErrorClassification,
  type RoutingCandidateInput,
  type ScoredCandidate,
} from "@qianliu/domain";
import type { PipelineHandler } from "../routes/chat.js";
import { resolveAdapter } from "./adapter-registry.js";
import { buildResponsesResponse, writeResponsesSse } from "../routes/responses-protocol.js";
import {
  createChatStreamWriter,
  type GatewayStreamWriter,
} from "../routes/chat-protocol.js";
import { createMessagesStreamWriter } from "../routes/messages-protocol.js";
import { fingerprintRequest } from "./request-idempotency.js";
import {
  calculateDispatchSaving,
  computeBilling,
  dispatchCounterfactualEvidence,
  dispatchSavingFields,
  summarizePricingEvidence,
  type BillingOutcome,
} from "./billing.js";
import { shouldAttemptUpstreamFailover } from "../upstream-failover-policy.js";

/** 路由候选（listCandidates 返回；硬过滤 + model_route 配置）。 */
export interface RouteCandidateRow {
  resourceId: string;
  providerCode: string;
  upstreamModel: string;
  priority: number;
  weight: number;
  mode: "API" | "CODING_PLAN";
  status: string;
  probe: boolean;
  principalId: string;
  providerId?: string;
  unifiedModelId?: string;
  /** 仅驻留于 Gateway 内存；生产由资源密文解密，测试可省略。 */
  secret?: SecretValue;
  concurrencyLimit?: number;
}

export interface RealPipelineDeps {
  db: Kysely<Database>;
  ledgerRepo: GatewayLedgerRepository;
  /** 上游调用器（StubUpstream / 真实 fetch）。按 providerCode 解析对应 Adapter。 */
  caller: UpstreamCaller;
  /** W11 资源池仓储（状态机驱动 + 硬过滤）。 */
  poolRepo: ResourcePoolRepository;
  /** RA-W04：规则、事件与 Outbox；测试未注入时保持旧链兼容。 */
  runtimeAssuranceRepo?: RuntimeAssuranceRepository;
  runtimeAssuranceMode?: "OFF" | "OBSERVE" | "ENFORCE";
  runtimeAssuranceWecomNotify?: boolean;
  /** W16 经营调度策略仓储（查已发布策略 + 落决策）。可选；未提供则跳过 dispatch。 */
  dispatchRepo?: DispatchPolicyRepository;
  /**
   * W14 额度门禁仓储（预占/结算/并发租约）。必填——M4 DoD 核心验收。
   * 在步骤 3b 前 reserve + acquireLease，Attempt 后 settle/release；
   * deducted_quota 通过 settleQuota 回写 quota_counter（多退少补）。
   */
  quotaRepo: QuotaGateRepository;
  /**
   * W12 多候选查找：enterprise + alias → model_route 启用的全部候选
   * （与 W11 listServableResources 硬过滤取交集后评分）。
   */
  listCandidates: (enterpriseId: string, unifiedModel: string) => Promise<RouteCandidateRow[]>;
  /**
   * WT-13 Affinity：返回该会话最近成功的 resourceId（无则 null）。
   * 仅作评分因子，不绕过凭证/能力/额度/熔断硬约束（TRD §9 行 577）。
   */
  resolveAffinity?: (principalId: string, unifiedModel: string) => Promise<string | null>;
  /**
   * W16 经营调度输入解析：按 winner 资源查额度比例/耗尽风险/价格倍率（供 decideDispatch 纯函数判定）。
   * 可选；未提供则用默认值（无风险、无倍率），dispatch 仍执行但多数策略不命中。
   */
  resolveDispatchInput?: (
    enterpriseId: string,
    principalId: string,
    unifiedModel: string,
    winnerResourceId: string,
    winnerMode: "API" | "CODING_PLAN",
    now: number,
  ) => Promise<{
    priceMultiplier: string;
    remainingQuotaRatio: number | null;
    forecastExhaustRisk: boolean;
  }>;
  /** 请求时钟（测试与回放注入）；同一请求内只读取一次，避免跨边界漂移。 */
  now?: () => number;
  /** 最大 Attempt 数（提交前切换上限；默认 2，有界故障切换）。 */
  maxAttempts?: number;
  /** 本地/跨实例并发槽位满时的最长等待；默认 2 秒，超时返回明确 429。 */
  capacityWaitMs?: number;
  /** 并发槽位轮询间隔；仅供测试缩短，生产默认 25ms。 */
  capacityPollMs?: number;
}

export function createRealPipeline(deps: RealPipelineDeps): PipelineHandler {
  const maxAttempts = deps.maxAttempts ?? 2;
  const capacityWaitMs = deps.capacityWaitMs ?? 2_000;
  const capacityPollMs = deps.capacityPollMs ?? 25;
  return async ({ request, reply, body, capability }) => {
    const requestId = request.aiRequestId;
    const traceId = request.requestId;
    const principal = request.principal!;
    const downstreamAbort = new AbortController();
    request.raw.once("aborted", () => downstreamAbort.abort());
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) downstreamAbort.abort();
    });
    const requestStartedAt = deps.now?.() ?? Date.now();
    const created = Math.floor(requestStartedAt / 1000);
    const requestFingerprint = request.idempotencyKey
      ? fingerprintRequest(capability, body)
      : null;
    const client = identifyClient({
      headers: request.headers,
      protocol: capability,
      url: request.url,
    });

    // 1. 原子认领请求意图。x-request-id 仅追踪；只有显式 Idempotency-Key 才去重。
    const claim = await deps.ledgerRepo.claimRequest({
      id: requestId,
      enterprise_id: principal.enterpriseId,
      principal_id: principal.principalId,
      principal_key_id: principal.keyId,
      idempotency_key: request.idempotencyKey,
      client_request_id: traceId,
      request_fingerprint: requestFingerprint,
      protocol: capability,
      unified_model: body.model,
      stream: body.stream ?? false,
      client_id: client.rawClientId,
      agent_family: client.family,
      agent_version: client.version,
      agent_identity_source: client.source,
      agent_identity_confidence: client.confidence,
      client_identity_rule_version: client.ruleVersion,
    });
    if (claim.kind !== "CREATED") {
      return sendIdempotencyReplay(reply, traceId, claim);
    }
    reply.header("x-request-id", traceId);
    reply.header("x-ai-request-id", requestId);
    // Responses 当前是 Chat Completions 转换子集，仍保持缓冲式；
    // Chat / Messages 由真实上游 chunk 回调驱动北向 SSE。
    const streamWriter: GatewayStreamWriter | null = body.stream && capability === "chat"
      ? createChatStreamWriter(reply, { requestId, traceId, createdAt: created, model: body.model })
      : body.stream && capability === "messages"
        ? createMessagesStreamWriter(reply, { requestId, traceId, model: body.model })
        : null;

    // 2. 硬过滤（W11）：可服务资源 ∩ model_route 启用候选
    const allCandidates = await deps.listCandidates(principal.enterpriseId, body.model);
    if (allCandidates.length === 0) {
      await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "MODEL_NOT_FOUND", "model_not_configured");
      return reply.code(404).send({
        error: { message: "模型未配置", type: "invalid_request_error", code: "model_not_configured", param: "model", retryable: false, request_id: requestId },
      });
    }
    const grantChecks = await Promise.all(
      allCandidates.map(async (candidate) => ({
        candidate,
        authorized: await deps.quotaRepo.hasActiveGrant({
          enterpriseId: principal.enterpriseId,
          principalId: principal.principalId,
          provider: candidate.providerCode,
          modelAlias: body.model,
        }),
      })),
    );
    const grantAuthorizedCandidates = grantChecks
      .filter((result) => result.authorized)
      .map((result) => result.candidate);
    if (grantAuthorizedCandidates.length === 0) {
      await deps.ledgerRepo.updateRequestStatus(
        requestId,
        "FAILED",
        "DOWNSTREAM_AUTH_OR_QUOTA",
        "principal_grant_required",
      );
      return reply.code(403).header("x-request-id", traceId).send({
        error: {
          message: "主体未获该模型的有效资源授权",
          type: "authentication_error",
          code: "principal_grant_required",
          param: "model",
          retryable: false,
          request_id: requestId,
        },
      });
    }

    const servableById = new Map(
      (await deps.poolRepo.listServableResources(principal.enterpriseId)).map((s) => [s.id, s]),
    );
    const candidateByResourceId = new Map(
      grantAuthorizedCandidates.map((candidate) => [candidate.resourceId, candidate]),
    );
    let blockingEvent: AvailabilityEvent | null = null;
    const runtimeAllowedCandidates: RouteCandidateRow[] = [];
    for (const candidate of grantAuthorizedCandidates) {
      if (deps.runtimeAssuranceRepo && deps.runtimeAssuranceMode === "ENFORCE") {
        const open = await deps.runtimeAssuranceRepo.findOpenBlock(candidate.resourceId, candidate.upstreamModel);
        if (open) {
          blockingEvent ??= open;
          continue;
        }
        if (candidate.providerId) {
          const schedule = await deps.runtimeAssuranceRepo.evaluateSchedule({
            now: new Date(requestStartedAt), providerId: candidate.providerId,
            providerResourceId: candidate.resourceId, unifiedModelId: candidate.unifiedModelId ?? null,
            upstreamModel: candidate.upstreamModel,
          });
          if (schedule?.action === "BLOCK") {
            blockingEvent = await deps.runtimeAssuranceRepo.createScheduleEvent({
              rule: schedule, enterpriseId: principal.enterpriseId,
              providerId: candidate.providerId, providerResourceId: candidate.resourceId,
              unifiedModelId: candidate.unifiedModelId ?? null, upstreamModel: candidate.upstreamModel,
              aiRequestId: requestId, principalId: principal.principalId,
              now: new Date(requestStartedAt), wecomNotify: deps.runtimeAssuranceWecomNotify ?? false,
            });
            continue;
          }
        }
      }
      if (!servableById.has(candidate.resourceId)) continue;
      runtimeAllowedCandidates.push(candidate);
    }
    const eligible: RoutingCandidateInput[] = runtimeAllowedCandidates
      .map((c) => {
        const admission = servableById.get(c.resourceId)!;
        return ({
          resourceId: c.resourceId,
          upstreamModel: c.upstreamModel,
          priority: c.priority,
          weight: c.weight,
          status: admission.status as RoutingCandidateInput["status"],
          probe: admission.probe,
          mode: c.mode,
          providerCode: c.providerCode,
        });
      });

    if (eligible.length === 0) {
      if (blockingEvent) {
        await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "RUNTIME_ASSURANCE_BLOCKED", blockingEvent.event_number);
        return sendRuntimeBlock(reply, capability, traceId, requestId, blockingEvent);
      }
      const coolingResources = await Promise.all(
        grantAuthorizedCandidates.map((candidate) => deps.poolRepo.getResource(candidate.resourceId)),
      );
      const resource = coolingResources.find((candidate) => candidate?.status === "RATE_LIMITED");
      if (resource) {
        const retryAfterMs = Math.max(
          1_000,
          (resource.cooldown_until?.getTime() ?? Date.now() + 1_000) - Date.now(),
        );
        await deps.ledgerRepo.updateRequestStatus(
          requestId,
          "FAILED",
          "UPSTREAM_RATE_LIMITED",
          "resource_rate_limited",
        );
        return reply.code(429)
          .header("retry-after", Math.max(1, Math.ceil(retryAfterMs / 1_000)))
          .send({
            error: {
              message: "上游资源正在限流冷却，请稍后重试",
              type: "rate_limit_error",
              code: "resource_rate_limited",
              param: null,
              retryable: true,
              retry_after_ms: retryAfterMs,
              request_id: requestId,
            },
          });
      }
      // 无健康候选：停止对应模型调用，不无账放行（TRD §14 行 854）
      await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "NO_HEALTHY_CANDIDATE", "no_healthy_candidate");
      return reply.code(503).send({
        error: { message: "无可用上游资源", type: "server_error", code: "no_healthy_candidate", param: null, retryable: true, request_id: requestId },
      });
    }

    // WT-13 Affinity：会话最近成功资源（仅评分因子）
    const affinityResourceId = deps.resolveAffinity
      ? await deps.resolveAffinity(principal.principalId, body.model)
      : null;

    // 3. 多 Attempt：评分 → Attempt → 失败且 committed=false 重评（提交前切换）
    const triedResourceIds = new Set<string>();
    let lastScored: ScoredCandidate[] = [];
    let winner: ScoredCandidate | undefined;
    let finalOutcome: Outcome | null = null;
    let finalSignalResult: SignalResult | null = null;
    let attemptNo = 0;
    // R2-N1 修复：额度/账本归因用已认证的调用者主体（principal.principalId），
    // 不是候选行的 principalId。生产 listCandidates 不知道调用者会填空串，
    // 导致 CODING_PLAN 的 reserveQuota 查不到授权误拒（503）。
    // 额度本就归调用者，不归路由候选。
    const principalId = principal.principalId;
    // W16 经营调度：首次 Attempt 决策（冻结 dispatch_decision，failover 重评不重复判定）
    let dispatchFinalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE" | null = null;
    let dispatchReasonCode = "";
    let dispatchMatchedPolicy: DispatchPolicy | null = null;
    let dispatchSwitchTargetId: string | null = null;
    let dispatchDispatchInput: DispatchInput | null = null;
    let dispatchBaselineCandidate: RoutingCandidateInput | null = null;
    const invokedResourceIds = new Set<string>();
    let dispatchTerminated = false;
    let grantRevokedDuringDispatch = false;
    let keyAuthorizationRevokedDuringDispatch = false;
    let capacityWaitTimedOut = false;
    let capacityRetryAfterMs = capacityPollMs;
    let halfOpenProbeBusy = false;
    // 请求级超额事实随结算冻结；后续 Grant/Counter 变化不得重算历史。
    let requestOverage = false;

    while (attemptNo < maxAttempts) {
      attemptNo += 1;
      lastScored = scoreAndSelect(eligible, affinityResourceId, triedResourceIds);
      winner = pickWinner(lastScored);
      if (!winner) break; // 无剩余候选

      // W16：首次 Attempt 做经营调度判定（TRD §9.1 行 611-618）
      if (attemptNo === 1 && deps.dispatchRepo) {
        const availableIds = new Set(eligible.map((e) => e.resourceId));
        const now = requestStartedAt;
        const resolved = deps.resolveDispatchInput
          ? await deps.resolveDispatchInput(
              principal.enterpriseId,
              principal.principalId,
              body.model,
              winner.input.resourceId,
              winner.input.mode,
              now,
            )
          : { priceMultiplier: "1", remainingQuotaRatio: null, forecastExhaustRisk: false };
        const dispatchInput: DispatchInput = {
          now,
          unifiedModel: body.model,
          selectedResourceId: winner.input.resourceId,
          resourceMode: winner.input.mode,
          priceMultiplier: resolved.priceMultiplier,
          remainingQuotaRatio: resolved.remainingQuotaRatio,
          forecastExhaustRisk: resolved.forecastExhaustRisk,
          principalId: principal.principalId,
        };
        // 冻结经营动作发生前的评分 winner。SWITCH 后 winner 会被替换，不能再从
        // 最终 Attempt 反推反事实基线。
        dispatchBaselineCandidate = { ...winner.input };
        const policies = await deps.dispatchRepo.listPublishedPolicies(principal.enterpriseId);
        const decision = decideDispatch(policies, dispatchInput, availableIds);
        dispatchFinalAction = decision.finalAction;
        dispatchReasonCode = decision.reasonCode;
        dispatchMatchedPolicy = decision.matchedPolicy;
        dispatchSwitchTargetId = decision.switchTargetResourceId;
        dispatchDispatchInput = dispatchInput;

        // SWITCH：把 winner 替换为等价组内的目标候选（纯函数已校验 ∈ 等价组 ∩ 可用）
        if (decision.finalAction === "SWITCH" && decision.switchTargetResourceId) {
          const targetScored = lastScored.find((s) => s.input.resourceId === decision.switchTargetResourceId);
          if (targetScored) {
            targetScored.selected = true;
            winner.selected = false;
            winner.reasonCode = "DISPATCH_SWITCHED_AWAY";
            winner = targetScored;
          }
        }
        // REJECT / RATE_LIMIT：终止，不无账放行（落决策后由循环结束的 503/429 处理）
        if (decision.finalAction === "REJECT" || decision.finalAction === "RATE_LIMIT") {
          dispatchTerminated = true;
          break;
        }
      }

      const cand = winner.input;
      // grant 可能在候选评分后被管理员撤销；访问上游前再次直查，避免 TOCTOU 放行。
      const grantStillActive = await deps.quotaRepo.hasActiveGrant({
        enterpriseId: principal.enterpriseId,
        principalId,
        provider: cand.providerCode,
        modelAlias: body.model,
      });
      if (!grantStillActive) {
        grantRevokedDuringDispatch = true;
        triedResourceIds.add(cand.resourceId);
        continue;
      }
      const probeAcquired = cand.probe
        ? await deps.poolRepo.tryAcquireHalfOpenProbe(cand.resourceId)
        : false;
      if (cand.probe && !probeAcquired) {
        // 另一个进程/请求已在用真实业务流量探测，本请求不重复打上游。
        halfOpenProbeBusy = true;
        triedResourceIds.add(cand.resourceId);
        continue;
      }
      // 3a. 冻结本 Attempt 的候选快照（WT-18 可解释：因子/总分/reason/策略版本）
      for (const sc of lastScored) {
        if (triedResourceIds.has(sc.input.resourceId) && !sc.selected) continue; // 已试候选不重复冻结
        await deps.ledgerRepo.createRouteCandidate({
          ai_request_id: requestId,
          enterprise_id: principal.enterpriseId,
          provider_resource_id: sc.input.resourceId,
          upstream_model: sc.input.upstreamModel,
          priority: sc.input.priority,
          weight: sc.input.weight,
          selected: sc.selected,
          score_factors: {
            factors: sc.factors,
            policy_version: ROUTING_POLICY.version,
            affinity_resource_id: affinityResourceId,
          },
          total_score: sc.totalScore.toFixed(6),
          reason_code: sc.reasonCode,
        });
      }

      // 3a-bis. W14 额度门禁（步骤 3b 前；TRD §8 行 504 + §8.2 行 527-537）。
      // 仅 CODING_PLAN 模式：API 模式无 deducted_quota（monetary 计费），门禁跳过。
      // per-attempt reserve：grant 键为 (principal, provider, model_alias)，跨 provider
      // failover 命中不同 grant，故每个 attempt 针对其自身的 grant 预占/结算。
      // 并发租约 acquireLease 按 provider_resource_id 限流；耗尽 REJECT 不无账放行。
      let leaseId: string | null = null;
      let grantId: string | null = null;
      let reservedEstimate = 0n;
      let reservedProjectedRemaining = 0n;
      if (cand.mode === "CODING_PLAN") {
        const lease = await acquireConcurrencyLeaseWithWait({
          quotaRepo: deps.quotaRepo,
          enterpriseId: principal.enterpriseId,
          providerResourceId: cand.resourceId,
          aiRequestId: requestId,
          waitMs: capacityWaitMs,
          pollMs: capacityPollMs,
          cancelled: () => downstreamAbort.signal.aborted,
        });
        if (lease === null) {
          // 槽位暂满是容量状态，不是资源故障；先尝试其他候选，最终返回明确 429。
          capacityWaitTimedOut = true;
          capacityRetryAfterMs = capacityPollMs;
          triedResourceIds.add(cand.resourceId);
          if (probeAcquired) await deps.poolRepo.releaseHalfOpenProbe(cand.resourceId);
          continue;
        }
        leaseId = lease;
        const reserve = await deps.quotaRepo.reserveQuota({
          enterpriseId: principal.enterpriseId,
          principalId,
          provider: cand.providerCode,
          modelAlias: body.model,
          estimatedCost: estimateRawTokens(body),
        });
        if (reserve.decision !== QUOTA_DECISION.ALLOW && reserve.decision !== QUOTA_DECISION.ALLOW_OVERAGE) {
          // REJECT_EXHAUSTED / REJECT_NO_GRANT / REJECT_GRANT_EXPIRED：释放租约，排除资源重评
          await deps.quotaRepo.releaseLease(leaseId);
          if (probeAcquired) await deps.poolRepo.releaseHalfOpenProbe(cand.resourceId);
          triedResourceIds.add(cand.resourceId);
          continue;
        }
        grantId = reserve.grantId;
        reservedEstimate = reserve.reservedEstimate;
        reservedProjectedRemaining = reserve.gate.projectedRemaining;
      }

      // 3b. Attempt
      const attempt = await deps.ledgerRepo.createAttempt({
        ai_request_id: requestId,
        enterprise_id: principal.enterpriseId,
        attempt_no: attemptNo,
        provider_resource_id: cand.resourceId,
        upstream_model: cand.upstreamModel,
      });

      // preHandler 到实际访问上游之间可能发生 Key 重置、主体停用、模型撤权/停用。
      // Adapter 前直接查库复核，避免旧请求上下文穿透即时撤权。
      const keyStillAuthorized = await hasCurrentKeyModelAuthorization(
        deps.db,
        principal.enterpriseId,
        principalId,
        principal.keyId,
        body.model,
      );
      if (!keyStillAuthorized) {
        await deps.ledgerRepo.updateAttemptResult(attempt.id, {
          http_status: 403,
          response_committed: false,
          finished_at: new Date(),
          error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
          error_code: "key_or_model_authorization_revoked",
          switch_reason: null,
        });
        if (grantId) await deps.quotaRepo.releaseQuota(grantId, reservedEstimate);
        if (leaseId) await deps.quotaRepo.releaseLease(leaseId);
        if (probeAcquired) await deps.poolRepo.releaseHalfOpenProbe(cand.resourceId);
        keyAuthorizationRevokedDuringDispatch = true;
        break;
      }

      // 最终提交栅栏用一条 SQL 同时复核 Key、主体、模型和 grant，避免把两次独立
      // 查询之间的 await 变成另一条 TOCTOU 缝隙。此查询与 adapter.invoke 之间
      // 不得再增加 await。
      const invocationStillAuthorized = await hasCurrentInvocationAuthorization(
        deps.db,
        principal.enterpriseId,
        principalId,
        principal.keyId,
        body.model,
        cand.providerCode,
      );
      if (!invocationStillAuthorized) {
        // 已决定不访问上游后才做原因细分；这里的额外查询不再构成放行竞态。
        const grantIsCurrent = await deps.quotaRepo.hasActiveGrant({
          enterpriseId: principal.enterpriseId,
          principalId,
          provider: cand.providerCode,
          modelAlias: body.model,
        });
        const errorCode = grantIsCurrent
          ? "key_or_model_authorization_revoked"
          : "principal_grant_required";
        await deps.ledgerRepo.updateAttemptResult(attempt.id, {
          http_status: 403,
          response_committed: false,
          finished_at: new Date(),
          error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
          error_code: errorCode,
          switch_reason: null,
        });
        if (grantId) await deps.quotaRepo.releaseQuota(grantId, reservedEstimate);
        if (leaseId) await deps.quotaRepo.releaseLease(leaseId);
        if (probeAcquired) await deps.poolRepo.releaseHalfOpenProbe(cand.resourceId);
        if (grantIsCurrent) {
          keyAuthorizationRevokedDuringDispatch = true;
        } else {
          grantRevokedDuringDispatch = true;
        }
        break;
      }

      const adapter = resolveAdapter(cand.providerCode, deps.caller);
      const resourceConfig = candidateByResourceId.get(cand.resourceId);
      invokedResourceIds.add(cand.resourceId);
      const outcome = await adapter.invoke(
        {
          providerCode: cand.providerCode as "deepseek" | "zhipu" | "kimi",
          resourceId: cand.resourceId,
          mode: cand.mode,
          upstreamModel: cand.upstreamModel,
          concurrencyLimit: resourceConfig?.concurrencyLimit ?? 0,
          secret: resourceConfig?.secret ?? new SecretValue(""),
        },
        {
          requestId,
          unifiedModel: body.model,
          stream: body.stream ?? false,
          capability,
          // 保留完整北向请求，真实 caller 才能转换 tools/tool_choice/system；
          // 请求正文仅驻留内存，账本仍保持 METADATA_ONLY。
          body: capability === "responses" ? body.responsesRequest : body,
          abort: downstreamAbort.signal,
          ...(streamWriter
            ? { onStreamChunk: (payload: Record<string, unknown>) => streamWriter.writeChunk(payload) }
            : {}),
        },
        attemptNo,
      );

      const classification = (outcome.error ? mapToClassification(outcome) : null);
      await deps.ledgerRepo.updateAttemptResult(attempt.id, {
        http_status: outcome.status,
        response_committed: outcome.committed,
        first_byte_at: outcome.firstByteAt ? new Date(outcome.firstByteAt) : null,
        finished_at: new Date(),
        error_classification: classification,
        error_code: outcome.error ?? null,
        failure_layer: outcome.failureLayer ?? null,
        switch_reason: null,
      });

      // RA-W04：Adapter 规范化信号进入唯一规则/事件链；Gateway 事务只写事件和 Outbox。
      if (
        outcome.error && outcome.unifiedAvailabilitySignal && deps.runtimeAssuranceRepo &&
        resourceConfig?.providerId
      ) {
        finalSignalResult = await deps.runtimeAssuranceRepo.recordSignal({
          enterpriseId: principal.enterpriseId,
          providerId: resourceConfig.providerId,
          providerResourceId: cand.resourceId,
          unifiedModelId: resourceConfig.unifiedModelId ?? null,
          upstreamModel: cand.upstreamModel,
          signal: outcome.unifiedAvailabilitySignal,
          upstreamCode: outcome.upstreamCode ?? outcome.error,
          sanitizedSummary: availabilitySignalSummary(outcome.unifiedAvailabilitySignal),
          upstreamRecoverAt: outcome.recoverAt ? new Date(outcome.recoverAt) : null,
          aiRequestId: requestId,
          principalId,
          now: new Date(requestStartedAt),
          mode: deps.runtimeAssuranceMode ?? "OBSERVE",
          wecomNotify: deps.runtimeAssuranceWecomNotify ?? false,
        });
      }

      // 3c. 结果驱动健康状态机。技术失败只降级；硬阻断只由上面的事件派生。
      if (outcome.committed && !outcome.error) {
        await deps.poolRepo.recordSuccess(cand.resourceId);
      } else if (classification) {
        const transition = await deps.poolRepo.recordFailure(
          cand.resourceId,
          classification as ErrorClassification,
          new Date(),
          { retryAfterMs: outcome.retryAfterMs },
        );
        if (probeAcquired && !transition) {
          await deps.poolRepo.releaseHalfOpenProbe(cand.resourceId);
        }
      } else if (probeAcquired) {
        await deps.poolRepo.releaseHalfOpenProbe(cand.resourceId);
      }

      // 3d. usage + ledger（每次有可证明用量的 Attempt 独立明细；WT-11 双 Attempt 双明细）
      // 捕获本 attempt 的 billing（deducted_quota/api_cost）供额度结算使用。
      let attemptBilling: BillingOutcome | null = null;
      if (outcome.usage.input + outcome.usage.output > 0) {
        const usage = await deps.ledgerRepo.createUsageEventIfAbsent({
          ai_request_id: requestId,
          enterprise_id: principal.enterpriseId,
          upstream_attempt_id: attempt.id,
          provider_resource_id: cand.resourceId,
          input_tokens: BigInt(outcome.usage.input),
          output_tokens: BigInt(outcome.usage.output),
          cache_tokens: BigInt(outcome.usage.cache),
          reasoning_tokens: BigInt(outcome.usage.reasoning ?? 0),
          usage_quality: outcome.usage.quality,
          dedup_key: `${requestId}:attempt${attemptNo}`,
        });
        if (usage) {
          // W13：按 Attempt 开始时间 + 资源 + 模型匹配生效规则版本（历史不重算）
          const billing = await computeBilling(
            deps.ledgerRepo,
            principal.enterpriseId,
            cand.resourceId,
            cand.upstreamModel,
            cand.mode,
            attempt.started_at.getTime(),
            outcome.usage,
          );
          attemptBilling = billing;
          await deps.ledgerRepo.createLedgerLine({
            ai_request_id: requestId,
            enterprise_id: principal.enterpriseId,
            usage_event_id: usage.id,
            upstream_attempt_id: attempt.id,
            provider_resource_id: cand.resourceId,
            principal_id: principalId,
            resource_mode: cand.mode,
            raw_input_tokens: BigInt(outcome.usage.input),
            raw_output_tokens: BigInt(outcome.usage.output),
            raw_cache_tokens: BigInt(outcome.usage.cache),
            raw_reasoning_tokens: BigInt(outcome.usage.reasoning ?? 0),
            deducted_quota: billing.deductedQuota !== null ? BigInt(billing.deductedQuota) : null,
            api_cost: billing.apiCost,
            usage_quality: outcome.usage.quality,
            billing_rule_id: billing.ruleId,
            rule_version: billing.ruleVersion,
            multiplier: billing.multiplier,
            billing_rule_snapshot: billing.ruleSnapshot,
          });
        }
      }

      // 3d-bis. W14 额度结算（committed → settleQuota 按实际 deducted_quota 校正回写 quota_counter；
      // 失败/可切换 → releaseQuota 释放预占）。F-01 核心：deducted_quota 回写 quota_counter。
      if (cand.mode === "CODING_PLAN" && grantId) {
        if (outcome.committed && !outcome.error) {
          const actualDeducted = attemptBilling?.deductedQuota !== null && attemptBilling?.deductedQuota !== undefined
            ? BigInt(attemptBilling.deductedQuota)
            : 0n;
          const availableBeforeRequest =
            reservedEstimate + reservedProjectedRemaining > 0n
              ? reservedEstimate + reservedProjectedRemaining
              : 0n;
          requestOverage =
            requestOverage ||
            (actualDeducted > 0n && actualDeducted > availableBeforeRequest);
          await deps.quotaRepo.settleQuota(grantId, reservedEstimate, actualDeducted);
        } else {
          await deps.quotaRepo.releaseQuota(grantId, reservedEstimate);
        }
      }
      if (leaseId) await deps.quotaRepo.releaseLease(leaseId);
      leaseId = null;

      finalOutcome = outcome;

      // 3e. 切换判定：已提交、首字节超时或不可切换分类都停止重打。
      if (!shouldAttemptUpstreamFailover(
        outcome,
        classification as ErrorClassification | null,
      )) break;
      // 429 必须保留给客户端并进入资源冷却；唯一资源不在同一
      // 北向请求内立即重打，避免与 SDK 自动重试叠加放大限流。
      triedResourceIds.add(cand.resourceId);
      await deps.ledgerRepo.updateAttemptResult(attempt.id, { switch_reason: classification });
    }

    // 4. ledger_transaction（唯一汇总；多 Attempt 聚合 token + 费用）
    // F-03 修复：TRD §5.7 行 348 + §10.1 行 653——请求级总费用=全部账本明细之和，
    // 不只计算最终成功 Attempt。原实现用 finalOutcome.usage（末次 Attempt）会漏算
    // failover 前置 Attempt 的 ESTIMATED usage；且 transaction 级二次 computeBilling
    // 用 Date.now() 可能选到与 line 不同的规则版本。改为对 ledger_line 聚合（明细已冻结
    // billing_rule/multiplier/cost，事务级不再二次匹配）。
    let transactionApiCost: string | null = null; // 供 dispatch 节复用（避免二次重算）
    let transactionUsage: { input: number; output: number; cache: number } | null = null;
    let actualPricingEvidenceComplete = false;
    let actualPricingEvidence: Array<Record<string, unknown>> = [];
    if (finalOutcome) {
      const lines = await deps.ledgerRepo.listLedgerLines(requestId);
      const sumIn = lines.reduce((acc, l) => acc + l.raw_input_tokens, 0n);
      const sumOut = lines.reduce((acc, l) => acc + l.raw_output_tokens, 0n);
      const sumCache = lines.reduce((acc, l) => acc + l.raw_cache_tokens, 0n);
      const sumReasoning = lines.reduce((acc, l) => acc + l.raw_reasoning_tokens, 0n);
      const sumDeducted = lines.reduce((acc, l) => acc + (l.deducted_quota ?? 0n), 0n);
      transactionUsage = {
        input: Number(sumIn),
        output: Number(sumOut),
        cache: Number(sumCache),
      };
      const pricingEvidence = summarizePricingEvidence(lines);
      transactionApiCost = pricingEvidence.actualCost;
      actualPricingEvidenceComplete = pricingEvidence.complete;
      actualPricingEvidence = pricingEvidence.items;
      // usage_quality：单请求同质，取首条明细；无明细时回退 finalOutcome。
      const usageQuality = lines[0]?.usage_quality ?? finalOutcome.usage.quality;
      await deps.ledgerRepo.createLedgerTransactionIfAbsent({
        ai_request_id: requestId,
        enterprise_id: principal.enterpriseId,
        principal_id: principalId,
        total_input_tokens: sumIn,
        total_output_tokens: sumOut,
        total_cache_tokens: sumCache,
        total_reasoning_tokens: sumReasoning,
        total_deducted_quota: sumDeducted,
        total_api_cost: transactionApiCost ?? "0.00000000",
        usage_quality: usageQuality,
        attempt_count: attemptNo,
        overage: requestOverage,
      });
      await deps.ledgerRepo.updateRequestStatus(
        requestId,
        finalOutcome.committed && !finalOutcome.error ? "SUCCEEDED" : "FAILED",
        finalOutcome.error ? mapToClassification(finalOutcome) : null,
        finalOutcome.error ?? null,
      );
    }

    // 4b. W16 落 dispatch_decision（首次 Attempt 决策冻结，§5.7 行 342 不可覆盖；幂等 UNIQUE(ai_request_id)）
    if (deps.dispatchRepo && dispatchFinalAction !== null && dispatchDispatchInput !== null) {
      // actual 来自已冻结账本明细；counterfactual 用完全相同的 Usage 按动作前
      // winner 在请求时刻命中的规则重放。两侧缺少真实价格规则时一律不可比较。
      const actualCost = transactionApiCost;
      const { counterfactualBilling, counterfactualCost, saving } =
        await calculateDispatchSaving({
          finalAction: dispatchFinalAction,
          switchTargetId: dispatchSwitchTargetId,
          baselineCandidate: dispatchBaselineCandidate,
          invokedResourceIds,
          transactionUsage,
          actualCost,
          actualPricingEvidenceComplete,
          ledgerRepo: deps.ledgerRepo,
          enterpriseId: principal.enterpriseId,
          requestStartedAt,
        });
      await deps.dispatchRepo.createDecisionIfAbsent({
        enterpriseId: principal.enterpriseId,
        aiRequestId: requestId,
        dispatchInput: {
          now: dispatchDispatchInput.now,
          unifiedModel: dispatchDispatchInput.unifiedModel,
          selectedResourceId: dispatchDispatchInput.selectedResourceId,
          resourceMode: dispatchDispatchInput.resourceMode,
          priceMultiplier: dispatchDispatchInput.priceMultiplier,
          remainingQuotaRatio: dispatchDispatchInput.remainingQuotaRatio,
          forecastExhaustRisk: dispatchDispatchInput.forecastExhaustRisk,
          principalId: dispatchDispatchInput.principalId,
          matchedTimezone: dispatchMatchedPolicy?.matchTimezone ?? null,
          matchedDaysOfWeek: dispatchMatchedPolicy?.matchDaysOfWeek ?? null,
          matchedStartTime: dispatchMatchedPolicy?.matchStartTime ?? null,
          matchedEndTime: dispatchMatchedPolicy?.matchEndTime ?? null,
          ...dispatchCounterfactualEvidence(dispatchBaselineCandidate, counterfactualBilling),
          executedResourceIds: [...invokedResourceIds],
          usageEvidence: transactionUsage,
          actualPricingEvidence,
          savingCalculationVersion: "pool-021-v1",
        },
        matchedPolicyId: dispatchMatchedPolicy?.id ?? null,
        matchedPolicyVersion: dispatchMatchedPolicy?.policyVersion ?? null,
        matchedPolicyAction: dispatchMatchedPolicy?.action ?? null,
        finalAction: dispatchFinalAction,
        reasonCode: dispatchReasonCode,
        switchTargetResourceId: dispatchSwitchTargetId,
        counterfactualCost,
        actualCost,
        ...dispatchSavingFields(saving),
      });
    }

    // 5. 返回北向响应（OpenAI/Anthropic 兼容）
    // W16：经营调度终止（REJECT/RATE_LIMIT）→ 403/429，理由来自 dispatch_decision
    if (dispatchTerminated) {
      const code = dispatchFinalAction === "REJECT" ? 403 : 429;
      const errCode = dispatchFinalAction === "REJECT" ? "dispatch_rejected" : "dispatch_rate_limited";
      await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", errCode, dispatchReasonCode);
      return reply.code(code).header("x-request-id", traceId).send({
        error: { message: `经营调度${dispatchFinalAction === "REJECT" ? "拒绝" : "限流"}`, type: "server_error", code: errCode, param: null, retryable: false, request_id: requestId },
      });
    }
    if (!finalOutcome) {
      if (keyAuthorizationRevokedDuringDispatch) {
        await deps.ledgerRepo.updateRequestStatus(
          requestId,
          "FAILED",
          "DOWNSTREAM_AUTH_OR_QUOTA",
          "key_or_model_authorization_revoked",
        );
        return reply.code(403).header("x-request-id", traceId).send({
          error: {
            message: "Key 或模型授权在访问上游前已失效",
            type: "authentication_error",
            code: "key_or_model_authorization_revoked",
            param: "model",
            retryable: false,
            request_id: requestId,
          },
        });
      }
      if (grantRevokedDuringDispatch) {
        await deps.ledgerRepo.updateRequestStatus(
          requestId,
          "FAILED",
          "DOWNSTREAM_AUTH_OR_QUOTA",
          "principal_grant_required",
        );
        return reply.code(403).header("x-request-id", traceId).send({
          error: {
            message: "主体授权在访问上游前已失效",
            type: "authentication_error",
            code: "principal_grant_required",
            param: "model",
            retryable: false,
            request_id: requestId,
          },
        });
      }
      if (capacityWaitTimedOut) {
        await deps.ledgerRepo.updateRequestStatus(
          requestId,
          "FAILED",
          "UPSTREAM_RATE_LIMITED",
          "resource_capacity_busy",
        );
        return reply.code(429)
          .header("retry-after", Math.max(1, Math.ceil(capacityRetryAfterMs / 1_000)))
          .send({
            error: {
              message: "套餐并发槽位暂满，请稍后重试",
              type: "rate_limit_error",
              code: "resource_capacity_busy",
              param: null,
              retryable: true,
              retry_after_ms: capacityRetryAfterMs,
              request_id: requestId,
            },
          });
      }
      if (halfOpenProbeBusy) {
        await deps.ledgerRepo.updateRequestStatus(
          requestId,
          "FAILED",
          "UPSTREAM_RATE_LIMITED",
          "half_open_probe_in_progress",
        );
        return reply.code(429)
          .header("retry-after", "1")
          .send({
            error: {
              message: "上游资源正在半开探测，请稍后重试",
              type: "rate_limit_error",
              code: "half_open_probe_in_progress",
              param: null,
              retryable: true,
              retry_after_ms: 1_000,
              request_id: requestId,
            },
          });
      }
      await deps.ledgerRepo.updateRequestStatus(
        requestId,
        "FAILED",
        "NO_HEALTHY_CANDIDATE",
        "no_healthy_candidate",
      );
      return reply.code(503).header("x-request-id", traceId).send({
        error: { message: "无可用上游资源", type: "server_error", code: "no_healthy_candidate", param: null, retryable: true, request_id: requestId },
      });
    }
    if (finalOutcome.error) {
      if (finalSignalResult?.decision === "BLOCKED_UPSTREAM" && finalSignalResult.event) {
        return sendRuntimeBlock(reply, capability, traceId, requestId, finalSignalResult.event);
      }
      if (streamWriter?.committed) {
        streamWriter.fail({
          code: finalOutcome.error === "stream_interrupted_after_commit"
            ? "upstream_stream_interrupted"
            : finalOutcome.error,
          message: finalOutcome.error === "upstream_timeout"
            ? "上游流超时"
            : "上游流在输出期间中断",
          requestId,
        });
        return;
      }
      const quotaExhausted = finalOutcome.upstreamErrorKind === "QUOTA_EXHAUSTED";
      const status = finalOutcome.status === 400
        ? 400
        : quotaExhausted || finalOutcome.status === 429
          ? 429
          : finalOutcome.status === 504
            ? 504
            : 502;
      const retryable = status !== 400 && !quotaExhausted;
      const errorType = status === 400
        ? "invalid_request_error"
        : status === 429
          ? "rate_limit_error"
          : "server_error";
      const errorCode = quotaExhausted
        ? "upstream_quota_exhausted"
        : finalOutcome.error;
      const errorMessage = quotaExhausted
        ? "上游套餐额度已耗尽，请更换资源或续费"
        : finalOutcome.status === 429
          ? "上游套餐暂时限流，请稍后重试"
          : finalOutcome.error;
      if (finalOutcome.retryAfterMs !== undefined) {
        reply.header("retry-after", Math.max(1, Math.ceil(finalOutcome.retryAfterMs / 1_000)));
      }
      return reply.code(status).header("x-request-id", traceId).send({
        error: {
          message: errorMessage,
          type: errorType,
          code: errorCode,
          param: null,
          retryable,
          ...(finalOutcome.retryAfterMs === undefined
            ? {}
            : { retry_after_ms: finalOutcome.retryAfterMs }),
          request_id: requestId,
        },
      });
    }

    if (capability === "messages") {
      if (streamWriter) {
        streamWriter.complete(finalOutcome);
        return;
      }
      const assistant = normalizeAssistantOutput(finalOutcome.responseOutput);
      const content: unknown[] = [];
      if (assistant.text) content.push({ type: "text", text: assistant.text });
      for (const call of assistant.functionCalls) {
        content.push({
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: parseToolArguments(call.arguments),
        });
      }
      if (content.length === 0) content.push({ type: "text", text: "OK" });
      return reply.header("x-request-id", traceId).code(200).send({
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: assistant.functionCalls.length > 0 ? "tool_use" : "end_turn",
        usage: { input_tokens: finalOutcome.usage.input, output_tokens: finalOutcome.usage.output },
      });
    }
    if (capability === "responses") {
      const response = buildResponsesResponse({
        requestId,
        createdAt: created,
        model: body.model,
        request: body.responsesRequest!,
        inputTokens: finalOutcome.usage.input,
        outputTokens: finalOutcome.usage.output,
        cacheTokens: finalOutcome.usage.cache,
        reasoningTokens: finalOutcome.usage.reasoning ?? 0,
        output: finalOutcome.responseOutput,
      });
      if (body.stream) {
        writeResponsesSse(reply, response, traceId);
        return;
      }
      return reply.header("x-request-id", traceId).code(200).send(response);
    }
    const assistant = normalizeAssistantOutput(finalOutcome.responseOutput);
    if (streamWriter) {
      streamWriter.complete(finalOutcome);
      return;
    }
    return reply.header("x-request-id", traceId).code(200).send({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: assistant.text || (assistant.functionCalls.length > 0 ? null : "OK"),
          ...(assistant.functionCalls.length > 0
            ? {
                tool_calls: assistant.functionCalls.map((call) => ({
                  id: call.callId,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: assistant.functionCalls.length > 0 ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: finalOutcome.usage.input,
        completion_tokens: finalOutcome.usage.output,
        total_tokens: finalOutcome.usage.input + finalOutcome.usage.output,
      },
    });
  };
}

function sendIdempotencyReplay(
  reply: FastifyReply,
  traceId: string,
  claim: Exclude<ClaimRequestResult, { kind: "CREATED" }>,
): void {
  const original = claim.request;
  reply.header("x-request-id", traceId);
  reply.header("x-ai-request-id", original.id);

  if (claim.kind === "CONFLICT") {
    reply.code(409).send({
      error: {
        message: "同一 Idempotency-Key 已用于不同请求体",
        type: "invalid_request_error",
        code: "idempotency_key_conflict",
        param: "Idempotency-Key",
        retryable: false,
        request_id: original.id,
      },
    });
    return;
  }

  const replay = idempotencyReplayState(original.status);
  reply.code(409).send({
    error: {
      message: replay.message,
      type: "invalid_request_error",
      code: replay.code,
      param: "Idempotency-Key",
      retryable: replay.retryable,
      request_id: original.id,
      original_status: original.status,
      original_error_code: original.error_code,
    },
  });
}

function idempotencyReplayState(status: string): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (status === "PENDING" || status === "IN_PROGRESS") {
    return {
      code: "idempotency_request_in_progress",
      message: "相同幂等请求正在处理中",
      retryable: true,
    };
  }
  if (status === "SUCCEEDED") {
    return {
      code: "idempotency_request_succeeded",
      message: "相同幂等请求已成功完成；响应正文未持久化，请使用新的 Idempotency-Key 发起新请求",
      retryable: false,
    };
  }
  return {
    code: "idempotency_request_failed",
    message: "相同幂等请求已终止；请使用新的 Idempotency-Key 发起新请求",
    retryable: false,
  };
}

async function hasCurrentKeyModelAuthorization(
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
  if (!key || (key.expires_at !== null && key.expires_at.getTime() <= Date.now())) {
    return false;
  }
  const allowedModelIds = key.allowed_model_ids ?? [];
  if (allowedModelIds.length === 0) return false;
  const model = await db
    .selectFrom("unified_model")
    .select("id")
    .where("enterprise_id", "=", enterpriseId)
    .where("alias", "=", modelAlias)
    .where("status", "=", "ACTIVE")
    .where("id", "in", allowedModelIds)
    .executeTakeFirst();
  return model !== undefined;
}

/**
 * Adapter 前最终授权栅栏：一条查询同时验证 Key/主体/模型/grant。
 * 查询返回后紧接同步对象构造与 adapter.invoke，不再穿插异步 I/O。
 */
async function hasCurrentInvocationAuthorization(
  db: Kysely<Database>,
  enterpriseId: string,
  principalId: string,
  keyId: string,
  modelAlias: string,
  providerCode: string,
): Promise<boolean> {
  const now = new Date();
  const authorization = await db
    .selectFrom("principal_key")
    .innerJoin("principal", "principal.id", "principal_key.principal_id")
    .innerJoin("unified_model", (join) =>
      join
        .onRef("unified_model.enterprise_id", "=", "principal_key.enterprise_id")
        .on("unified_model.alias", "=", modelAlias)
        .on("unified_model.status", "=", "ACTIVE"),
    )
    .innerJoin("principal_grant", (join) =>
      join
        .onRef("principal_grant.enterprise_id", "=", "principal_key.enterprise_id")
        .onRef("principal_grant.principal_id", "=", "principal_key.principal_id")
        // POOL-033：池化后 grant 的 model_alias='*'（厂商池），不再等于具体 unified_model.alias。
        // 改为：池行（pool_model_alias='*'）或精确型号行（model_alias=alias）都匹配。
        .on((eb) => eb.or([
          eb("principal_grant.pool_model_alias", "=", "*"),
          eb("principal_grant.model_alias", "=", "unified_model.alias"),
        ]))
        .on("principal_grant.provider", "=", providerCode)
        .on("principal_grant.status", "=", "ACTIVE"),
    )
    .select([
      "principal_key.allowed_model_ids as allowed_model_ids",
      "principal_key.expires_at as expires_at",
      "unified_model.id as model_id",
    ])
    .where("principal_key.id", "=", keyId)
    .where("principal_key.enterprise_id", "=", enterpriseId)
    .where("principal_key.principal_id", "=", principalId)
    .where("principal_key.status", "=", "ACTIVE")
    .where("principal.status", "=", "ACTIVE")
    .where("principal_grant.valid_from", "<=", now)
    .where((eb) =>
      eb.or([
        eb("principal_grant.valid_until", "is", null),
        eb("principal_grant.valid_until", ">", now),
      ]),
    )
    .executeTakeFirst();
  if (
    !authorization
    || (
      authorization.expires_at !== null
      && authorization.expires_at.getTime() <= now.getTime()
    )
  ) {
    return false;
  }
  return (authorization.allowed_model_ids ?? []).includes(authorization.model_id);
}

function normalizeAssistantOutput(output: unknown[] | undefined): {
  text: string;
  functionCalls: Array<{
    callId: string;
    name: string;
    arguments: string;
  }>;
} {
  let text = "";
  const functionCalls: Array<{
    callId: string;
    name: string;
    arguments: string;
  }> = [];
  for (const rawItem of output ?? []) {
    if (typeof rawItem !== "object" || rawItem === null) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        if (
          typeof rawPart === "object"
          && rawPart !== null
          && typeof (rawPart as Record<string, unknown>).text === "string"
        ) {
          text += (rawPart as Record<string, unknown>).text as string;
        }
      }
    }
    if (
      item.type === "function_call"
      && typeof item.call_id === "string"
      && typeof item.name === "string"
      && typeof item.arguments === "string"
    ) {
      functionCalls.push({
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }
  return { text, functionCalls };
}

function parseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}

async function acquireConcurrencyLeaseWithWait(input: {
  quotaRepo: QuotaGateRepository;
  enterpriseId: string;
  providerResourceId: string;
  aiRequestId: string;
  waitMs: number;
  pollMs: number;
  cancelled: () => boolean;
}): Promise<string | null> {
  const deadline = Date.now() + Math.max(0, input.waitMs);
  while (!input.cancelled()) {
    const lease = await input.quotaRepo.acquireLease({
      enterpriseId: input.enterpriseId,
      providerResourceId: input.providerResourceId,
      aiRequestId: input.aiRequestId,
    });
    if (lease !== null) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await boundedDelay(Math.min(input.pollMs, remaining), input.cancelled);
  }
  return null;
}

async function boundedDelay(
  delayMs: number,
  cancelled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (!cancelled()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 25)));
  }
}

/** 由 Outcome 反推错误分类（Stub 的 error_code → TRD §9 分类）。 */
function mapToClassification(
  outcome: Pick<Outcome, "status" | "error" | "committed" | "upstreamErrorKind">,
): string | null {
  if (!outcome.error) return null;
  if (outcome.committed) return "STREAM_INTERRUPTED_AFTER_COMMIT";
  if (outcome.upstreamErrorKind === "QUOTA_EXHAUSTED") return "UPSTREAM_BILLING_BLOCKED";
  if (outcome.status === 401 || outcome.status === 403) return "UPSTREAM_CREDENTIAL_INVALID";
  if (outcome.status === 429) return "UPSTREAM_RATE_LIMITED";
  if (outcome.status === 402) return "UPSTREAM_BILLING_BLOCKED";
  if (outcome.status >= 500) return "UPSTREAM_TEMPORARY";
  if (outcome.error === "upstream_invalid_response") return "UPSTREAM_TEMPORARY";
  if (outcome.error === "transport_error") return "TRANSPORT_ERROR";
  if (outcome.error === "stream_interrupted_after_commit") return "STREAM_INTERRUPTED_AFTER_COMMIT";
  if (outcome.error === "client_cancelled") return "CLIENT_INVALID";
  if (outcome.status >= 400 && outcome.status < 500) return "CLIENT_INVALID";
  return "UNKNOWN";
}

function sendRuntimeBlock(
  reply: FastifyReply,
  capability: "chat" | "messages" | "responses",
  traceId: string,
  requestId: string,
  event: AvailabilityEvent,
) {
  const recoverAt = event.recover_at?.toISOString();
  const retrySeconds = event.recover_at
    ? Math.max(1, Math.ceil((event.recover_at.getTime() - Date.now()) / 1_000))
    : null;
  if (retrySeconds !== null) reply.header("retry-after", retrySeconds);
  const reason = event.availability_decision === "BLOCKED_SCHEDULE"
    ? "当前处于计划停用时段"
    : availabilitySignalSummary(event.unified_signal as NonNullable<Outcome["unifiedAvailabilitySignal"]>);
  const message = `${event.upstream_model ?? "该模型"}${reason}，${recoverAt ? `预计 ${recoverAt} 恢复` : "等待管理员或上游恢复"}。事件 ${event.event_number}`;
  const common = {
    message,
    code: event.availability_decision === "BLOCKED_SCHEDULE" ? "upstream_scheduled_block" : "upstream_availability_blocked",
    retryable: Boolean(recoverAt),
    ...(recoverAt ? { recover_at: recoverAt } : {}),
    event_id: event.event_number,
  };
  if (capability === "messages") {
    return reply.code(503).header("x-request-id", traceId).send({
      type: "error",
      error: { type: "api_error", ...common },
      request_id: requestId,
    });
  }
  return reply.code(event.unified_signal === "RATE_LIMIT_RETRY_AFTER" ? 429 : 503)
    .header("x-request-id", traceId).send({
      error: { ...common, type: "server_error", param: null, request_id: requestId },
    });
}

/**
 * W14 预请求 token 估算（保守上界）。
 *
 * 预占发生在 Attempt 之前，此时真实 usage 未知。代码库无 tokenizer 依赖；
 * 此处用 body 字符数 / 4 的粗略估算（OpenAI 经验值，对 CJK 偏保守——实际 token 数通常更高）。
 * 倍率折算在 settle 时按实际 deducted_quota 校正（settleQuota 多退少补），故预占只需"够大"。
 * 用 multiplier="1" 口径预占（即 raw token），有计价倍率时预占略偏低，settle 补足。
 *
 * 返回 raw token 估计（bigint）。仅用于 CODING_PLAN 模式 reserveQuota 的 estimatedCost。
 */
function estimateRawTokens(body: { messages?: unknown[] }): bigint {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // input 估计：messages 各项 JSON 序列化后字符数 / 4
  let inputChars = 0;
  for (const m of messages) {
    try {
      inputChars += JSON.stringify(m).length;
    } catch {
      inputChars += 32; // 序列化失败时的兜底
    }
  }
  const inputEstimate = Math.ceil(inputChars / 4);
  // output 预留：保守上界（真实 output 由上游决定，settle 校正）
  const outputReserve = 256;
  return BigInt(inputEstimate + outputReserve);
}
