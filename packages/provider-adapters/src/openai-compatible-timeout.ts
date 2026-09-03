import { fetch as undiciFetch } from "undici";
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
      clearTimeout(firstByteTimer);
      clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

export const defaultFetch: HttpFetch = async (url, init) => {
  const response = await undiciFetch(url, init);
  return response as unknown as HttpResponseLike;
};
