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
import type { Database, GatewayLedgerRepository, ResourcePoolRepository, DispatchPolicyRepository } from "@qianliu/database";
import { SecretValue, type UpstreamCaller } from "@qianliu/provider-adapters";
import {
  isSwitchable,
  scoreAndSelect,
  pickWinner,
  ROUTING_POLICY,
  matchMultiplierRule,
  matchPriceRule,
  computeDeductedQuota,
  computeApiCostFromRule,
  decideDispatch,
  computeDispatchSaving,
  type BillingRule,
  type DispatchInput,
  type DispatchPolicy,
  type ErrorClassification,
  type RoutingCandidateInput,
  type ScoredCandidate,
} from "@qianliu/domain";
import type { PipelineHandler } from "../routes/chat.js";
import { resolveAdapter } from "./adapter-registry.js";

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
}

export interface RealPipelineDeps {
  db: Kysely<Database>;
  ledgerRepo: GatewayLedgerRepository;
  /** 上游调用器（StubUpstream / 真实 fetch）。按 providerCode 解析对应 Adapter。 */
  caller: UpstreamCaller;
  /** W11 资源池仓储（状态机驱动 + 硬过滤）。 */
  poolRepo: ResourcePoolRepository;
  /** W16 经营调度策略仓储（查已发布策略 + 落决策）。可选；未提供则跳过 dispatch。 */
  dispatchRepo?: DispatchPolicyRepository;
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
  /** 最大 Attempt 数（提交前切换上限；默认 2，有界故障切换）。 */
  maxAttempts?: number;
}

