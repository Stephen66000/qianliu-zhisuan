/**
 * control-api 运行入口。测试不 import 此文件，避免触发 listen。
 *
 * F-02 整改：三个敏感 env（GATEWAY_KEY_PEPPER / CREDENTIAL_KEK / COOKIE_SECRET）
 * 在生产入口启动前显式校验——缺失即启动失败（不依赖 buildControlApi 内的 dev fallback，
 * 该 fallback 仅测试态可达；生产忘配即等于无 pepper/无加密，须在入口拦截）。
 */
import { createKysely } from "@qianliu/database";
import { installGracefulShutdown } from "@qianliu/observability";
import { buildControlApi } from "./server.js";

/** F-02：敏感环境变量缺失即启动失败（不提供 dev fallback）。 */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`必需环境变量 ${name} 未设置（不提供 dev fallback；见 F-02 整改）`);
  }
  return val;
}

async function start(): Promise<void> {
  const port = Number(process.env.CONTROL_API_PORT ?? 8788);
  const host = process.env.CONTROL_API_HOST ?? "127.0.0.1";
  // F-02：生产入口校验敏感 env（buildControlApi 内的 fallback 仅测试态可达）
  requireEnv("GATEWAY_KEY_PEPPER");
  requireEnv("CREDENTIAL_KEK");
  requireEnv("COOKIE_SECRET");
  if (process.env.NODE_ENV === "production") requireEnv("WEB_ORIGIN");
  const db = createKysely();
  const app = buildControlApi(db, { port, host });
  const shutdown = installGracefulShutdown({
    serviceName: "control-api",
    close: async () => {
      await app.close();
      await db.destroy();
    },
    log: (message, error) => app.log.info({ error }, message),
  });
  try {
    await app.listen({ port, host });
  } catch (error) {
    shutdown.uninstall();
    await app.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    throw error;
  }
  app.log.info({ port, host }, "control-api listening");
}

start().catch((err) => {
  console.error("control-api 启动失败:", err);
  process.exitCode = 1;
});
