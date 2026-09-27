import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { HttpFetch, HttpResponseLike } from "./openai-compatible-types.js";

type TimeoutFailureLayer =
  | "FIRST_BYTE_TIMEOUT"
  | "STREAM_IDLE_TIMEOUT"
  | "REQUEST_TIMEOUT";

export interface LayeredTimeout {
  signal: AbortSignal;
  firstByteAt?: number;
  /** 最近一次收到上游原始数据块的时间，超时排障用于推算空闲起点（POOL-034）。 */
  lastChunkAt?: number;
  timedOut: boolean;
  markFirstByte(): void;
  markChunk(): void;
  failure(cancelled: boolean): {
    status: number;
    code: "client_cancelled" | "upstream_timeout" | "transport_error";
    layer: "CLIENT" | "UPSTREAM_NETWORK" | TimeoutFailureLayer;
  };
  dispose(): void;
}

export function createLayeredTimeout(input: {
  requestAbort?: AbortSignal;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
}): LayeredTimeout {
  const controller = new AbortController();
  const signal = input.requestAbort
    ? AbortSignal.any([input.requestAbort, controller.signal])
    : controller.signal;
  let firstByteAt: number | undefined;
  let lastChunkAt: number | undefined;
  let timeoutLayer: TimeoutFailureLayer | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const abortFor = (layer: TimeoutFailureLayer) => {
    if (signal.aborted) return;
    timeoutLayer = layer;
    controller.abort(new DOMException(layer, "TimeoutError"));
  };
  const firstByteTimer = setTimeout(
    () => abortFor("FIRST_BYTE_TIMEOUT"),
    input.firstByteTimeoutMs,
  );
  const requestTimer = setTimeout(
    () => abortFor("REQUEST_TIMEOUT"),
    input.requestTimeoutMs,
  );
  const resetIdle = () => {
    if (disposed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortFor("STREAM_IDLE_TIMEOUT"),
      input.streamIdleTimeoutMs,
    );
  };
  const markFirstByte = () => {
    if (firstByteAt !== undefined) return;
    firstByteAt = Date.now();
    clearTimeout(firstByteTimer);
  };

  return {
    signal,
    get firstByteAt() {
      return firstByteAt;
    },
    get lastChunkAt() {
      return lastChunkAt;
    },
    get timedOut() {
      return timeoutLayer !== null;
    },
    markFirstByte,
    markChunk() {
      if (disposed) return;
      markFirstByte();
      lastChunkAt = Date.now();
      resetIdle();
    },
    failure(cancelled) {
      if (cancelled) {
        return { status: 0, code: "client_cancelled", layer: "CLIENT" };
      }
      if (timeoutLayer) {
        return { status: 504, code: "upstream_timeout", layer: timeoutLayer };
      }
      return { status: 0, code: "transport_error", layer: "UPSTREAM_NETWORK" };
    },
    dispose() {
      disposed = true;
      clearTimeout(firstByteTimer);
      clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    },
  };
}

/**
 * Undici dispatcher 时限安全余量：底层时限必须晚于业务层对应计时器，
 * 避免与 300 秒空闲门限设为相同值竞争终止。
 */
export const UNDICI_TIMEOUT_MARGIN_MS = 30_000;

/**
 * 按派生时限构造显式 Undici dispatcher（生产上游 Caller 兜底时限）。
 */
export function createUpstreamDispatcher(input: {
  streamIdleTimeoutMs: number;
  firstByteTimeoutMs: number;
  requestTimeoutMs: number;
}): Dispatcher {
  return new Agent(deriveUndiciDispatcherOptions(input));
}

/**
 * 派生生产 Caller 的显式 Undici dispatcher 时限（与业务分层超时同源）。
 *
 * - `bodyTimeout = streamIdleTimeoutMs + 30_000`：业务 `STREAM_IDLE_TIMEOUT`
 *   AbortSignal 先于底层 body timeout 触发。
 * - `headersTimeout = max(firstByteTimeoutMs, requestTimeoutMs) + 30_000`：
 *   业务 `FIRST_BYTE_TIMEOUT` 与 600 秒 `REQUEST_TIMEOUT` 均先于底层触发。
 *
 * 派生值与单测断言共用本函数，公式、校验和测试保持一致。
 */
export function deriveUndiciDispatcherOptions(input: {
  streamIdleTimeoutMs: number;
  firstByteTimeoutMs: number;
  requestTimeoutMs: number;
}): { bodyTimeout: number; headersTimeout: number } {
  for (const [name, value] of [
    ["streamIdleTimeoutMs", input.streamIdleTimeoutMs],
    ["firstByteTimeoutMs", input.firstByteTimeoutMs],
    ["requestTimeoutMs", input.requestTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} 必须是正整数毫秒`);
    }
  }
  // 先计算派生值，再统一校验：加余量可能突破 Number.MAX_SAFE_INTEGER，
  // 派生失败与输入非法必须用不同错误信息区分。
  const bodyTimeout = input.streamIdleTimeoutMs + UNDICI_TIMEOUT_MARGIN_MS;
  const headersTimeout =
    Math.max(input.firstByteTimeoutMs, input.requestTimeoutMs)
    + UNDICI_TIMEOUT_MARGIN_MS;
  if (!Number.isSafeInteger(bodyTimeout) || bodyTimeout <= 0) {
    throw new Error(
      `bodyTimeout 派生失败：streamIdleTimeoutMs(${input.streamIdleTimeoutMs}) + ${UNDICI_TIMEOUT_MARGIN_MS} 不是正安全整数`,
    );
  }
  if (!Number.isSafeInteger(headersTimeout) || headersTimeout <= 0) {
    throw new Error(
      `headersTimeout 派生失败：max(firstByteTimeoutMs(${input.firstByteTimeoutMs}), requestTimeoutMs(${input.requestTimeoutMs})) + ${UNDICI_TIMEOUT_MARGIN_MS} 不是正安全整数`,
    );
  }
  return { bodyTimeout, headersTimeout };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

export const defaultFetch: HttpFetch = async (url, init) => {
  // Node 22 的 globalThis.fetch 即 undici fetch；优先走全局实现，
  // 使集成测试可通过标准 fetch mock 注入，行为与生产一致。
  const impl = globalThis.fetch ?? undiciFetch;
  const response = await impl(url, init as RequestInit);
  return response as unknown as HttpResponseLike;
};