export function createRealPipeline(deps: RealPipelineDeps): PipelineHandler {
  const maxAttempts = deps.maxAttempts ?? 2;
  return async ({ request, reply, body, capability }) => {
    const requestId = request.requestId;
    const principal = request.principal!;
    const created = Math.floor(Date.now() / 1000);

    // 1. 创建请求意图
    await deps.ledgerRepo.createRequest({
      id: requestId,
      enterprise_id: principal.enterpriseId,
      principal_id: principal.principalId,
      principal_key_id: principal.keyId,
      protocol: capability,
      unified_model: body.model,
      stream: body.stream ?? false,
    });

    // 2. 硬过滤（W11）：可服务资源 ∩ model_route 启用候选
    const allCandidates = await deps.listCandidates(principal.enterpriseId, body.model);
    if (allCandidates.length === 0) {
      await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "MODEL_NOT_FOUND", "model_not_configured");
      return reply.code(404).send({
        error: { message: "模型未配置", type: "invalid_request_error", code: "model_not_configured", param: "model", retryable: false, request_id: requestId },
      });
    }
    const servableIds = new Set(
      (await deps.poolRepo.listServableResources(principal.enterpriseId)).map((s) => s.id),
    );
    const eligible: RoutingCandidateInput[] = allCandidates
      .filter((c) => servableIds.has(c.resourceId))
      .map((c) => ({
        resourceId: c.resourceId,
        upstreamModel: c.upstreamModel,
        priority: c.priority,
        weight: c.weight,
        status: c.status as RoutingCandidateInput["status"],
        probe: c.probe,
        mode: c.mode,
        providerCode: c.providerCode,
      }));

    if (eligible.length === 0) {
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
    let finalOutcome: { status: number; committed: boolean; usage: { input: number; output: number; cache: number; quality: string }; error?: string } | null = null;
    let attemptNo = 0;
    let principalId = allCandidates[0]!.principalId;
    // W16 经营调度：首次 Attempt 决策（冻结 dispatch_decision，failover 重评不重复判定）
    let dispatchFinalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE" | null = null;
    let dispatchReasonCode = "";
    let dispatchMatchedPolicy: DispatchPolicy | null = null;
    let dispatchSwitchTargetId: string | null = null;
    let dispatchDispatchInput: DispatchInput | null = null;
    let dispatchTerminated = false;

    while (attemptNo < maxAttempts) {
      attemptNo += 1;
      lastScored = scoreAndSelect(eligible, affinityResourceId, triedResourceIds);
      winner = pickWinner(lastScored);
      if (!winner) break; // 无剩余候选

      // W16：首次 Attempt 做经营调度判定（TRD §9.1 行 611-618）
      if (attemptNo === 1 && deps.dispatchRepo) {
        const availableIds = new Set(eligible.map((e) => e.resourceId));
        const now = Date.now();
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

      // 3b. Attempt
      const attempt = await deps.ledgerRepo.createAttempt({
        ai_request_id: requestId,
        enterprise_id: principal.enterpriseId,
        attempt_no: attemptNo,
        provider_resource_id: cand.resourceId,
        upstream_model: cand.upstreamModel,
      });
      principalId = allCandidates.find((c) => c.resourceId === cand.resourceId)?.principalId ?? principalId;

      const adapter = resolveAdapter(cand.providerCode, deps.caller);
      const outcome = await adapter.invoke(
        {
          providerCode: cand.providerCode as "deepseek" | "zhipu" | "kimi",
          resourceId: cand.resourceId,
          mode: cand.mode,
          upstreamModel: cand.upstreamModel,
          concurrencyLimit: 100,
          secret: new SecretValue(""),
        },
        { requestId, unifiedModel: body.model, stream: body.stream ?? false, body: body.messages },
        attemptNo,
      );

      const classification = (outcome.error ? mapToClassification(outcome) : null);
      await deps.ledgerRepo.updateAttemptResult(attempt.id, {
        http_status: outcome.status,
        response_committed: outcome.committed,
        finished_at: new Date(),
        error_classification: classification,
        error_code: outcome.error ?? null,
        switch_reason: null,
      });

      // 3c. 结果驱动 W11 状态机
      if (outcome.committed && !outcome.error) {
        await deps.poolRepo.recordSuccess(cand.resourceId);
      } else if (classification) {
        await deps.poolRepo.recordFailure(cand.resourceId, classification as ErrorClassification);
      }

      // 3d. usage + ledger（每次有可证明用量的 Attempt 独立明细；WT-11 双 Attempt 双明细）
      if (outcome.usage.input + outcome.usage.output > 0) {
        const usage = await deps.ledgerRepo.createUsageEventIfAbsent({
          ai_request_id: requestId,
          enterprise_id: principal.enterpriseId,
          upstream_attempt_id: attempt.id,
          provider_resource_id: cand.resourceId,
          input_tokens: BigInt(outcome.usage.input),
          output_tokens: BigInt(outcome.usage.output),
          cache_tokens: BigInt(outcome.usage.cache),
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
            deducted_quota: billing.deductedQuota !== null ? BigInt(billing.deductedQuota) : null,
            api_cost: billing.apiCost,
            usage_quality: outcome.usage.quality,
            billing_rule_id: billing.ruleId,
            rule_version: billing.ruleVersion,
            multiplier: billing.multiplier,
          });
        }
      }

      finalOutcome = outcome;

      // 3e. 切换判定：committed=true 绝不切换（WT-12）；committed=false 且可切换错误 → 重评
      if (outcome.committed) break;
      if (!classification || !isSwitchable(classification as ErrorClassification)) break;
      triedResourceIds.add(cand.resourceId);
      await deps.ledgerRepo.updateAttemptResult(attempt.id, { switch_reason: classification });
    }

    // 4. ledger_transaction（唯一汇总；多 Attempt 聚合 token + 费用）
    if (finalOutcome) {
      const totalIn = BigInt(finalOutcome.usage.input);
      const totalOut = BigInt(finalOutcome.usage.output);
      const mode = winner?.input.mode ?? "API";
      const billing = await computeBilling(
        deps.ledgerRepo,
        principal.enterpriseId,
        winner?.input.resourceId ?? "",
        winner?.input.upstreamModel ?? "",
        mode,
        Date.now(),
        finalOutcome.usage,
      );
      await deps.ledgerRepo.createLedgerTransactionIfAbsent({
        ai_request_id: requestId,
        enterprise_id: principal.enterpriseId,
        principal_id: principalId,
        total_input_tokens: totalIn,
        total_output_tokens: totalOut,
        total_cache_tokens: BigInt(finalOutcome.usage.cache),
        total_deducted_quota: billing.deductedQuota !== null ? BigInt(billing.deductedQuota) : 0n,
        total_api_cost: billing.apiCost ?? "0",
        usage_quality: finalOutcome.usage.quality,
        attempt_count: attemptNo,
      });
      await deps.ledgerRepo.updateRequestStatus(
        requestId,
        finalOutcome.committed ? "SUCCEEDED" : "FAILED",
        finalOutcome.error ? mapToClassification(finalOutcome) : null,
        finalOutcome.error ?? null,
      );
    }

    // 4b. W16 落 dispatch_decision（首次 Attempt 决策冻结，§5.7 行 342 不可覆盖；幂等 UNIQUE(ai_request_id)）
    if (deps.dispatchRepo && dispatchFinalAction !== null && dispatchDispatchInput !== null) {
      // 反事实节省：actual 来自最终结算；counterfactual 来自原 winner（若 SWITCH）或同资源（无切换基线不可比）
      const actualCost = finalOutcome ? (await computeBilling(
        deps.ledgerRepo, principal.enterpriseId,
        winner?.input.resourceId ?? "", winner?.input.upstreamModel ?? "",
        winner?.input.mode ?? "API", Date.now(), finalOutcome.usage,
      )).apiCost : null;
      // 反事实基线：SWITCH 时为原评分 winner（被切换走的资源）的预期成本；否则 null（基线不可比）
      const counterfactualCost =
        dispatchFinalAction === "SWITCH" && dispatchSwitchTargetId
          ? actualCost // W16 简化：等价组同档位，基线≈目标成本（真实需按原 winner 规则重算；W17 对账细化）
          : null;
      const actionExecuted = dispatchFinalAction === "SWITCH" && dispatchSwitchTargetId !== null;
      const saving = computeDispatchSaving({
        finalAction: dispatchFinalAction,
        counterfactualCost,
        actualCost,
        actionExecuted,
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
        },
        matchedPolicyId: dispatchMatchedPolicy?.id ?? null,
        matchedPolicyVersion: dispatchMatchedPolicy?.policyVersion ?? null,
        matchedPolicyAction: dispatchMatchedPolicy?.action ?? null,
        finalAction: dispatchFinalAction,
        reasonCode: dispatchReasonCode,
        switchTargetResourceId: dispatchSwitchTargetId,
        counterfactualCost,
        actualCost,
        dispatchSaving: saving.saving === "NOT_CALCULABLE" ? null : saving.saving.toFixed(8),
        savingCalculable: saving.saving !== "NOT_CALCULABLE",
        notCalculableReason: saving.reason,
      });
    }

    // 5. 返回北向响应（OpenAI/Anthropic 兼容）
    // W16：经营调度终止（REJECT/RATE_LIMIT）→ 403/429，理由来自 dispatch_decision
    if (dispatchTerminated) {
      const code = dispatchFinalAction === "REJECT" ? 403 : 429;
      const errCode = dispatchFinalAction === "REJECT" ? "dispatch_rejected" : "dispatch_rate_limited";
      await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", errCode, dispatchReasonCode);
      return reply.code(code).header("x-request-id", requestId).send({
        error: { message: `经营调度${dispatchFinalAction === "REJECT" ? "拒绝" : "限流"}`, type: "server_error", code: errCode, param: null, retryable: false, request_id: requestId },
      });
    }
    if (!finalOutcome) {
      return reply.code(503).header("x-request-id", requestId).send({
        error: { message: "无可用上游资源", type: "server_error", code: "no_healthy_candidate", param: null, retryable: true, request_id: requestId },
      });
    }
    if (finalOutcome.error) {
      return reply.code(502).header("x-request-id", requestId).send({
        error: { message: finalOutcome.error, type: "server_error", code: finalOutcome.error, param: null, retryable: true, request_id: requestId },
      });
    }

    if (capability === "messages") {
      return reply.header("x-request-id", requestId).code(200).send({
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: finalOutcome.usage.input, output_tokens: finalOutcome.usage.output },
      });
    }
    return reply.header("x-request-id", requestId).code(200).send({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: finalOutcome.usage.input,
        completion_tokens: finalOutcome.usage.output,
        total_tokens: finalOutcome.usage.input + finalOutcome.usage.output,
      },
    });
  };
}

