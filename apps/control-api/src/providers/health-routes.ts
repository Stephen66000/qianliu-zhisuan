/**
 * POOL-031：厂商资源健康详情聚合端点。
 *
 * 服务端聚合 provider_resource 运行字段 + resource_status_event 审计轨迹，
 * 返回结构化健康详情（原因/可用性/调度影响/恢复说明），严禁让 Web 解析日志推断。
 * 只展示脱敏运行元数据，不含凭证/正文/敏感响应。
 */
import type { FastifyInstance } from "fastify";
import { evaluateAdmission, RESOURCE_STATUS, STATE_REASON } from "@qianliu/domain";
import { requireAuth } from "../plugins/auth-guard.js";

/** 状态中文标签。 */
const STATUS_LABEL: Record<string, string> = {
  [RESOURCE_STATUS.ACTIVE]: "正常",
  [RESOURCE_STATUS.DEGRADED]: "降级（仍可使用）",
  [RESOURCE_STATUS.EXHAUSTED]: "额度耗尽",
  [RESOURCE_STATUS.EXPIRED]: "凭证过期",
  [RESOURCE_STATUS.CREDENTIAL_INVALID]: "凭证失效",
  [RESOURCE_STATUS.RATE_LIMITED]: "限流冷却",
  [RESOURCE_STATUS.UNAVAILABLE]: "不可用",
};

/** 稳定原因码中文。 */
const REASON_LABEL: Record<string, string> = {
  [STATE_REASON.PASSIVE_SUCCESS]: "恢复正常",
  [STATE_REASON.PASSIVE_FAILURE]: "技术失败累计",
  [STATE_REASON.CREDENTIAL_REJECTED]: "厂商拒绝凭证",
  [STATE_REASON.RATE_LIMITED]: "触发厂商限流",
  [STATE_REASON.BILLING_BLOCKED]: "厂商计费阻断",
  [STATE_REASON.FAILURE_THRESHOLD]: "连续失败达阈值",
  [STATE_REASON.CREDENTIAL_EXPIRED]: "凭证到期",
  [STATE_REASON.REFRESH_FAILED]: "凭证刷新失败",
  [STATE_REASON.ADMIN_RECOVER]: "管理员人工恢复",
  [STATE_REASON.HALF_OPEN_PROBE_OK]: "半开探测成功",
  [STATE_REASON.QUOTA_SYNC_RECOVERED]: "厂商额度同步确认恢复",
};

/** 根据准入判定推导调度影响文案。 */
function dispatchImpact(admit: boolean, probe: boolean, status: string): string {
  if (status === RESOURCE_STATUS.ACTIVE) return "正常参与调度";
  if (status === RESOURCE_STATUS.DEGRADED) return "降低权重，仍允许请求";
  if (probe) return "半开探测中（限量试探）";
  if (status === RESOURCE_STATUS.RATE_LIMITED) return "限流冷却中，暂停准入";
  if (!admit) return "禁止准入";
  return "正常参与调度";
}

/** 根据状态与原因推导恢复说明。 */
function recoveryGuide(
  status: string,
  reason: string | null,
  cooldownUntil: string | null,
  mode: string,
): string {
  switch (status) {
    case RESOURCE_STATUS.ACTIVE:
      return "资源健康，无需处置。";
    case RESOURCE_STATUS.DEGRADED:
      if (reason === STATE_REASON.QUOTA_SYNC_RECOVERED) {
        return "厂商额度已确认恢复，下一次成功请求后自动恢复为正常。";
      }
      return "技术失败自动降级，后续成功请求会自动恢复为正常。";
    case RESOURCE_STATUS.RATE_LIMITED:
      return cooldownUntil
        ? `限流冷却中，预计 ${cooldownUntil} 后自动进入半开探测。`
        : "限流冷却中，到期后自动进入半开探测。";
    case RESOURCE_STATUS.UNAVAILABLE:
      return "连续失败已隔离，冷却到期后自动半开探测；持续失败请检查上游。";
    case RESOURCE_STATUS.CREDENTIAL_INVALID:
      if (mode === "CODING_PLAN" && cooldownUntil) {
        return `等待厂商额度与凭证复核，系统将在 ${cooldownUntil} 自动重试同步。`;
      }
      return reason === STATE_REASON.REFRESH_FAILED
        ? "凭证自动刷新失败，请更新凭证后人工恢复。"
        : "厂商拒绝凭证，请更新凭证后人工恢复。";
    case RESOURCE_STATUS.EXPIRED:
      return "凭证已到期，请更新凭证后人工恢复。";
    case RESOURCE_STATUS.EXHAUSTED:
      if (mode === "CODING_PLAN" && cooldownUntil) {
        return `厂商额度已耗尽，系统将在 ${cooldownUntil} 自动重试同步。`;
      }
      return "厂商额度耗尽，请补充套餐或等待额度重置后人工恢复。";
    default:
      return "请检查资源配置或联系管理员。";
  }
}

