import { describe, expect, it, vi } from "vitest";

import { runScheduledOperationalTasks } from "./scheduled-tasks.js";

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
