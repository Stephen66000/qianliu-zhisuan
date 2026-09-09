import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "@qianliu/database";
import type { Kysely } from "kysely";
const record = vi.hoisted(() => vi.fn());
vi.mock("@qianliu/database", () => ({
  OperationalFaultRepository: class {
    record = record;
  },
}));
import { createTaskObserver } from "./observed-task.js";
beforeEach(() => {
  record.mockReset();
  record.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("records thrown and partial task failures, but skipped tasks neither fail nor recover", async () => {
  const observe = createTaskObserver({} as Kysely<Database>, "enterprise");
  const failure = new Error("private error text");
  await expect(
    observe("task", "任务", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(record).toHaveBeenCalledWith(
    "task",
    "任务",
    false,
    expect.any(Date),
    "enterprise",
  );
  await observe(
    "task",
    "任务",
    async () => ({ failed: 1 }),
    (r) => r.failed === 0,
  );
  expect(record).toHaveBeenCalledTimes(2);
  await observe(
    "task",
    "任务",
    async () => null,
    () => null,
  );
  expect(record).toHaveBeenCalledTimes(2);
  await observe("task", "任务", async () => 1);
  expect(record).toHaveBeenLastCalledWith(
    "task",
    "任务",
    true,
    expect.any(Date),
    "enterprise",
  );
});
it("database failure does not replace the original error; recovery flushes the pending failure first", async () => {
  const observe = createTaskObserver({} as Kysely<Database>);
  const cause = new Error("job failed");
  record.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(
    observe("task", "任务", async () => {
      throw cause;
    }),
  ).rejects.toBe(cause);
  await observe("task", "任务", async () => 1);
  expect(record.mock.calls.map((call) => call[2])).toEqual([
    false,
    false,
    true,
  ]);
});
it("repeated recording failures preserve the first fault time and never invent a failure for successful work", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-01T00:00:00Z");
  const log = vi.spyOn(console, "error").mockImplementation(() => {}),
    observe = createTaskObserver({} as Kysely<Database>, "tenant");
  record.mockRejectedValue(new Error("database"));
  await observe("success", "成功", async () => true);
  await observe(
    "task",
    "首个标题",
    async () => false,
    (x) => x,
  );
  vi.setSystemTime("2026-09-02T00:00:00Z");
  await observe(
    "task",
    "重复故障",
    async () => false,
    (x) => x,
  );
  record.mockResolvedValue(undefined);
  record.mockClear();
  await observe("success", "成功", async () => true);
  expect(record.mock.calls).toEqual([
    ["success", "成功", true, new Date("2026-09-02T00:00:00Z"), "tenant"],
  ]);
  record.mockClear();
  await observe("task", "恢复标题", async () => true);
  expect(record.mock.calls).toEqual([
    ["task", "首个标题", false, new Date("2026-09-01T00:00:00Z"), "tenant"],
    ["task", "恢复标题", true, new Date("2026-09-02T00:00:00Z"), "tenant"],
  ]);
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "task_fault_record_unavailable", task: "task" }),
  );
});