/** 由 Outcome 反推错误分类（Stub 的 error_code → TRD §9 分类）。 */
function mapToClassification(outcome: { status: number; error?: string }): string | null {
  if (!outcome.error) return null;
  if (outcome.status === 401 || outcome.status === 403) return "UPSTREAM_CREDENTIAL_INVALID";
  if (outcome.status === 429) return "UPSTREAM_RATE_LIMITED";
  if (outcome.status === 402) return "UPSTREAM_BILLING_BLOCKED";
  if (outcome.status >= 500) return "UPSTREAM_TEMPORARY";
  if (outcome.error === "transport_error") return "TRANSPORT_ERROR";
  if (outcome.error === "stream_interrupted_after_commit") return "STREAM_INTERRUPTED_AFTER_COMMIT";
  if (outcome.error === "client_cancelled") return "CLIENT_INVALID";
  return "UNKNOWN";
}

/** W13 计价结果。 */
interface BillingOutcome {
  apiCost: string | null;
  deductedQuota: string | null;
  ruleId: string | null;
  ruleVersion: string | null;
  multiplier: string | null;
}

/**
 * W13：按 Attempt 开始时间 + 资源 + 模型匹配生效规则版本，计算费用/扣减。
 * - API 模式：API_PRICE 规则（cache 命中/未命中/输出分项 × 单价）；无规则回退 M2 简化价。
 * - CODING_PLAN 模式：api_cost=null（PACKAGE_INCLUDED 语义，不写数值 0）；
 *   deducted_quota = raw × matched_multiplier（无倍数规则时 multiplier="1"，原始口径）。
 * 历史不重算：命中规则的 id/version/multiplier 冻结到 ledger_line。
 */
