/**
 * control-api 运行入口。测试不 import 此文件，避免触发 listen。
 *
 * F-02 整改：三个敏感 env（GATEWAY_KEY_PEPPER / CREDENTIAL_KEK / COOKIE_SECRET）
 * 在生产入口启动前显式校验——缺失即启动失败（不依赖 buildControlApi 内的 dev fallback，
 * 该 fallback 仅测试态可达；生产忘配即等于无 pepper/无加密，须在入口拦截）。
 */
import { createKysely } from "@qianliu/database";
import { buildControlApi } from "./server.js";

/** F-02：敏感环境变量缺失即启动失败（不提供 dev fallback）。 */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`启动失败：必需环境变量 ${name} 未设置（不提供 dev fallback；见 F-02 整改）`);
    process.exit(1);
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
  const db = createKysely();
  const app = buildControlApi(db, { port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "control-api listening");
}

start().catch((err) => {
  console.error("control-api 启动失败:", err);
  process.exit(1);
});
