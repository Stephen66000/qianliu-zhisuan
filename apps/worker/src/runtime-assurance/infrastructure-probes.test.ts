import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { runInfrastructureChecks } from "./infrastructure-checks.js";
const m = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  ping: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  execute: vi.fn(),
  sql: vi.fn(),
  open: false,
}));
vi.mock("redis", () => ({ createClient: m.create }));
vi.mock("kysely", () => ({ sql: m.sql }));
const db = {} as Kysely<Database>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  m.open = false;
  m.create.mockReturnValue({
    connect: m.connect,
    ping: m.ping,
    destroy: m.destroy,
    on: m.on,
    get isOpen() {
      return m.open;
    },
  });
  m.connect.mockImplementation(async () => {
    m.open = true;
  });
  m.ping.mockResolvedValue("PONG");
  m.sql.mockReturnValue({ execute: m.execute });
  m.execute.mockResolvedValue({ rows: [{ value: 1 }] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function check(
  pingRedis?: () => Promise<void>,
  env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    REDIS_URL: "redis://internal:6380",
  },
) {
  const outcomes: Array<[string, boolean, string]> = [];
  const get = vi.fn().mockResolvedValue(new Response("ok"));
  const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
  vi.stubGlobal("fetch", get);
  const observe = async <T>(
    task: string,
    title: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await work();
      outcomes.push([task, true, title]);
      return result;
    } catch (error) {
      outcomes.push([task, false, title]);
      throw error;
    }
  };
  const promise = runInfrastructureChecks({ db, observe, env, pingRedis });
  await vi.advanceTimersByTimeAsync(2600);
  await promise;
  return { outcomes, get, cancel };
}
it("runs actual Redis probe logic, checks PONG, destroys its client, cancels HTTP bodies and executes SELECT 1", async () => {
  const { outcomes, get, cancel } = await check();
  expect(outcomes).toEqual([
    ["health:gateway", true, "Gateway 服务健康检查"],
    ["health:control-api", true, "管理 API 服务健康检查"],
    ["health:redis", true, "Redis 服务健康检查"],
    ["health:database", true, "数据库服务健康检查"],
  ]);
  expect(m.create).toHaveBeenCalledExactlyOnceWith({
    url: "redis://internal:6380",
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  expect(m.connect).toHaveBeenCalledOnce();
  expect(m.ping).toHaveBeenCalledOnce();
  expect(m.destroy).toHaveBeenCalledOnce();
  expect(m.on).toHaveBeenCalledWith("error", expect.any(Function));
  expect(() => m.on.mock.calls[0]![1](new Error("socket"))).not.toThrow();
  expect(get.mock.calls.map((c) => c[0])).toEqual([
    "http://gateway:8787/health",
    "http://control-api:8788/health",
  ]);
  for (const call of get.mock.calls)
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(m.sql.mock.calls[0]![0]).toEqual(["SELECT 1"]);
  expect(m.execute).toHaveBeenCalledExactlyOnceWith(db);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["wrong-pong", "ping-reject", "connect-reject", "timeout"] as const)(
  "isolates %s and cleans resources without preventing the database probe",
  async (mode) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    if (mode === "wrong-pong") m.ping.mockResolvedValue("NOT_PONG");
    if (mode === "ping-reject") m.ping.mockRejectedValue(new Error("failed"));
    if (mode === "connect-reject")
      m.connect.mockRejectedValue(new Error("refused"));
    if (mode === "timeout")
      m.ping.mockImplementation(() => new Promise(() => {}));
    const { outcomes } = await check(undefined, { NODE_ENV: "production" });
    expect(m.create.mock.calls[0]![0].url).toBe("redis://redis:6379");
    expect(outcomes[2]?.[1]).toBe(false);
    expect(outcomes[3]?.[1]).toBe(true);
    expect(m.destroy).toHaveBeenCalledTimes(mode === "connect-reject" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "infrastructure_health_failed",
        task: "health:redis",
      }),
    );
  },
);
it("checks both HTTP failures, absent bodies and the default environment/fetch paths", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const get = vi.fn().mockResolvedValue({ ok: false, body: null });
  vi.stubGlobal("fetch", get);
  const tasks: string[] = [];
  const failures: string[] = [];
  const observe = async <T>(
    task: string,
    _title: string,
    work: () => Promise<T>,
  ) => {
    tasks.push(task);
    try {
      return await work();
    } catch (error) {
      failures.push(task);
      throw error;
    }
  };
  m.execute.mockRejectedValue(new Error("database down"));
  const promise = runInfrastructureChecks({
    db,
    observe,
    pingRedis: async () => {},
  });
  await vi.advanceTimersByTimeAsync(1);
  await promise;
  expect(tasks).toHaveLength(4);
  expect(failures).toEqual([
    "health:gateway",
    "health:control-api",
    "health:database",
  ]);
  expect(get).toHaveBeenCalledTimes(2);
});