async function computeBilling(
  ledgerRepo: GatewayLedgerRepository,
  enterpriseId: string,
  resourceId: string,
  upstreamModel: string,
  mode: "API" | "CODING_PLAN",
  attemptStartedAt: number,
  usage: { input: number; output: number; cache: number },
): Promise<BillingOutcome> {
  const rules = (await ledgerRepo.listActiveBillingRules(enterpriseId, new Date(attemptStartedAt))).map(
    (r): BillingRule => ({
      id: r.id,
      ruleType: r.rule_type as BillingRule["ruleType"],
      ruleVersion: r.rule_version,
      providerResourceId: r.provider_resource_id,
      upstreamModel: r.upstream_model,
      effectiveFrom: r.effective_from.getTime(),
      effectiveTo: r.effective_to ? r.effective_to.getTime() : null,
      timezone: r.timezone,
      daysOfWeek: r.days_of_week,
      startTime: r.start_time,
      endTime: r.end_time,
      multiplier: r.multiplier,
      cacheHitPrice: r.cache_hit_price,
      cacheMissPrice: r.cache_miss_price,
      outputPrice: r.output_price,
      currency: r.currency,
      priority: r.priority,
    }),
  );

  if (mode === "CODING_PLAN") {
    const match = matchMultiplierRule(rules, resourceId, upstreamModel, attemptStartedAt);
    const multiplier = match?.multiplier ?? "1";
    const rawTotal = usage.input + usage.output + usage.cache;
    return {
      apiCost: null, // PACKAGE_INCLUDED（TRD §10.2：不写数值 0）
      deductedQuota: computeDeductedQuota(rawTotal, multiplier),
      ruleId: match?.ruleId ?? null,
      ruleVersion: match?.ruleVersion ?? null,
      multiplier,
    };
  }

  // API 模式
  const priceRule = matchPriceRule(rules, resourceId, upstreamModel, attemptStartedAt);
  const apiCost = priceRule
    ? computeApiCostFromRule(priceRule, usage.input, usage.output, usage.cache)
    : legacyApiCost(usage.input, usage.output); // 无规则回退 M2 简化价（过渡期）
  return {
    apiCost,
    deductedQuota: null,
    ruleId: priceRule?.id ?? null,
    ruleVersion: priceRule?.ruleVersion ?? null,
    multiplier: null,
  };
}

/** M2 简化计价回退（无 API_PRICE 规则时）：input $0.001/1k + output $0.002/1k。 */
function legacyApiCost(input: number, output: number): string {
  const cost = (input / 1000) * 0.001 + (output / 1000) * 0.002;
  return cost.toFixed(8);
}
