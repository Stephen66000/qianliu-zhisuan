import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { Outcome } from "@qianliu/contracts";
import type {
  AvailabilityEvent,
  Database,
  QuotaGateRepository,
} from "@qianliu/database";
import {
  availabilitySignalSummary,
  type DispatchPolicy,
} from "@qianliu/domain";

/** 当前冻结策略使用 Asia/Shanghai；其他时区保持未知，避免伪造精确恢复时间。 */
export function dispatchResetAt(policy: DispatchPolicy | null, requestStartedAt: number): string | null {
  if (!policy?.matchStartTime || !policy.matchEndTime || policy.matchTimezone !== "Asia/Shanghai") {
    return null;
  }
  const shifted = new Date(requestStartedAt + 8 * 60 * 60 * 1_000);
  const [hour = "0", minute = "0", second = "0"] = policy.matchEndTime.split(":");
  const endSeconds = Number(hour) * 3600 + Number(minute) * 60 + Number(second);
  const nowSeconds = shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds();
  const startSeconds = Number(policy.matchStartTime.slice(0, 2)) * 3600
    + Number(policy.matchStartTime.slice(3, 5)) * 60
    + Number(policy.matchStartTime.slice(6, 8) || 0);
  const resetLocal = new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
    Number(hour), Number(minute), Number(second),
  ));
  if (startSeconds >= endSeconds && nowSeconds >= startSeconds) {
    resetLocal.setUTCDate(resetLocal.getUTCDate() + 1);
  }
  return new Date(resetLocal.getTime() - 8 * 60 * 60 * 1_000).toISOString();
}

export async function latestProviderQuotaResetAt(
  db: Kysely<Database>,
  enterpriseId: string,
  providerResourceId: string,
  now: Date,
  windowType?: "FIVE_HOUR" | "WEEKLY",
): Promise<string | null> {
  let query = db.selectFrom("provider_quota_window")
    .select("reset_at")
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", providerResourceId)
    .where("is_current", "=", true)
    .where("sync_status", "=", "SUCCESS")
    .where("reset_at", ">", now)
    .orderBy("reset_at", "asc");
  if (windowType) query = query.where("window_type", "=", windowType);
  const row = await query.executeTakeFirst();
  return row?.reset_at?.toISOString() ?? null;
}

export async function acquireConcurrencyLeaseWithWait(input: {
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

async function boundedDelay(delayMs: number, cancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (!cancelled()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 25)));
  }
}

/** 由 Outcome 反推错误分类（Stub 的 error_code → TRD §9 分类）。 */
export function mapToClassification(
  outcome: Pick<Outcome, "status" | "error" | "committed" | "upstreamErrorKind"> & {
    unifiedAvailabilitySignal?: string | null;
    upstreamCode?: string | null;
  },
): string | null {
  if (!outcome.error) return null;
  if (outcome.committed) return "STREAM_INTERRUPTED_AFTER_COMMIT";
  if (outcome.upstreamErrorKind === "WINDOW_EXHAUSTED") return "UPSTREAM_RATE_LIMITED";
  if (outcome.upstreamErrorKind === "QUOTA_EXHAUSTED") return "UPSTREAM_BILLING_BLOCKED";
  if (outcome.status === 401) return "UPSTREAM_CREDENTIAL_INVALID";
  if (outcome.status === 403) {
    if (
      outcome.unifiedAvailabilitySignal === "MODEL_UNAUTHORIZED" ||
      outcome.error?.includes("model") ||
      outcome.upstreamCode?.includes("model") ||
      outcome.upstreamCode?.includes("permission")
    ) {
      return "CLIENT_INVALID";
    }
    return "UPSTREAM_CREDENTIAL_INVALID";
  }
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

export function sendRuntimeBlock(
  reply: FastifyReply,
  capability: "chat" | "messages" | "responses",
  traceId: string,
  requestId: string,
  event: AvailabilityEvent,
) {
  const rateLimited = event.unified_signal === "RATE_LIMIT_RETRY_AFTER";
  const statusCode = rateLimited ? 429 : 503;
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
    return reply.code(statusCode).header("x-request-id", traceId).send({
      type: "error",
      error: { type: rateLimited ? "rate_limit_error" : "api_error", ...common },
      request_id: requestId,
    });
  }
  return reply.code(statusCode).header("x-request-id", traceId).send({
    error: { ...common, type: rateLimited ? "rate_limit_error" : "server_error", param: null, request_id: requestId },
  });
}

