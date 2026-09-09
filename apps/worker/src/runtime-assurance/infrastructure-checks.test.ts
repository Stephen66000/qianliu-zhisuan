import { expect, it, vi } from "vitest";
import type { Database } from "@qianliu/database";
import type { Kysely } from "kysely";
import { runInfrastructureChecks } from "./infrastructure-checks.js";
const execute = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ rows: [{ value: 1 }] }),
);
vi.mock("kysely", () => ({ sql: () => ({ execute }) }));

it("probes internal services read-only and isolates each failure", async () => {
  const records: Array<{ task: string; ok: boolean }> = [];
  const observe = async <T>(
    task: string,
    _title: string,
    work: () => Promise<T>,
  ) => {
    try {
      const value = await work();
      records.push({ task, ok: true });
      return value;
    } catch (error) {
      records.push({ task, ok: false });
      throw error;
    }
  };
  const get = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  await runInfrastructureChecks({
    db: {} as Kysely<Database>,
    env: { NODE_ENV: "production" },
    observe,
    fetch: get,
    pingRedis: async () => {
      throw new Error("redis down");
    },
  });
  expect(records).toEqual([
    { task: "health:gateway", ok: false },
    { task: "health:control-api", ok: true },
    { task: "health:redis", ok: false },
    { task: "health:database", ok: true },
  ]);
  expect(get).toHaveBeenNthCalledWith(1, "http://gateway:8787/health", {
    signal: expect.any(AbortSignal),
  });
  expect(get).toHaveBeenNthCalledWith(2, "http://control-api:8788/health", {
    signal: expect.any(AbortSignal),
  });
});

it("test/development execution does not contact Compose services", async () => {
  const observe = vi.fn();
  const get = vi.fn();
  await runInfrastructureChecks({
    db: {} as Kysely<Database>,
    env: { NODE_ENV: "test" },
    observe,
    fetch: get,
  });
  expect(observe).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
