import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer, waitForAbortableInterval, type SchedulerHealth } from "./scheduler.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waitForAbortableInterval", () => {
  it("信号已终止时立即返回", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAbortableInterval(controller.signal, 30_000)).resolves.toBeUndefined();
  });

  it("定时结束后移除 abort 监听器，避免常驻调度器累积监听器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    for (let index = 0; index < 12; index += 1) {
      const waiting = waitForAbortableInterval(controller.signal, 30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await waiting;
    }

    expect(add).toHaveBeenCalledTimes(12);
    expect(remove).toHaveBeenCalledTimes(12);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("收到 abort 后立即清理定时器和监听器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let resolved = false;
    const waiting = waitForAbortableInterval(controller.signal, 30_000);
    void waiting.then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);

    controller.abort();
    await waiting;

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("startHealthServer", () => {
  it("按运行状态返回健康结果，并为未知路径返回 404", async () => {
    const health: SchedulerHealth = {
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      running: true,
    };
    const server = startHealthServer(0, health);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试健康服务未监听 TCP");
    try {
      const healthy = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toMatchObject({ status: "ok", running: true });

      health.lastErrorAt = new Date().toISOString();
      const degraded = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(degraded.status).toBe(503);
      expect(await degraded.json()).toMatchObject({ status: "degraded" });

      expect((await fetch(`http://127.0.0.1:${address.port}/missing`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
