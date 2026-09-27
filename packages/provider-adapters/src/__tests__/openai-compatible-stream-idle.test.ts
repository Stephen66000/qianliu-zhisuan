import { describe, expect, it, vi } from "vitest";
import { Agent } from "undici";
import {
  createOpenAiCompatibleCaller,
  SecretValue,
  type AdapterRequest,
  type AdapterResource,
  type HttpResponseLike,
} from "../index.js";
import { createLayeredTimeout, deriveUndiciDispatcherOptions } from "../openai-compatible-timeout.js";

function resource(overrides: Partial<AdapterResource> = {}): AdapterResource {
  return {
    providerCode: "deepseek",
    resourceId: "res-idle-1",
    mode: "API",
    upstreamModel: "deepseek-chat",
    concurrencyLimit: 10,
    secret: new SecretValue("sk-idle-test"),
    ...overrides,
  };
}

function streamRequest(): AdapterRequest {
  return {
    requestId: "req-idle-1",
    unifiedModel: "qianliu-deepseek",
    capability: "chat",
    stream: true,
    body: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true },
    onStreamChunk: () => undefined,
  };
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

type ScriptStep = { delayMs: number; chunk: Uint8Array };

/** 首块后按脚本产出块；脚本耗尽后挂起直到 abort（不伪造流结束）。 */
function scriptedStreamResponse(
  signal: AbortSignal,
  script: ScriptStep[],
): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("stream response");
    },
    text: async () => "",
    body: (async function* chunks() {
      yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"首块\"}}]}\n\n");
      for (const step of script) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, step.delayMs);
          if (signal.aborted) {
            clearTimeout(timer);
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
        if (step.chunk.byteLength > 0) yield Buffer.from(step.chunk);
      }
      await rejectWhenAborted(signal);
    })(),
  };
}

function sse(chunk: string): Uint8Array {
  return Buffer.from(chunk);
}

