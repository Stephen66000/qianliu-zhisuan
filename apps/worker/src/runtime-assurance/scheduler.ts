import { createServer, type Server } from "node:http";
import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";

export interface SchedulerHealth {
  startedAt: string;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: "SCHEDULER_TICK_FAILED" | null;
  running: boolean;
}

export function waitForAbortableInterval(signal: AbortSignal, intervalMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", onAbort);
    if (signal.aborted) finish();
  });
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
    } catch (cause) {
      input.health.lastErrorAt = new Date().toISOString();
      input.health.lastErrorCode = "SCHEDULER_TICK_FAILED";
      const errorType = cause instanceof Error ? cause.name : typeof cause;
      console.error(JSON.stringify({ event: "runtime_assurance_tick_failed", error_type: errorType }));
    }
    if (input.signal.aborted) break;
    await waitForAbortableInterval(input.signal, input.intervalMs);
  }
  input.health.running = false;
}
