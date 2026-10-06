/**
 * Key 级限制的管线执行（F-014，TRD §5.3）：
 *   - 并发限制：按 principal_key 统计在途 ai_request（含自身行，commit-before-count
 *     保证并发下至多放行 limit 个，fail-closed 可能轻微多拒）。
 *   - 额度限制：原子条件 UPDATE 预估预占，请求结束时按实扣校正。
 *   - IP 限制在 principal-auth（Key 校验）层执行，不在本模块。
 *
 * 校正不与请求终态结算同事务：崩溃残留只会使 used_tokens 偏大（保守）。
 */
import { ERROR_CLASSIFICATION } from "@qianliu/domain";
import { estimateRawTokens } from "./runtime-controls.js";
import type {
  PipelineContext,
  PrincipalKeyReservation,
} from "./real-pipeline-types.js";

/** 崩溃残留的 IN_PROGRESS 请求超过该窗口后不再计入 Key 并发。 */
export const KEY_IN_FLIGHT_WINDOW_MS = 60 * 60 * 1_000;

type AdmissionContextParts = Omit<PipelineContext, "keyReservation">;

/**
 * 准入末段执行 Key 级并发/额度门禁并补齐 context。
 * 返回 null 表示已拒绝（响应已发送，ai_request 已写 FAILED）。
 */
export async function enforceKeyLimitsAndAssembleContext(
  parts: AdmissionContextParts,
): Promise<PipelineContext | null> {
  const { deps, principal, requestId, traceId, reply } = parts;
  if (principal.concurrencyLimit !== null) {
    const inFlight = await deps.ledgerRepo.countInFlightByPrincipalKey(
      principal.keyId, KEY_IN_FLIGHT_WINDOW_MS,
    );
    if (inFlight > principal.concurrencyLimit) {
      await deps.ledgerRepo.updateRequestStatus(
        requestId, "FAILED", ERROR_CLASSIFICATION.DOWNSTREAM_AUTH_OR_QUOTA, "key_concurrency_limited",
      );
      reply.code(429).header("x-request-id", traceId).send({
        error: {
          message: "该 Key 的并发请求数已达上限，请稍后重试或调整 Key 并发限制",
          type: "rate_limit_error",
          code: "key_concurrency_limited",
          param: null,
          retryable: true,
          request_id: requestId,
        },
      });
      return null;
    }
  }
  let keyReservation: PrincipalKeyReservation | null = null;
  if (principal.quotaLimit !== null) {
    const estimatedCost = estimateRawTokens(parts.effectiveBody);
    const reserve = await deps.quotaRepo.reservePrincipalKeyQuota({
      enterpriseId: principal.enterpriseId,
      principalKeyId: principal.keyId,
      estimatedCost,
    });
    if (reserve === "EXHAUSTED") {
      await deps.ledgerRepo.updateRequestStatus(
        requestId, "FAILED", ERROR_CLASSIFICATION.DOWNSTREAM_AUTH_OR_QUOTA, "key_quota_exhausted",
      );
      reply.code(429).header("x-request-id", traceId).send({
        error: {
          message: "该 Key 的 Token 额度已用尽，请调整 Key 额度限制",
          type: "rate_limit_error",
          code: "key_quota_exhausted",
          param: null,
          retryable: false,
          request_id: requestId,
        },
      });
      return null;
    }
    if (reserve === "RESERVED") {
      keyReservation = { principalKeyId: principal.keyId, reservedEstimate: estimatedCost };
    }
  }
  return { ...parts, keyReservation };
}

/**
 * 请求结束（终态结算或响应已直接返回）后校正 Key 级计数：
 * used = max(0, used - 预占 + 实扣)。失败只告警，不抛出（fail-closed 偏大）。
 *
 * 实扣口径（F-014 补遗）：Key 计数单位 = 原始 Token（raw input + raw output），
 * 与套餐扣减的 rawTotal（billing.computeBilling：deducted = (input+output)×倍率）
 * 及预占估计（estimateRawTokens：input 估计 + 输出预留）同单位；API 行
 * deducted_quota 恒为 null，不得以套餐扣减列代替实际用量。
 * 未知用量不退款：任一已向上游提交响应（response_committed）的 Attempt 缺少
 * 厂商上报用量（usage_quality ≠ PROVIDER_REPORTED）时，实际消耗不可信，
 * 保留全部预占（不按零消费退款）。本函数每请求仅执行一次；结算重试由
 * finalize 幂等护栏覆盖，崩溃残留只会使计数偏大（保守）。
 */
export async function settlePrincipalKeyReservation(context: PipelineContext): Promise<void> {
  const reservation = context.keyReservation;
  if (!reservation) return;
  try {
    const [lines, attempts] = await Promise.all([
      context.deps.ledgerRepo.listLedgerLines(context.requestId),
      context.deps.ledgerRepo.listAttempts(context.requestId),
    ]);
    const linesByAttemptId = new Map<string, typeof lines>();
    for (const line of lines) {
      const bucket = linesByAttemptId.get(line.upstream_attempt_id) ?? [];
      bucket.push(line);
      linesByAttemptId.set(line.upstream_attempt_id, bucket);
    }
    const measuredUsage = lines.reduce(
      (sum, line) => sum + BigInt(line.raw_input_tokens) + BigInt(line.raw_output_tokens), 0n,
    );
    const committedWithoutProviderUsage = attempts.some((attempt) =>
      attempt.response_committed === true
      && (linesByAttemptId.get(attempt.id) ?? []).some(
        (line) => line.usage_quality !== "PROVIDER_REPORTED",
      ));
    const actualUsage = committedWithoutProviderUsage
      ? reservation.reservedEstimate
      : measuredUsage;
    await context.deps.quotaRepo.settlePrincipalKeyQuota(
      reservation.principalKeyId, reservation.reservedEstimate, actualUsage,
    );
  } catch (error) {
    context.request.log.warn({ err: error }, "principal key quota settle failed; used_tokens stays over-counted");
  }
}
