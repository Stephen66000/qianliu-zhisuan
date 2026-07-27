/**
 * @qianliu/control-api —— 控制平面与管理 API。
 *
 * W01 仅提供 health 路由骨架。
 * 登录、资源、主体、额度、查询、操作日志在 W02-W04（M1）落地。
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

export interface ControlApiOptions {
  port?: number;
  host?: string;
}

export function buildControlApi(_opts: ControlApiOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  // W01 默认允许本机开发；试点收紧 CORS（TRD §14.2 行 783）
  void app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? true,
    credentials: true,
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "control-api",
  }));

  return app;
}

async function start(): Promise<void> {
  const port = Number(process.env.CONTROL_API_PORT ?? 8788);
  const host = process.env.CONTROL_API_HOST ?? "127.0.0.1";
  const app = buildControlApi({ port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "control-api listening (W01 baseline)");
}

// 入口文件直接启动。tsx watch / node 直接运行本文件时都会执行 start()。
start().catch((err) => {
  console.error("control-api 启动失败:", err);
  process.exit(1);
});
