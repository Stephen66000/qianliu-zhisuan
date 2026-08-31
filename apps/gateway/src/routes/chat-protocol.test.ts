import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";

import { createChatStreamWriter } from "./chat-protocol.js";

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
    writes,
  };
}

describe("OpenAI-compatible 推理字段北向透传", () => {
  it("真实流式 chunk 保留三种厂商推理字段", async () => {
    const fx = replyFixture();
    const writer = createChatStreamWriter(fx.reply, {
      requestId: "request-reasoning-stream",
      traceId: "trace-reasoning-stream",
      createdAt: 1,
      model: "ql-deepseek-v4-flash",
    });

    await writer.writeChunk({
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "reasoning-content",
            reasoning_details: [{ type: "reasoning.summary", text: "summary" }],
            reasoning: { trace: "native" },
          },
          finish_reason: null,
        },
      ],
    });
    writer.complete({
      status: 200,
      committed: true,
      usage: { input: 1, output: 1, cache: 0, quality: "PROVIDER_REPORTED" },
    });

    const output = fx.writes.join("");
    expect(output).toContain('"reasoning_content":"reasoning-content"');
    expect(output).toContain('"reasoning_details":[{"type":"reasoning.summary","text":"summary"}]');
    expect(output).toContain('"reasoning":{"trace":"native"}');
  });

  it("Caller 无逐块回调时仍将非流式推理字段写入 SSE", () => {
    const fx = replyFixture();
    const writer = createChatStreamWriter(fx.reply, {
      requestId: "request-reasoning-fallback",
      traceId: "trace-reasoning-fallback",
      createdAt: 1,
      model: "ql-k3",
    });

    writer.complete({
      status: 200,
      committed: true,
      usage: { input: 1, output: 1, cache: 0, quality: "PROVIDER_REPORTED" },
      responseReasoningExtensions: {
        reasoning_content: "fallback-content",
        reasoning_details: [{ type: "reasoning.summary", text: "fallback" }],
        reasoning: { trace: "fallback" },
      },
    });

    const output = fx.writes.join("");
    expect(output).toContain('"reasoning_content":"fallback-content"');
    expect(output).toContain('"reasoning_details":[{"type":"reasoning.summary","text":"fallback"}]');
    expect(output).toContain('"reasoning":{"trace":"fallback"}');
  });
});
