import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";

import { createMessagesStreamWriter } from "./messages-protocol.js";

function replyFixture() {
  const writes: string[] = [];
  const raw = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((value: string) => {
      writes.push(value);
      return true;
    }),
    end: vi.fn(() => {
      raw.writableEnded = true;
    }),
  };
  return {
    reply: { raw, hijack: vi.fn() } as unknown as FastifyReply,
    raw,
    writes,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("POOL20-050 Claude Messages 流式保活", () => {
  it("正文已提交但 Kimi 最终 Usage 尚未到达时发送 ping，完成后停止并发送 message_stop", async () => {
    vi.useFakeTimers();
    const fx = replyFixture();
    const writer = createMessagesStreamWriter(fx.reply, {
      requestId: "request-pool20-050",
      traceId: "trace-pool20-050",
      model: "ql-k3",
    });

    await writer.writeChunk({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] });
    expect(fx.writes.join("")).toContain('"text":"OK"');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fx.writes.filter((value) => value.includes("event: ping"))).toHaveLength(2);

    writer.complete({
      status: 200,
      committed: true,
      usage: { input: 12, output: 1, cache: 0, quality: "PROVIDER_REPORTED" },
    });
    const completed = fx.writes.join("");
    expect(completed).toContain("event: message_delta");
    expect(completed).toContain("event: message_stop");
    expect(fx.raw.end).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fx.writes.filter((value) => value.includes("event: ping"))).toHaveLength(2);
  });

  it("连接已销毁时停止保活，不继续写入", async () => {
    vi.useFakeTimers();
    const fx = replyFixture();
    const writer = createMessagesStreamWriter(fx.reply, {
      requestId: "request-client-close",
      traceId: "trace-client-close",
      model: "ql-k3",
    });

    await writer.writeChunk({ choices: [{ delta: { content: "OK" } }] });
    fx.raw.destroyed = true;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fx.writes.some((value) => value.includes("event: ping"))).toBe(false);
  });

  it("首个正文前失败时写出错误并清理刚启动的保活", async () => {
    vi.useFakeTimers();
    const fx = replyFixture();
    const writer = createMessagesStreamWriter(fx.reply, {
      requestId: "request-early-failure",
      traceId: "trace-early-failure",
      model: "ql-k3",
    });

    writer.fail({ code: "upstream_error", message: "上游失败", requestId: "request-early-failure" });
    expect(fx.writes.join("")).toContain("event: error");
    expect(fx.raw.end).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fx.writes.some((value) => value.includes("event: ping"))).toBe(false);
  });
});
