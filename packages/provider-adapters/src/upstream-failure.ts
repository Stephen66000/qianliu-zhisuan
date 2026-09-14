import type { Outcome, RequestShapeSummary, UpstreamErrorEvidence } from "@qianliu/contracts";
import { sanitizeUpstreamErrorCode, sanitizeUpstreamErrorType } from "@qianliu/contracts";

import type { HttpResponseLike } from "./openai-compatible-types.js";
import { buildUpstreamErrorEvidence } from "./upstream-error-evidence.js";

type ProviderCode = "deepseek" | "zhipu" | "kimi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function upstreamFailure(
  response: HttpResponseLike,
  providerCode: ProviderCode,
  requestShapeSummary: RequestShapeSummary | null,
): Promise<{
  code: string;
  kind: NonNullable<Outcome["upstreamErrorKind"]>;
  signal: NonNullable<Outcome["unifiedAvailabilitySignal"]>;
  retryAfterMs?: number;
  recoverAt?: string;
  evidence?: UpstreamErrorEvidence;
}> {
  let code = `upstream_http_${response.status}`;
  let classificationCode = code;
  let message = "";
  let resetValue: unknown;
  let evidence = requestShapeSummary
    ? buildUpstreamErrorEvidence(null, response.status, providerCode, requestShapeSummary)
    : undefined;
  try {
    const payload = await response.json();
    if (requestShapeSummary) {
      evidence = buildUpstreamErrorEvidence(
        payload,
        response.status,
        providerCode,
        requestShapeSummary,
      );
    }
    const root = isRecord(payload) ? payload : {};
    const error = isRecord(root.error) ? root.error : {};
    classificationCode = sanitizeUpstreamErrorCode(error.code ?? root.code)
      || stringValue(error.code) || stringValue(root.code)
      || stringValue(error.type) || stringValue(root.type) || code;
    code = sanitizeUpstreamErrorCode(error.code ?? root.code)
      ?? sanitizeUpstreamErrorType(error.type ?? root.type)
      ?? code;
    message = [
      stringValue(error.message),
      stringValue(root.message),
      stringValue(error.code),
      stringValue(error.type),
    ].filter(Boolean).join(" ");
    resetValue = error.resetTime ?? error.reset_time ?? error.next_flush_time
      ?? root.resetTime ?? root.reset_time ?? root.next_flush_time;
  } catch {
    // 非 JSON 错误仍保留 HTTP 状态语义，不读取/持久化原始正文。
  }
  // Kimi 套餐额度耗尽历史上既出现过 429，也出现过 403；必须先识别
  // 厂商语义，避免把额度耗尽误判成凭证失效。
  const kind = response.status === 429 || response.status === 402 || response.status === 403
    ? classifyRateLimit(message)
    : "UNKNOWN";
  const retry = parseRetryAfter(response.headers?.get("retry-after") ?? null);
  const recoverAt = parseRecoverAt(resetValue) ??
    (retry.retryAfterMs === undefined ? undefined : new Date(Date.now() + retry.retryAfterMs).toISOString());
  return {
    code,
    kind,
    signal: classifyAvailabilitySignal(
      providerCode,
      response.status,
      classificationCode,
      kind,
      recoverAt,
    ),
    ...(evidence ? { evidence } : {}),
    ...retry,
    ...(recoverAt === undefined ? {} : { recoverAt }),
  };
}

type AvailabilitySignal = NonNullable<Outcome["unifiedAvailabilitySignal"]>;

/** 智谱错误码 → 统一可用性信号的冻结映射（TRD 错误语义表）。 */
const ZHIPU_SIGNAL_BY_CODE: Readonly<Record<string, AvailabilitySignal>> = {
  "1211": "CONFIGURATION_ERROR",
  "1308": "QUOTA_EXHAUSTED",
  "1310": "QUOTA_EXHAUSTED",
  "1309": "PLAN_EXPIRED",
  "1311": "MODEL_UNAUTHORIZED",
  "1302": "TECHNICAL_FAILURE",
  "1305": "TECHNICAL_FAILURE",
};

const MODEL_UNAUTHORIZED_KEYWORDS = [
  "model",
  "permission",
  "unauthorized",
  "not_accessible",
  "forbidden",
  "access_denied",
] as const;

function classifyForbiddenSignal(code: string): AvailabilitySignal | null {
  const normalized = code.toLowerCase();
  return MODEL_UNAUTHORIZED_KEYWORDS.some((keyword) => normalized.includes(keyword))
    ? "MODEL_UNAUTHORIZED"
    : null;
}

function classifyRateLimitedSignal(
  kind: NonNullable<Outcome["upstreamErrorKind"]>,
  recoverAt?: string,
): AvailabilitySignal {
  if (kind === "QUOTA_EXHAUSTED" && recoverAt) return "QUOTA_EXHAUSTED";
  if (kind === "ENGINE_OVERLOADED" || kind === "CONCURRENCY_LIMITED") return "TECHNICAL_FAILURE";
  return recoverAt ? "RATE_LIMIT_RETRY_AFTER" : "TECHNICAL_FAILURE";
}

function classifyAvailabilitySignal(
  providerCode: ProviderCode,
  status: number,
  code: string,
  kind: NonNullable<Outcome["upstreamErrorKind"]>,
  recoverAt?: string,
): AvailabilitySignal {
  if (providerCode === "zhipu") {
    const mapped = ZHIPU_SIGNAL_BY_CODE[code];
    if (mapped) return mapped;
  }
  if (kind === "QUOTA_EXHAUSTED" && (status === 402 || status === 403)) {
    return "QUOTA_EXHAUSTED";
  }
  if (kind === "WINDOW_EXHAUSTED") return "RATE_LIMIT_RETRY_AFTER";
  if (status === 403) {
    const forbidden = classifyForbiddenSignal(code);
    if (forbidden) return forbidden;
  }
  if (status === 429) return classifyRateLimitedSignal(kind, recoverAt);
  if (status >= 500 || status === 0) return "TECHNICAL_FAILURE";
  if (status >= 400 && status < 500) return "CONFIGURATION_ERROR";
  return "TECHNICAL_FAILURE";
}

function parseRecoverAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof value !== "string" || value.length > 128) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") return parseRecoverAt(numeric);
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
}

function classifyRateLimit(message: string): NonNullable<Outcome["upstreamErrorKind"]> {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("engine is overloaded")
    || normalized.includes("engine overloaded")
    || normalized.includes("server overloaded")
  ) return "ENGINE_OVERLOADED";
  if (
    normalized.includes("concurrent")
    || normalized.includes("too many requests")
    || normalized.includes("frequency limit")
  ) return "CONCURRENCY_LIMITED";
  if (
    normalized.includes("5-hour")
    || normalized.includes("5 hour")
    || normalized.includes("five-hour")
    || normalized.includes("rolling window")
  ) return "WINDOW_EXHAUSTED";
  if (
    normalized.includes("monthly quota")
    || normalized.includes("quota exhausted")
    || normalized.includes("quota limit")
    || (normalized.includes("quota") && normalized.includes("exhausted"))
  ) return "QUOTA_EXHAUSTED";
  return "UNKNOWN";
}

function parseRetryAfter(value: string | null): { retryAfterMs?: number } {
  if (!value) return {};
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.ceil(seconds * 1_000) };
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return {};
  return { retryAfterMs: Math.max(0, date - Date.now()) };
}
