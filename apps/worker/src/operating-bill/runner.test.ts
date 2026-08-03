import { describe, expect, it, vi } from "vitest";
import { generateOperatingBill } from "./runner.js";

describe("POOL-025 月账 Worker", () => {
  it("按企业与自然月调用唯一聚合实现并返回结果", async () => {
    const bill = { month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT" };
    const getBill = vi.fn().mockResolvedValue(bill);
    await expect(generateOperatingBill({ getBill } as never, "enterprise-1", "2026-08")).resolves.toBe(bill);
    expect(getBill).toHaveBeenCalledOnce();
    expect(getBill).toHaveBeenCalledWith("enterprise-1", "2026-08");
  });
});