export function registerProviderHealthRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/provider-resources/:id/health", { preHandler: [requireAuth] }, async (req, reply) => {
      const enterpriseId = req.admin!.enterpriseId;
      const resource = await app.db.selectFrom("provider_resource")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!resource) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }

      // 审计轨迹（按时间升序），推导首次/最近/最近成功时间与稳定原因码。
      const events = await app.poolRepo.listStatusEvents(resource.id);
      const now = Date.now();
      const cooldownUntilMs = resource.cooldown_until ? new Date(resource.cooldown_until).getTime() : null;

      const admission = evaluateAdmission(
        {
          status: resource.status as typeof RESOURCE_STATUS[keyof typeof RESOURCE_STATUS],
          consecutiveFailures: resource.consecutive_failures,
          cooldownUntil: cooldownUntilMs,
        },
        now,
      );

      // 最新一条事件 = 最近状态变更（原因码/时间来源）。
      const latestEvent = events.length > 0 ? events[events.length - 1] : null;
      // 当前异常状态连续段最早一条（首次发生时间）。
      const firstOfCurrent = latestEvent && latestEvent.to_status === resource.status
        ? (() => {
            // 从末尾向前找，直到状态不再等于当前状态。
            let idx = events.length - 1;
            while (idx >= 0 && events[idx]?.to_status === resource.status) idx -= 1;
            const candidate = events[idx + 1];
            return candidate ?? latestEvent;
          })()
        : null;
      // 最近一次成功事件。
      const lastSuccessEvent = [...events].reverse()
        .find((e) => e.reason === STATE_REASON.PASSIVE_SUCCESS
          || e.reason === STATE_REASON.HALF_OPEN_PROBE_OK
          || e.reason === STATE_REASON.QUOTA_SYNC_RECOVERED)
        ?? null;

      const reason = latestEvent?.reason ?? null;
      const cooldownUntilIso = resource.cooldown_until?.toISOString() ?? null;

      return {
        resource_id: resource.id,
        resource_name: resource.name,
        status: resource.status,
        status_label: STATUS_LABEL[resource.status] ?? resource.status,
        available: admission.admit,
        probe: admission.probe,
        // 稳定原因码（脱敏枚举，非自然语言日志）。
        reason_code: reason,
        reason_label: reason ? (REASON_LABEL[reason] ?? reason) : null,
        error_classification: latestEvent?.error_classification ?? null,
        consecutive_failures: resource.consecutive_failures,
        first_occurred_at: firstOfCurrent?.created_at?.toISOString() ?? null,
        last_occurred_at: latestEvent?.created_at?.toISOString() ?? null,
        last_success_at: lastSuccessEvent?.created_at?.toISOString() ?? null,
        cooldown_until: cooldownUntilIso,
        last_probe_at: resource.last_probe_at?.toISOString() ?? null,
        credential_refresh_status: resource.credential_refresh_status,
        refresh_error_classification: resource.refresh_error_classification ?? null,
        credential_expires_at: resource.credential_expires_at?.toISOString() ?? null,
        dispatch_impact: dispatchImpact(admission.admit, admission.probe, resource.status),
        recovery_guide: recoveryGuide(resource.status, reason, cooldownUntilIso, resource.mode),
        can_recover: new Set<string>([
          RESOURCE_STATUS.CREDENTIAL_INVALID,
          RESOURCE_STATUS.EXPIRED,
          RESOURCE_STATUS.EXHAUSTED,
          RESOURCE_STATUS.UNAVAILABLE,
        ]).has(resource.status),
      };
    },
  );
}
