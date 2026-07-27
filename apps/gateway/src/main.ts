/**
 * gateway 运行入口。测试不 import 此文件。
 */
import { createKysely } from "@qianliu/database";
import { buildGateway } from "./server.js";
import { stubPipeline } from "./pipeline/stub-pipeline.js";

async function start(): Promise<void> {
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const db = createKysely();
  const pepper = process.env.GATEWAY_KEY_PEPPER ?? "dev-only-pepper";
  const app = buildGateway(db, pepper, stubPipeline, { port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "gateway listening (W05 stub pipeline)");
}

start().catch((err) => {
  console.error("gateway 启动失败:", err);
  process.exit(1);
});
