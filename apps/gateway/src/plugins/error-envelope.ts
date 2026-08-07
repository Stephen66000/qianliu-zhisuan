/**
 * error-envelope —— 统一 OpenAI 兼容错误响应（W05）。
 *
 * 依据：TRD §6.1 行 396「统一错误响应」、§6.3 行 426-427、WT-14（422 + capability_not_supported）。
 * GatewayError 携带分类、稳定错误码、HTTP 状态码、是否可重试、request_id。
 */
import type { FastifyReply } from "fastify";
import type { ErrorEnvelope, ErrorType } from "@qianliu/contracts";
import type { ErrorClassification } from "@qianliu/domain";

/** Gateway 内部错误对象。 */
export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly classification: ErrorClassification,
    public readonly retryable: boolean,
    public readonly requestId?: string,
    public readonly type: ErrorType = "server_error",
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** 分类 → HTTP 状态码 + type 映射。 */
function classifyToHttp(classification: ErrorClassification): {
  status: number;
  type: ErrorType;
  retryable: boolean;
} {
  switch (classification) {
    case "CLIENT_INVALID":
      return { status: 400, type: "invalid_request_error", retryable: false };
    case "CAPABILITY_UNSUPPORTED":
      return { status: 422, type: "capability_not_supported", retryable: false };
    case "PAYLOAD_TOO_LARGE":
      return { status: 413, type: "invalid_request_error", retryable: false };
    case "DOWNSTREAM_AUTH_OR_QUOTA":
      return { status: 401, type: "authentication_error", retryable: false };
    case "UPSTREAM_CREDENTIAL_INVALID":
      return { status: 502, type: "server_error", retryable: true };
    case "UPSTREAM_RATE_LIMITED":
      return { status: 429, type: "rate_limit_error", retryable: true };
    case "UPSTREAM_TEMPORARY":
    case "TRANSPORT_ERROR":
      return { status: 502, type: "server_error", retryable: true };
    case "UPSTREAM_BILLING_BLOCKED":
      return { status: 502, type: "server_error", retryable: false };
    case "STREAM_INTERRUPTED_AFTER_COMMIT":
      return { status: 500, type: "server_error", retryable: false };
    case "LEDGER_FAILURE":
      return { status: 500, type: "server_error", retryable: false };
    default:
      return { status: 500, type: "server_error", retryable: false };
  }
}

/** 发送 OpenAI 兼容错误 envelope。 */
export function sendErrorEnvelope(
  reply: FastifyReply,
  error: GatewayError,
): void {
  const env: ErrorEnvelope = {
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
      param: null,
      retryable: error.retryable,
      request_id: error.requestId,
    },
  };
  reply.code(error.status).header("x-request-id", error.requestId ?? "").send(env);
}

/** 从分类构造 GatewayError（便捷工厂）。 */
export function fromClassification(
  classification: ErrorClassification,
  code: string,
  message: string,
  requestId?: string,
): GatewayError {
  const { status, type, retryable } = classifyToHttp(classification);
  return new GatewayError(status, code, message, classification, retryable, requestId, type);
}
