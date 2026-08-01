export interface GracefulShutdownOptions {
  serviceName: string;
  close: () => Promise<void>;
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  log?: (message: string, error?: unknown) => void;
  forceExit?: (code: number) => void;
}

export interface GracefulShutdownController {
  shutdown(signal: NodeJS.Signals): Promise<void>;
  uninstall(): void;
}

/** 注册一次性信号处理器；先停止接流量，再关闭数据库等资源。 */
export function installGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdownController {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  const log = options.log ?? console.error;
  const forceExit = options.forceExit ?? process.exit;
  let shutdownPromise: Promise<void> | undefined;

  const handlers = new Map<NodeJS.Signals, () => void>();
  const uninstall = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    uninstall();
    shutdownPromise = (async () => {
      log(`${options.serviceName} 收到 ${signal}，开始优雅停机`);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          options.close(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`停机超过 ${timeoutMs}ms`)), timeoutMs);
            timer.unref();
          }),
        ]);
        log(`${options.serviceName} 已安全停止`);
      } catch (error) {
        log(`${options.serviceName} 优雅停机失败`, error);
        forceExit(1);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return shutdownPromise;
  };

  for (const signal of signals) {
    const handler = (): void => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return { shutdown, uninstall };
}
