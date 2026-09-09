import { sql, type Kysely } from "kysely";
import { createClient } from "redis";
import type { Database } from "@qianliu/database";
import type { createTaskObserver } from "./observed-task.js";

async function redisPing(url: string): Promise<void> {
  const client = createClient({
    url,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  client.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        if ((await client.ping()) !== "PONG")
          throw new Error("REDIS_HEALTH_FAILED");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("REDIS_HEALTH_TIMEOUT")),
          2500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}

/** Internal Compose services only, read-only probes; no external monitoring account needed. */
export async function runInfrastructureChecks(input: {
  db: Kysely<Database>;
  observe: ReturnType<typeof createTaskObserver>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  pingRedis?: () => Promise<void>;
}): Promise<void> {
  const env = input.env ?? process.env;
  if (env.NODE_ENV !== "production") return;
  const get = input.fetch ?? fetch;
  const probes: Array<[string, string, () => Promise<unknown>]> = [
    [
      "health:gateway",
      "Gateway 服务健康检查",
      async () => {
        const response = await get("http://gateway:8787/health", {
          signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("GATEWAY_HEALTH_FAILED");
      },
    ],
    [
      "health:control-api",
      "管理 API 服务健康检查",
      async () => {
        const response = await get("http://control-api:8788/health", {
          signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("CONTROL_API_HEALTH_FAILED");
      },
    ],
    [
      "health:redis",
      "Redis 服务健康检查",
      input.pingRedis ??
        (() => redisPing(env.REDIS_URL ?? "redis://redis:6379")),
    ],
    [
      "health:database",
      "数据库服务健康检查",
      () => sql`SELECT 1`.execute(input.db),
    ],
  ];
  for (const [task, title, probe] of probes) {
    try {
      await input.observe(task, title, probe);
    } catch {
      console.error(
        JSON.stringify({ event: "infrastructure_health_failed", task }),
      );
    }
  }
}
