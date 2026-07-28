/**
 * 诊断下钻路由（W20）—— /gateway-requests/{id} 请求级明细 + 路由过程。
 *
 * 依据：TRD §11.2（/gateway-requests/{id} 及子路由）、PRD §10.3（路由过程展开）。
 * 支撑 WT-10（候选/优先级/权重）、WT-11（多 Attempt 账本）、WT-12（流式中断）、
 * WT-16（调度决策输入/动作/结果）、WT-17（节省可计算性）、WT-18（评分因子）。
 *
 * 安全（TRD §11.2）：不返回 Secret、Key 摘要、Session HMAC、原始网络标识；
 * 错误详情只返回脱敏分类与错误码。score_factors / dispatch_input 为 jsonb，
 * 由网关侧写入时已脱敏，本路由原样返回不二次加工。
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";

/** 校验请求归属本企业，返回 404 或请求行。 */
async function findOwnedRequest(app: FastifyInstance, enterpriseId: string, requestId: string) {
  const request = await app.ledgerRepo.getRequest(requestId);
  if (!request || request.enterprise_id !== enterpriseId) {
    return null;
  }
  return request;
}

export function registerGatewayRequestRoutes(app: FastifyInstance): void {
  // 请求级明细（结算汇总 + 状态）
  app.get<{ Params: { id: string } }>(
    "/gateway-requests/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const ent = req.admin!.enterpriseId;
      const request = await findOwnedRequest(app, ent, req.params.id);
      if (!request) {
        return reply.code(404).send({ error: "not_found", message: "请求不存在" });
      }
      const transaction = await app.ledgerRepo.getLedgerTransaction(req.params.id);
      return {
        request: {
          id: request.id,
          principalId: request.principal_id,
          protocol: request.protocol,
          unifiedModel: request.unified_model,
          stream: request.stream,
          status: request.status,
          clientId: request.client_id,
          startedAt: request.started_at,
          finishedAt: request.finished_at,
          errorClassification: request.error_classification,
          errorCode: request.error_code,
        },
        settlement: transaction
          ? {
              totalInputTokens: transaction.total_input_tokens,
              totalOutputTokens: transaction.total_output_tokens,
              totalCacheTokens: transaction.total_cache_tokens,
              totalDeductedQuota: transaction.total_deducted_quota,
              totalApiCost: transaction.total_api_cost,
              usageQuality: transaction.usage_quality,
              attemptCount: transaction.attempt_count,
              status: transaction.status,
            }
          : null,
      };
    },
  );

  // 路由候选（WT-10/WT-18：评分因子、优先级、权重、是否选中）
  app.get<{ Params: { id: string } }>(
    "/gateway-requests/:id/route-candidates",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const ent = req.admin!.enterpriseId;
      const request = await findOwnedRequest(app, ent, req.params.id);
      if (!request) {
        return reply.code(404).send({ error: "not_found", message: "请求不存在" });
      }
      const candidates = await app.ledgerRepo.listRouteCandidates(req.params.id);
      return {
        candidates: candidates.map((c) => ({
          providerResourceId: c.provider_resource_id,
          upstreamModel: c.upstream_model,
          priority: c.priority,
          weight: c.weight,
          selected: c.selected,
          scoreFactors: c.score_factors,
          totalScore: c.total_score,
          reasonCode: c.reason_code,
        })),
      };
    },
  );

  // 上游尝试（WT-11/WT-12：顺序、首字节/总耗时、状态码、错误、流式提交、切换原因）
  app.get<{ Params: { id: string } }>(
    "/gateway-requests/:id/attempts",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const ent = req.admin!.enterpriseId;
      const request = await findOwnedRequest(app, ent, req.params.id);
      if (!request) {
        return reply.code(404).send({ error: "not_found", message: "请求不存在" });
      }
      const attempts = await app.ledgerRepo.listAttempts(req.params.id);
      return {
        attempts: attempts.map((a) => ({
          attemptNo: a.attempt_no,
          providerResourceId: a.provider_resource_id,
          upstreamModel: a.upstream_model,
          startedAt: a.started_at,
          firstByteAt: a.first_byte_at,
          finishedAt: a.finished_at,
          httpStatus: a.http_status,
          errorClassification: a.error_classification,
          errorCode: a.error_code,
          responseCommitted: a.response_committed,
          switchReason: a.switch_reason,
        })),
      };
    },
  );

  // 调度决策（WT-16/WT-17：命中规则、动作、理由、节省可计算性）
  app.get<{ Params: { id: string } }>(
    "/gateway-requests/:id/dispatch-decision",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const ent = req.admin!.enterpriseId;
      const request = await findOwnedRequest(app, ent, req.params.id);
      if (!request) {
        return reply.code(404).send({ error: "not_found", message: "请求不存在" });
      }
      const decision = await app.dispatchRepo.getDecision(req.params.id);
      if (!decision) {
        return { decision: null };
      }
      return {
        decision: {
          finalAction: decision.final_action,
          reasonCode: decision.reason_code,
          reasonDetail: decision.reason_detail,
          matchedPolicyId: decision.matched_policy_id,
          switchTargetResourceId: decision.switch_target_resource_id,
          counterfactualCost: decision.counterfactual_cost,
          actualCost: decision.actual_cost,
          dispatchSaving: decision.dispatch_saving,
          savingCalculable: decision.saving_calculable,
          notCalculableReason: decision.not_calculable_reason,
        },
      };
    },
  );
}
