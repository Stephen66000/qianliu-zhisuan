/**
 * control-api 运行入口。测试不 import 此文件，避免触发 listen。
 */
import { createKysely } from "@qianliu/database";
import { buildControlApi } from "./server.js";

async function start(): Promise<void> {
  const port = Number(process.env.CONTROL_API_PORT ?? 8788);
  const host = process.env.CONTROL_API_HOST ?? "127.0.0.1";
  const db = createKysely();
  const app = buildControlApi(db, { port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "control-api listening");
}

start().catch((err) => {
  console.error("control-api 启动失败:", err);
  process.exit(1);
});
