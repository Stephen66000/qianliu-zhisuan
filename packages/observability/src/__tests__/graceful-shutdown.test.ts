import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../graceful-shutdown.js";

describe("installGracefulShutdown", () => {
  it("重复信号只关闭一次", async () => {
    const close = vi.fn(async () => undefined);
    const controller = installGracefulShutdown({
      serviceName: "test",
      close,
      signals: [],
      log: () => undefined,
    });
    await Promise.all([controller.shutdown("SIGTERM"), controller.shutdown("SIGINT")]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("关闭失败时请求非零退出", async () => {
    const forceExit = vi.fn();
    const controller = installGracefulShutdown({
      serviceName: "test",
      close: async () => Promise.reject(new Error("close failed")),
      signals: [],
      log: () => undefined,
      forceExit,
    });
    await controller.shutdown("SIGTERM");
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it("真实信号处理器触发关闭，并可卸载", async () => {
    const close = vi.fn(async () => undefined);
    const before = process.listenerCount("SIGUSR2");
    const controller = installGracefulShutdown({
      serviceName: "test",
      close,
      signals: ["SIGUSR2"],
      log: () => undefined,
    });
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    process.emit("SIGUSR2");
    await controller.shutdown("SIGUSR2");
    expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGUSR2")).toBe(before);
  });

  it("关闭超时后请求非零退出", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const controller = installGracefulShutdown({
      serviceName: "test",
      close: () => new Promise(() => undefined),
      timeoutMs: 10,
      signals: [],
      log: () => undefined,
      forceExit,
    });
    const stopping = controller.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(forceExit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
