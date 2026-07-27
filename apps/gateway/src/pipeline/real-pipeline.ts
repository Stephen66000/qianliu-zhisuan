/**
 * real pipeline —— 端到端代表链（W08 DeepSeek；W09 起多厂商）。
 *
 * 把 Adapter（按 providerCode 从注册表解析）+ GatewayLedgerRepository 串起来，
 * 完成 TRD §8 行 496-516 的请求流程：
 *   创建请求意图 → 候选快照 → Attempt → usage → ledger_line → ledger_transaction。
 *
 * W08 用于 WT-03/05/12/14 端到端回归；W09 解除 deepseek 硬编码，支持智谱 Coding Plan。
 * 真实 HTTP 调用在 DEP-PROVIDER-CREDENTIALS 解锁后把 caller 替换为真实实现。
 */
import type { Kysely } from "kysely";
import type { Database, GatewayLedgerRepository } from "@qianliu/database";
import { SecretValue, type UpstreamCaller } from "@qianliu/provider-adapters";
import type { PipelineHandler } from "../routes/chat.js";
import { resolveAdapter } from "./adapter-registry.js";

export interface RealPipelineDeps {
  db: Kysely<Database>;
  ledgerRepo: GatewayLedgerRepository;
  /** 上游调用器（StubUpstream / 真实 fetch）。按 providerCode 解析对应 Adapter。 */
  caller: UpstreamCaller;
  /** 资源查找：enterprise + alias → 候选资源 + providerCode + mode。 */
  findResource: (enterpriseId: string, unifiedModel: string) => Promise<{
    resourceId: string;
    providerCode: string;
    upstreamModel: string;
    principalId: string;
    mode: string;
  } | undefined>;
}

export function createRealPipeline(deps: RealPipelineDeps): PipelineHandler {
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

    // 2. 查候选资源
    const resource = await deps.findResource(principal.enterpriseId, body.model);
    if (!resource) {
      await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "MODEL_NOT_FOUND", "model_not_configured");
      return reply.code(404).send({
        error: { message: "模型未配置", type: "invalid_request_error", code: "model_not_configured", param: "model", retryable: false, request_id: requestId },
      });
    }

    // 3. 候选快照
    await deps.ledgerRepo.createRouteCandidate({
      ai_request_id: requestId,
      enterprise_id: principal.enterpriseId,
      provider_resource_id: resource.resourceId,
      upstream_model: resource.upstreamModel,
      priority: 100,
      weight: 1,
    });

    // 4. Attempt（M2 单 Attempt；多 Attempt failover 在 W12）
    const attempt = await deps.ledgerRepo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: principal.enterpriseId,
      attempt_no: 1,
      provider_resource_id: resource.resourceId,
      upstream_model: resource.upstreamModel,
    });

    // 5. 按 providerCode 解析 Adapter（W09：多厂商，不再硬编码 deepseek）
    const adapter = resolveAdapter(resource.providerCode, deps.caller);
    const outcome = await adapter.invoke(
      {
        providerCode: resource.providerCode as "deepseek" | "zhipu" | "kimi",
        resourceId: resource.resourceId,
        mode: resource.mode === "CODING_PLAN" ? "CODING_PLAN" : "API",
        upstreamModel: resource.upstreamModel,
        concurrencyLimit: 100,
        // 真实凭证解密在 DEP-PROVIDER-CREDENTIALS 解锁后接入；此处空 SecretValue
        secret: new SecretValue(""),
      },
      { requestId, unifiedModel: body.model, stream: body.stream ?? false, body: body.messages },
      1,
    );

    await deps.ledgerRepo.updateAttemptResult(attempt.id, {
      http_status: outcome.status,
      response_committed: outcome.committed,
      finished_at: new Date(),
      error_classification: outcome.error,
      error_code: outcome.error,
    });

    // 6. 写 usage + ledger（若有可证明用量）
    if (outcome.usage.input + outcome.usage.output > 0) {
      const usage = await deps.ledgerRepo.createUsageEventIfAbsent({
        ai_request_id: requestId,
        enterprise_id: principal.enterpriseId,
        upstream_attempt_id: attempt.id,
        provider_resource_id: resource.resourceId,
        input_tokens: BigInt(outcome.usage.input),
        output_tokens: BigInt(outcome.usage.output),
        cache_tokens: BigInt(outcome.usage.cache),
        usage_quality: outcome.usage.quality,
        dedup_key: `${requestId}:attempt1`,
      });
      if (usage) {
        await deps.ledgerRepo.createLedgerLine({
          ai_request_id: requestId,
          enterprise_id: principal.enterpriseId,
          usage_event_id: usage.id,
          upstream_attempt_id: attempt.id,
          provider_resource_id: resource.resourceId,
          principal_id: principal.principalId,
          resource_mode: resource.mode,
          raw_input_tokens: BigInt(outcome.usage.input),
          raw_output_tokens: BigInt(outcome.usage.output),
          raw_cache_tokens: BigInt(outcome.usage.cache),
          api_cost: resource.mode === "API" ? computeApiCost(outcome.usage.input, outcome.usage.output) : null,
          usage_quality: outcome.usage.quality,
        });
      }
    }

    // 7. ledger_transaction（唯一汇总）
    const totalInput = BigInt(outcome.usage.input);
    const totalOutput = BigInt(outcome.usage.output);
    await deps.ledgerRepo.createLedgerTransactionIfAbsent({
      ai_request_id: requestId,
      enterprise_id: principal.enterpriseId,
      principal_id: principal.principalId,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cache_tokens: BigInt(outcome.usage.cache),
      total_deducted_quota: 0n,
      total_api_cost: resource.mode === "API" ? computeApiCost(outcome.usage.input, outcome.usage.output) : "0",
      usage_quality: outcome.usage.quality,
      attempt_count: 1,
    });

    await deps.ledgerRepo.updateRequestStatus(requestId, outcome.committed ? "SUCCEEDED" : "FAILED");

    // 8. 返回北向响应（OpenAI/Anthropic 兼容）
    if (outcome.error) {
      return reply.code(502).header("x-request-id", requestId).send({
        error: { message: outcome.error, type: "server_error", code: outcome.error, param: null, retryable: true, request_id: requestId },
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
        usage: { input_tokens: outcome.usage.input, output_tokens: outcome.usage.output },
      });
    }
    return reply.header("x-request-id", requestId).code(200).send({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: outcome.usage.input,
        completion_tokens: outcome.usage.output,
        total_tokens: outcome.usage.input + outcome.usage.output,
      },
    });
  };
}

/** M2 简化计价：input $0.001/1k + output $0.002/1k（固定；完整规则版本 W13）。 */
function computeApiCost(input: number, output: number): string {
  const cost = (input / 1000) * 0.001 + (output / 1000) * 0.002;
  return cost.toFixed(8);
}
