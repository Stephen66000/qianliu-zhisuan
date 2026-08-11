/**
 * 运行保障单次调度：恢复到期事件、回收失联通知、发送企业微信并按上限退避重试。
 * Repository 保证 claim 的跨实例互斥；本函数不持有长期状态，重复 tick 可安全执行。
 */
import type { RuntimeAssuranceRepository } from "@qianliu/database";
import type { WecomAppClient } from "./wecom-client.js";

export interface RuntimeTickResult {
  recoveredDue: number;
  recoveredSchedules: number;
  staleClaimsReleased: number;
  deliveriesProcessed: number;
  legacyShadowSafe: number;
  legacyShadowReview: number;
}

/** 执行一个有界批次并返回可观测统计；永久失败不会无限重试。 */
export async function runRuntimeAssuranceTick(input: {
  repository: RuntimeAssuranceRepository;
  wecom: WecomAppClient;
  wecomNotify: boolean;
  now?: Date;
  deliveryLimit?: number;
}): Promise<RuntimeTickResult> {
  const now = input.now ?? new Date();
  const staleClaimsReleased = await input.repository.releaseStaleDeliveries(new Date(now.getTime() - 10 * 60_000), now);
  const recoveredDue = await input.repository.recoverDueEvents(now, input.wecomNotify);
  const recoveredSchedules = await input.repository.recoverInactiveScheduleEvents(now, input.wecomNotify);
  const legacy = await input.repository.assessLegacyUnavailable();
  const claimed = await input.repository.claimDeliveries(input.deliveryLimit ?? 20, now);
  for (const delivery of claimed) {
    const context = await input.repository.getDeliveryContext(delivery.id);
    if (!context) {
      await input.repository.completeDelivery({ id: delivery.id, status: "PERMANENT_FAILED", classification: "DELIVERY_CONTEXT_MISSING" });
      continue;
    }
    if (!input.wecomNotify && delivery.delivery_type !== "TEST") {
      await input.repository.completeDelivery({ id: delivery.id, status: "SKIPPED", classification: "WECOM_NOTIFY_DISABLED" });
      continue;
    }
    const result = await input.wecom.send(context);
    const attempts = delivery.attempt_count + 1;
    const exhausted = result.status === "RETRYABLE_FAILED" && attempts >= 5;
    const backoffMs = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
    await input.repository.completeDelivery({
      id: delivery.id,
      status: exhausted ? "PERMANENT_FAILED" : result.status,
      providerMessageId: result.providerMessageId,
      providerErrorCode: result.providerErrorCode,
      classification: exhausted ? "RETRY_LIMIT_EXHAUSTED" : result.classification,
      nextAttemptAt: result.status === "RETRYABLE_FAILED" && !exhausted
        ? new Date(now.getTime() + backoffMs)
        : null,
    });
  }
  return {
    recoveredDue: recoveredDue.length,
    recoveredSchedules: recoveredSchedules.length,
    staleClaimsReleased,
    deliveriesProcessed: claimed.length,
    legacyShadowSafe: legacy.filter((item) => item.disposition === "SAFE_DOWNGRADE").length,
    legacyShadowReview: legacy.filter((item) => item.disposition === "MANUAL_REVIEW").length,
  };
}
