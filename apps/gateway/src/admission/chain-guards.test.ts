import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

import { chainGuards } from "./enterprise-maintenance.js";

/**
 * 回归（I1 复审 P2-5）：`chainGuards` 曾探测底层 `reply.raw.writableEnded`，
 * 在 reply 已序列化但 socket 未 flush 的窗口内可能仍为 false，导致第二个
 * 守卫重复应答。修复后使用 Fastify 5 公开语义 `reply.sent`。
 */
function fakeReply({ sent }: { sent: boolean }): FastifyReply {
  return { sent, code: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as FastifyReply;
}

function fakeRequest(): FastifyRequest {
  return {} as unknown as FastifyRequest;
}

describe("chainGuards（P2-5 回归）", () => {
  it("第一个守卫已应答（reply.sent=true）时不再执行第二个守卫", async () => {
    const first = vi.fn().mockImplementation(async (_req, reply) => {
      reply.code(503).send({});
    });
    const second = vi.fn();
    const guard = chainGuards(first, second);
    const reply = fakeReply({ sent: true });
    await guard(fakeRequest(), reply);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("第一个守卫未应答（reply.sent=false）时继续执行第二个守卫", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const guard = chainGuards(first, second);
    const reply = fakeReply({ sent: false });
    await guard(fakeRequest(), reply);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("不依赖底层 reply.raw.writableEnded 探测", async () => {
    // raw 为 undefined 时（测试替身未提供底层流）修复后的实现依然工作，
    // 证明判断走的是 reply.sent 而非 reply.raw.writableEnded。
    const first = vi.fn().mockImplementation(async (_req, reply) => {
      reply.code(503).send({});
    });
    const second = vi.fn();
    const guard = chainGuards(first, second);
    const reply = fakeReply({ sent: true }) as FastifyReply & { raw?: undefined };
    delete (reply as { raw?: unknown }).raw;
    await guard(fakeRequest(), reply);
    expect(second).not.toHaveBeenCalled();
  });
});