describe("统一 300 秒空闲门限：上游原始块计时", () => {
  it("正式 Caller 默认空闲门限为 300000：45 秒静默不触发，300 秒触发 STREAM_IDLE_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      let abortedAt: number | null = null;
      const request = streamRequest();
      const caller = createOpenAiCompatibleCaller({
        fetch: async (_url, init) => {
          init!.signal.addEventListener("abort", () => {
            abortedAt = Date.now();
          }, { once: true });
          return scriptedStreamResponse(init!.signal, []);
        },
        env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 10 * 60_000,
      });

      const pending = caller(resource(), request, 1);
      await vi.advanceTimersByTimeAsync(45_000);
      // 未显式传 idle 配置时不再回退历史 45 秒。
      expect(abortedAt).toBeNull();

      await vi.advanceTimersByTimeAsync(255_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({
        status: 504,
        error: "upstream_timeout",
        failureLayer: "STREAM_IDLE_TIMEOUT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("零长度块不刷新空闲计时：连续零长度传输块无法续期空闲窗口", async () => {
    vi.useFakeTimers();
    try {
      const request = streamRequest();
      const caller = createOpenAiCompatibleCaller({
        fetch: async (_url, init) => {
          const signal = init!.signal;
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("stream response");
            },
            text: async () => "",
            body: (async function* chunks() {
              // 延时与 abort 竞态：中止时立即拒绝，不依赖后续假时钟推进。
              const delayOrAbort = (ms: number) => new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, ms);
                if (signal.aborted) {
                  clearTimeout(timer);
                  reject(new Error("aborted"));
                  return;
                }
                signal.addEventListener("abort", () => {
                  clearTimeout(timer);
                  reject(new Error("aborted"));
                }, { once: true });
              });
              yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"首块\"}}]}\n\n");
              // 每 10 秒一个零长度块，共 40 次 = 400 秒"传输活动"，全部不续期。
              for (let i = 0; i < 40; i++) {
                await delayOrAbort(10_000);
                yield new Uint8Array(0);
              }
              await rejectWhenAborted(signal);
            })(),
          };
        },
        env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 10 * 60_000,
      });

      const pending = caller(resource(), request, 1);
      await vi.advanceTimersByTimeAsync(300_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({ failureLayer: "STREAM_IDLE_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("非空 SSE 注释/心跳刷新空闲窗口；多次短空闲累计超 300 秒不误判", async () => {
    vi.useFakeTimers();
    try {
      const request = streamRequest();
      const script: ScriptStep[] = [
        { delayMs: 299_000, chunk: sse(": keepalive\n\n") },
        { delayMs: 299_000, chunk: sse("data: {\"choices\":[{\"delta\":{\"content\":\"恢复\"}}]}\n\n") },
        { delayMs: 299_000, chunk: sse(": keepalive\n\n") },
        // 流正常收尾：usage + [DONE]，避免无 [DONE] EOF 被判中断。
        { delayMs: 1_000, chunk: sse("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n") },
        { delayMs: 100, chunk: sse("data: [DONE]\n\n") },
      ];
      const caller = createOpenAiCompatibleCaller({
        fetch: async (_url, init) => scriptedStreamResponse(init!.signal, script),
        env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 20 * 60_000,
      });

      const pending = caller(resource(), request, 1);
      await vi.advanceTimersByTimeAsync(900_000);
      const outcome = await pending;

      // 总历时 898 秒远超 300 秒，但相邻非空块间隔均小于 300 秒。
      expect(outcome.committed).toBe(true);
      expect(outcome.status).toBe(200);
      expect(outcome.failureLayer).not.toBe("STREAM_IDLE_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetch 收到显式 Undici dispatcher，其 bodyTimeout/headersTimeout 晚于业务门限", async () => {
    vi.useFakeTimers();
    try {
      let captured: unknown;
      const caller = createOpenAiCompatibleCaller({
        fetch: async (_url, init) => {
          captured = (init as { dispatcher?: unknown }).dispatcher;
          return scriptedStreamResponse(init!.signal, []);
        },
        env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
        firstByteTimeoutMs: 120_000,
        streamIdleTimeoutMs: 300_000,
        requestTimeoutMs: 600_000,
      });

      const pending = caller(resource(), streamRequest(), 1);
      await vi.advanceTimersByTimeAsync(300_000);
      await pending;

      expect(captured).toBeInstanceOf(Agent);
      const kOptions = Object.getOwnPropertySymbols(captured)
        .find((symbol) => symbol.description === "options");
      expect(kOptions).toBeDefined();
      const dispatcherOptions = (captured as Record<symbol, unknown>)[kOptions!] as {
        bodyTimeout?: number;
        headersTimeout?: number;
      };
      expect(dispatcherOptions.bodyTimeout).toBe(300_000 + 30_000);
      expect(dispatcherOptions.headersTimeout).toBe(600_000 + 30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("分层超时 dispose 守卫", () => {
  it("dispose 后 markChunk 不再重排空闲计时器，无残留回调与重复终止", () => {
    vi.useFakeTimers();
    try {
      const timeout = createLayeredTimeout({
        requestTimeoutMs: 60_000,
        firstByteTimeoutMs: 1_000,
        streamIdleTimeoutMs: 2_000,
      });
      timeout.markChunk();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      timeout.dispose();
      expect(vi.getTimerCount()).toBe(0);

      // dispose 后继续喂块不得重新排定时器，也不得再次触发终止。
      timeout.markChunk();
      timeout.markChunk();
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(10 * 60_000);
      expect(timeout.timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Undici dispatcher 时限派生公式", () => {
  it("bodyTimeout = 空闲 + 30 秒；headersTimeout = max(首字节, 总时限) + 30 秒", () => {
    expect(deriveUndiciDispatcherOptions({
      streamIdleTimeoutMs: 300_000,
      firstByteTimeoutMs: 120_000,
      requestTimeoutMs: 600_000,
    })).toEqual({ bodyTimeout: 330_000, headersTimeout: 630_000 });

    // 首字节门限大于总时限的配置组合同样被覆盖。
    expect(deriveUndiciDispatcherOptions({
      streamIdleTimeoutMs: 300_000,
      firstByteTimeoutMs: 700_000,
      requestTimeoutMs: 600_000,
    })).toEqual({ bodyTimeout: 330_000, headersTimeout: 730_000 });
  });

  it.each(["streamIdleTimeoutMs", "firstByteTimeoutMs", "requestTimeoutMs"] as const)(
    "拒绝非法门限 %s",
    (field) => {
      expect(() => deriveUndiciDispatcherOptions({
        streamIdleTimeoutMs: 300_000,
        firstByteTimeoutMs: 30_000,
        requestTimeoutMs: 600_000,
        [field]: 0,
      })).toThrow(`${field} 必须是正整数毫秒`);
    },
  );
});
