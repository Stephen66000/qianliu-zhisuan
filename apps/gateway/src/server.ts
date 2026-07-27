/**
 * @qianliu/gateway —— 北向 Gateway 数据平面。
 *
 * W01 仅提供 health 路由骨架，证明 Fastify + TS workspace 可启动。
 * 北向 /v1/* 路由（models/chat/messages）在 W05-W08（M2）落地。
 * 鉴权、能力校验、Attempt、usage、ledger 在 M2 实现。
 */
import Fastify, { type FastifyInstance } from "fastify";
import { CONTRACTS_VERSION } from "@qianliu/contracts";

export interface GatewayOptions {
  port?: number;
  host?: string;
}

export function buildGateway(_opts: GatewayOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "gateway",
    contractsVersion: CONTRACTS_VERSION,
  }));

  return app;
}

async function start(): Promise<void> {
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const app = buildGateway({ port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "gateway listening (W01 baseline)");
}

// 入口文件直接启动。tsx watch / node 直接运行本文件时都会执行 start()。
// 测试通过 buildGateway() 导入构建实例，不会触发此处的 start()。
start().catch((err) => {
  console.error("gateway 启动失败:", err);
  process.exit(1);
});