export async function runBestEffort<T>(
  log: FastifyBaseLogger,
  action: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    log.error({ err: error, action }, "post-settlement side effect failed");
    return undefined;
  }
}

export function providerDisplayName(code: string | null): string {
  if (code === "kimi") return "Kimi ";
  if (code === "zhipu") return "智谱 ";
  if (code === "deepseek") return "DeepSeek ";
  return "该";
}

export function dispatchPolicyWindow(policy: DispatchPolicy | null): string | null {
  if (!policy?.matchStartTime || !policy.matchEndTime) return null;
  const days = policy.matchDaysOfWeek;
  const dayLabel = days?.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))
    ? "工作日"
    : !days || days.length === 0 || days.length === 7
      ? "每日"
      : days.map((day) => `周${"一二三四五六日"[day - 1] ?? day}`).join("、");
  return `${dayLabel} ${policy.matchStartTime.slice(0, 5)}-${policy.matchEndTime.slice(0, 5)} ${policy.matchTimezone ?? "企业时区"}`;
}

function dispatchUnavailableWindow(policy: DispatchPolicy | null): {
  timezone: string;
  days_of_week: readonly number[] | null;
  start_time: string;
  end_time: string;
} | undefined {
  if (
    policy?.action !== "REJECT"
    || policy.matchTimezone === null
    || policy.matchStartTime === null
    || policy.matchEndTime === null
  ) return undefined;
  return {
    timezone: policy.matchTimezone,
    days_of_week: policy.matchDaysOfWeek,
    start_time: policy.matchStartTime,
    end_time: policy.matchEndTime,
  };
}

export async function sendDispatchTermination(
  reply: FastifyReply,
  capability: "chat" | "messages" | "responses",
  traceId: string,
  requestId: string,
  input: {
    finalAction: "REJECT" | "RATE_LIMIT";
    reasonCode: string;
    matchedPolicy: DispatchPolicy | null;
    requestStartedAt: number;
    updateStatus: (errorCode: string) => Promise<unknown>;
  },
) {
  const code = input.finalAction === "REJECT" ? 403 : 429;
  const errorCode = input.finalAction === "REJECT" ? "dispatch_rejected" : "dispatch_rate_limited";
  const policyWindow = dispatchPolicyWindow(input.matchedPolicy);
  const resetAt = dispatchResetAt(input.matchedPolicy, input.requestStartedAt);
  const unavailableWindow = dispatchUnavailableWindow(input.matchedPolicy);
  const message = input.finalAction === "REJECT"
    ? `高峰时段暂停使用${policyWindow ? `；策略时段 ${policyWindow}` : ""}${resetAt ? `；${resetAt} 后恢复` : ""}`
    : "经营调度限流";
  await input.updateStatus(errorCode);
  const error = {
    message,
    type: capability === "messages" ? "api_error" : "server_error",
    code: errorCode,
    param: null,
    retryable: false,
    request_id: requestId,
    policy_window: policyWindow,
    reset_at: resetAt,
    attempt_count: 0,
    usage_created: false,
    charged: false,
    dispatch: {
      final_action: input.finalAction,
      reason_code: input.reasonCode,
      policy_version: input.matchedPolicy?.policyVersion ?? null,
      ...(unavailableWindow ? { unavailable_window: unavailableWindow } : {}),
    },
  };
  if (capability === "messages") {
    return reply.code(code).header("x-request-id", traceId).send({
      type: "error", error, request_id: requestId,
    });
  }
  return reply.code(code).header("x-request-id", traceId).send({ error });
}

export function estimateRawTokens(body: { messages?: unknown[] }): bigint {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let inputChars = 0;
  for (const message of messages) {
    try {
      inputChars += JSON.stringify(message).length;
    } catch {
      inputChars += 32;
    }
  }
  const inputEstimate = Math.ceil(inputChars / 4);
  const outputReserve = 256;
  return BigInt(inputEstimate + outputReserve);
}
