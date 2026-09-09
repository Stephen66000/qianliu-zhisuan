import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import {
  runSchedulerLoop,
  withRuntimeSchedulerLock,
  type SchedulerHealth,
} from "./scheduler.js";
const m = vi.hoisted(() => ({
  record: vi.fn(),
  execute: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("@qianliu/database", () => ({
  OperationalFaultRepository: class {
    record = m.record;
  },
}));
vi.mock("kysely", () => ({ sql: m.sql }));
const db = {
  connection: () => ({
    execute: (fn: (connection: object) => Promise<unknown>) => fn({}),
  }),
} as Kysely<Database>;
const health = (): SchedulerHealth => ({
  startedAt: "start",
  lastTickAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  running: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-01T00:00:00Z");
  m.sql.mockReturnValue({ execute: m.execute });
  m.execute.mockResolvedValue({ rows: [{ acquired: true }] });
  m.record.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([false, undefined])(
  "lock contention (%s) neither executes work nor reports task success",
  async (acquired) => {
    const c = new AbortController(),
      h = health(),
      tick = vi.fn();
    m.execute.mockImplementation(async () => {
      c.abort();
      return { rows: acquired === undefined ? [] : [{ acquired }] };
    });
    await runSchedulerLoop({
      db,
      tick,
      intervalMs: 10,
      signal: c.signal,
      health: h,
    });
    expect(tick).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
    expect(h).toMatchObject({
      running: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastTickAt: "2026-09-01T00:00:00.000Z",
    });
  },
);
it.each([new TypeError("private"), "private"])(
  "failure is observed, sanitized and followed by a later actual successful tick",
  async (cause) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}),
      c = new AbortController(),
      h = health();
    let count = 0;
    const tick = async () => {
      if (++count === 1) throw cause;
      c.abort();
      return { done: true };
    };
    const running = runSchedulerLoop({
      db,
      tick,
      intervalMs: 10,
      signal: c.signal,
      health: h,
    });
    await vi.advanceTimersByTimeAsync(10);
    await running;
    expect(count).toBe(2);
    expect(h).toMatchObject({
      running: false,
      lastErrorAt: "2026-09-01T00:00:00.000Z",
      lastSuccessAt: "2026-09-01T00:00:00.010Z",
      lastErrorCode: "SCHEDULER_TICK_FAILED",
    });
    expect(m.record.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["scheduler", "后台调度循环", false],
      ["scheduler", "后台调度循环", true],
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "runtime_assurance_tick_failed",
        error_type: cause instanceof Error ? "TypeError" : "string",
      }),
    );
    expect(
      m.sql.mock.calls.filter((c) =>
        String(c[0][0]).includes("pg_advisory_unlock"),
      ),
    ).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("pre-aborted loops do not acquire connections or mark health successful", async () => {
  const c = new AbortController(),
    h = health();
  c.abort();
  await runSchedulerLoop({
    db,
    tick: vi.fn(),
    intervalMs: 10,
    signal: c.signal,
    health: h,
  });
  expect(m.execute).not.toHaveBeenCalled();
  expect(h).toMatchObject({
    running: false,
    lastTickAt: null,
    lastSuccessAt: null,
  });
});
it("releases the acquired lock even when its work fails", async () => {
  const cause = new Error("work");
  await expect(
    withRuntimeSchedulerLock(db, async () => {
      throw cause;
    }),
  ).rejects.toBe(cause);
  expect(m.execute).toHaveBeenCalledTimes(2);
  expect(String(m.sql.mock.calls[0]![0][0])).toContain("pg_try_advisory_lock");
  expect(String(m.sql.mock.calls[1]![0][0])).toContain("pg_advisory_unlock");
});
