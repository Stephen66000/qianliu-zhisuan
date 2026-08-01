import { createServer, type Server } from "node:http";
import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";

export interface SchedulerHealth {
  startedAt: string;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  running: boolean;
}

export async function withRuntimeSchedulerLock<T>(db: Kysely<Database>, task: () => Promise<T>): Promise<T | null> {
  return db.connection().execute(async (connection) => {
    const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_lock(hashtext('qianliu_runtime_assurance')) as acquired`
      .execute(connection);
    if (!lock.rows[0]?.acquired) return null;
    try {
      return await task();
    } finally {
      await sql`select pg_advisory_unlock(hashtext('qianliu_runtime_assurance'))`.execute(connection);
    }
  });
}

export function startHealthServer(port: number, health: SchedulerHealth): Server {
  return createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const healthy = health.running && (!health.lastErrorAt || (health.lastSuccessAt ?? "") > health.lastErrorAt);
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: healthy ? "ok" : "degraded", ...health }));
  }).listen(port, "127.0.0.1");
}

export async function runSchedulerLoop(input: {
  db: Kysely<Database>;
  tick: () => Promise<unknown>;
  intervalMs: number;
  signal: AbortSignal;
  health: SchedulerHealth;
}): Promise<void> {
  input.health.running = true;
  while (!input.signal.aborted) {
    input.health.lastTickAt = new Date().toISOString();
    try {
      const result = await withRuntimeSchedulerLock(input.db, input.tick);
      if (result !== null) input.health.lastSuccessAt = new Date().toISOString();
    } catch {
      input.health.lastErrorAt = new Date().toISOString();
    }
    if (input.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, input.intervalMs);
      input.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  input.health.running = false;
}
