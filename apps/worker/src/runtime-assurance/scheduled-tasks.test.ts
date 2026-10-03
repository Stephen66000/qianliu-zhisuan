import { describe, expect, it, vi } from "vitest";

import {
  runIsolatedOperationalTask,
  runScheduledOperationalTasks,
  summarizeIsolatedOperationalRound,
} from "./scheduled-tasks.js";

describe("POOL20-045 常驻聚合调度隔离", () => {
  it("聚合失败不回滚或阻断同 tick 的运行保障任务，后续 tick 可恢复", async () => {
    const core = vi.fn(async () => ({ runtime: "ok", forecast: "ok" }));
    const aggregate = vi.fn()
      .mockRejectedValueOnce(new Error("aggregate failed"))
      .mockResolvedValueOnce({ dirtyHourBuckets: 1, dirtyDayBuckets: 1 });
    const onAggregateError = vi.fn();

    await expect(runScheduledOperationalTasks({ core, aggregate, onAggregateError }))
      .resolves.toEqual({ core: { runtime: "ok", forecast: "ok" }, aggregate: null });
    expect(onAggregateError).toHaveBeenCalledOnce();
    await expect(runScheduledOperationalTasks({ core, aggregate, onAggregateError }))
      .resolves.toEqual({
        core: { runtime: "ok", forecast: "ok" },
        aggregate: { dirtyHourBuckets: 1, dirtyDayBuckets: 1 },
      });
    expect(core).toHaveBeenCalledTimes(2);
  });
});

it("renewal runs independently before the other operational tasks and failures are reported", async () => {
  const order:string[]=[];
  const core=vi.fn(async()=>{order.push("core");return "ok";});
  const error=new Error("renewal unavailable");const onRenewalError=vi.fn();
  await runScheduledOperationalTasks({renewals:async()=>{order.push("renewal");throw error;},onRenewalError,core,aggregate:async()=>null});
  expect(order).toEqual(["renewal","core"]);expect(onRenewalError).toHaveBeenCalledWith(error);
});

describe("CPQW（计划§8）必需任务独立捕错与整轮汇总", () => {
  it("前置任务异常仍尝试后续任务，失败独立记录，不伪装成功", async () => {
    const attempted: string[] = [];
    const failures: string[] = [];
    const logTaskError = (task: string) => failures.push(task);
    const run = (task: string, work: () => Promise<unknown>) =>
      runIsolatedOperationalTask(task, work, logTaskError);

    const infrastructure = await run("infrastructure", async () => {
      attempted.push("infrastructure");
      throw new Error("db unavailable");
    });
    expect(infrastructure).toBeNull();
    // 前置失败不阻止 runtime/forecast/quota 继续尝试。
    const runtime = await run("runtime_assurance", async () => {
      attempted.push("runtime_assurance");
      return { recovered: 1 };
    });
    const quota = await run("quota_window", async () => {
      attempted.push("quota_window");
      return { resourcesScanned: 3 };
    });
    expect(runtime).toEqual({ recovered: 1 });
    expect(quota).toEqual({ resourcesScanned: 3 });
    expect(attempted).toEqual(["infrastructure", "runtime_assurance", "quota_window"]);
    expect(failures).toEqual(["infrastructure"]);
    // 全部尝试完成后：任一必需任务失败 → 整轮标失败（调度健康反映），不提前退出。
    expect(() => summarizeIsolatedOperationalRound({ runtime, quota }, failures))
      .toThrow("operational_tick_partial_failure:infrastructure");
    // 无失败时结果原样返回。
    expect(summarizeIsolatedOperationalRound({ runtime, quota }, [])).toEqual({ runtime, quota });
  });
});
