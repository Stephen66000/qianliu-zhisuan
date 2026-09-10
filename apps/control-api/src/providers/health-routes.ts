/**
 * POOL-031：厂商资源健康详情聚合端点。
 *
 * 服务端聚合 provider_resource 运行字段 + resource_status_event 审计轨迹，
 * 返回结构化健康详情（原因/可用性/调度影响/恢复说明），严禁让 Web 解析日志推断。
 * 只展示脱敏运行元数据，不含凭证/正文/敏感响应。
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { evaluateAdmission, RESOURCE_STATUS, STATE_REASON } from "@qianliu/domain";
import type { ProviderResourceRow, ResourceStatusEvent } from "@qianliu/database";
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
  CHAT_AUTH_PROBE_RECOVERED: "Chat 鉴权验证通过",
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
  [STATE_REASON.BALANCE_SYNC_RECOVERED]: "厂商余额同步确认恢复",
};
const RECOVERABLE_STATUSES = new Set<string>([
  RESOURCE_STATUS.CREDENTIAL_INVALID, RESOURCE_STATUS.EXPIRED,
  RESOURCE_STATUS.EXHAUSTED, RESOURCE_STATUS.UNAVAILABLE,
]);

function statusLabel(status: string, mode: string, reason: string | null): string {
  if (status === RESOURCE_STATUS.DEGRADED && reason === STATE_REASON.QUOTA_SYNC_RECOVERED) {
    return "额度已恢复，待调用确认";
  }
  if (status === RESOURCE_STATUS.DEGRADED && reason === STATE_REASON.BALANCE_SYNC_RECOVERED) {
    return "余额已恢复，待调用确认";
  }
  if (status === RESOURCE_STATUS.EXHAUSTED) {
    return mode === "API" ? "余额不足" : "套餐额度耗尽";
  }
  return STATUS_LABEL[status] ?? status;
}

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
      if (reason === "CHAT_AUTH_PROBE_RECOVERED") return "当前凭证已通过原故障模型的 Chat 验证，后续成功请求会恢复为正常。";
      if (reason === STATE_REASON.QUOTA_SYNC_RECOVERED) {
        return "厂商额度已确认恢复，下一次成功请求后自动恢复为正常。";
      }
      if (reason === STATE_REASON.BALANCE_SYNC_RECOVERED) {
        return "厂商 API 余额已确认恢复，下一次成功请求后自动恢复为正常。";
      }
      return "技术失败自动降级，后续成功请求会自动恢复为正常。";
    case RESOURCE_STATUS.RATE_LIMITED:
      return cooldownUntil
        ? `限流冷却中，预计 ${cooldownUntil} 后自动进入半开探测。`
        : "限流冷却中，到期后自动进入半开探测。";
    case RESOURCE_STATUS.UNAVAILABLE:
      return "连续失败已隔离，冷却到期后自动半开探测；持续失败请检查上游。";
    case RESOURCE_STATUS.CREDENTIAL_INVALID:
      return reason === STATE_REASON.REFRESH_FAILED
        ? "凭证自动刷新失败，请更新凭证后人工恢复。"
        : "Chat 鉴权失败，资源已隔离。额度同步不会解封；请验证当前凭证，或更新凭证后恢复。";
    case RESOURCE_STATUS.EXPIRED:
      return "凭证已到期，请更新凭证后人工恢复。";
    case RESOURCE_STATUS.EXHAUSTED:
      if (mode === "API") {
        return "API 余额不足；充值后由厂商余额同步自动解除隔离。";
      }
      if (mode === "CODING_PLAN" && cooldownUntil) {
        return `厂商额度已耗尽，系统将在 ${cooldownUntil} 自动重试同步。`;
      }
      return "厂商额度耗尽，请补充套餐或等待额度重置后人工恢复。";
    default:
      return "请检查资源配置或联系管理员。";
  }
}

interface HealthEvidence {
  events: ResourceStatusEvent[];
  successfulRequestAt: Date | null;
  quotaSyncAt: Date | null;
}

async function loadHealthEvidence(
  app: FastifyInstance, enterpriseId: string, resourceId: string,
): Promise<HealthEvidence> {
  const [events, request, quota] = await Promise.all([
    app.poolRepo.listStatusEvents(resourceId),
    app.db.selectFrom("upstream_attempt as attempt")
      .innerJoin("ai_request as request", (join) => join
        .onRef("request.enterprise_id", "=", "attempt.enterprise_id")
        .onRef("request.id", "=", "attempt.ai_request_id"))
      .select(["request.finished_at as request_finished_at", "attempt.finished_at as attempt_finished_at"])
      .where("attempt.enterprise_id", "=", enterpriseId)
      .where("attempt.provider_resource_id", "=", resourceId)
      .where("attempt.response_committed", "=", true)
      .where("request.status", "=", "SUCCEEDED")
      .orderBy("request.finished_at", "desc").executeTakeFirst(),
    sql<{ last_success_at: Date | null }>`
      SELECT MAX(quota.last_success_at) AS last_success_at
        FROM provider_quota_window quota
        JOIN provider_resource resource ON resource.id=quota.provider_resource_id
         AND resource.enterprise_id=quota.enterprise_id
        JOIN provider ON provider.id=resource.provider_id
         AND provider.enterprise_id=resource.enterprise_id
       WHERE quota.enterprise_id=${enterpriseId}::uuid
         AND quota.provider_resource_id=${resourceId}::uuid
         AND quota.is_current=true
         AND provider.code IN ('kimi','zhipu')
       GROUP BY provider.code
      HAVING COUNT(*) FILTER (WHERE quota.window_type='FIVE_HOUR'
               AND quota.sync_status='SUCCESS' AND quota.remaining_value>0)>0
         AND (provider.code<>'kimi' OR COUNT(*) FILTER (WHERE quota.window_type='WEEKLY'
               AND quota.sync_status='SUCCESS' AND quota.remaining_value>0)>0)
         AND COUNT(*) FILTER (WHERE quota.sync_status='SUCCESS'
               AND quota.remaining_value IS NOT NULL AND quota.remaining_value<=0)=0
    `.execute(app.db).then((result) => result.rows[0]),
  ]);
  return { events,
    successfulRequestAt: request?.request_finished_at ?? request?.attempt_finished_at ?? null,
    quotaSyncAt: quota?.last_success_at ?? null };
}

function firstEventForCurrentStatus(
  events: ResourceStatusEvent[], resource: ProviderResourceRow,
): ResourceStatusEvent | null {
  const latest = events.at(-1);
  if (!latest || latest.to_status !== resource.status) return null;
  let index = events.length - 1;
  while (index >= 0 && events[index]?.to_status === resource.status) index -= 1;
  return events[index + 1] ?? latest;
}

function projectedReason(
  resource: ProviderResourceRow, evidence: HealthEvidence,
): string | null {
  const latestEvent = evidence.events.at(-1);
  if (resource.status === RESOURCE_STATUS.DEGRADED && evidence.quotaSyncAt
    && (!evidence.successfulRequestAt || evidence.quotaSyncAt > evidence.successfulRequestAt)
    && (!latestEvent?.time_reliable
      || evidence.quotaSyncAt > latestEvent.created_at)) {
    return STATE_REASON.QUOTA_SYNC_RECOVERED;
  }
  return latestEvent?.time_reliable ? latestEvent.reason : null;
}

function projectHealthTimeline(resource: ProviderResourceRow, evidence: HealthEvidence) {
  const latestEvent = evidence.events.at(-1) ?? null;
  const firstEvent = firstEventForCurrentStatus(evidence.events, resource);
  const successEvent = [...evidence.events].reverse().find((event) =>
    event.time_reliable && (event.reason === STATE_REASON.PASSIVE_SUCCESS
      || event.reason === STATE_REASON.HALF_OPEN_PROBE_OK
      || event.reason === STATE_REASON.QUOTA_SYNC_RECOVERED
      || event.reason === STATE_REASON.BALANCE_SYNC_RECOVERED)) ?? null;
  const statusEventTimeReliable = latestEvent?.time_reliable !== false
    && firstEvent?.time_reliable !== false;
  return { latestEvent, statusEventTimeReliable,
    reason: projectedReason(resource, evidence),
    firstOccurredAt: statusEventTimeReliable ? firstEvent?.created_at.toISOString() ?? null : null,
    lastOccurredAt: statusEventTimeReliable ? latestEvent?.created_at.toISOString() ?? null : null,
    lastSuccessAt: evidence.successfulRequestAt?.toISOString()
      ?? (statusEventTimeReliable ? successEvent?.created_at.toISOString() ?? null : null) };
}

function projectHealth(resource: ProviderResourceRow, evidence: HealthEvidence) {
  const timeline = projectHealthTimeline(resource, evidence);
  const cooldownUntilIso = resource.cooldown_until?.toISOString() ?? null;
  const admission = evaluateAdmission({
    status: resource.status as typeof RESOURCE_STATUS[keyof typeof RESOURCE_STATUS],
    consecutiveFailures: resource.consecutive_failures,
    cooldownUntil: resource.cooldown_until?.getTime() ?? null,
  }, Date.now());
  return { resource_id: resource.id, resource_name: resource.name, status: resource.status,
    status_label: statusLabel(resource.status, resource.mode, timeline.reason), available: admission.admit,
    probe: admission.probe, reason_code: timeline.reason,
    reason_label: timeline.reason ? (REASON_LABEL[timeline.reason] ?? timeline.reason) : null,
    error_classification: timeline.statusEventTimeReliable
      ? timeline.latestEvent?.error_classification ?? null : null,
    consecutive_failures: resource.consecutive_failures,
    first_occurred_at: timeline.firstOccurredAt, last_occurred_at: timeline.lastOccurredAt,
    last_success_at: timeline.lastSuccessAt,
    last_quota_sync_at: evidence.quotaSyncAt?.toISOString() ?? null,
    status_event_time_reliable: timeline.statusEventTimeReliable,
    cooldown_until: cooldownUntilIso, last_probe_at: resource.last_probe_at?.toISOString() ?? null,
    credential_refresh_status: resource.credential_refresh_status,
    refresh_error_classification: resource.refresh_error_classification ?? null,
    credential_expires_at: resource.credential_expires_at?.toISOString() ?? null,
    dispatch_impact: dispatchImpact(admission.admit, admission.probe, resource.status),
    recovery_guide: recoveryGuide(resource.status, timeline.reason, cooldownUntilIso, resource.mode),
    can_recover: RECOVERABLE_STATUSES.has(resource.status),
  };
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

      return projectHealth(resource, await loadHealthEvidence(app, enterpriseId, resource.id));
    },
  );
}
