import { describe, expect, it } from "vitest";
import {
  financeManagedOperatingSnapshotError,
  OperatingSnapshotSchema,
} from "./contracts.js";

describe("OperatingSnapshotSchema", () => {
  it("拒绝早于或等于生效时间的套餐失效时间", () => {
    const result = OperatingSnapshotSchema.safeParse({
      source: "ADMIN",
      collected_at: "2026-08-03T03:49:00.000Z",
      effective_from: "2026-08-03T03:49:00.000Z",
      effective_until: "2026-08-03T03:49:00.000Z",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["effective_until"],
        message: "套餐失效时间必须晚于生效时间",
      }));
    }
  });

  it("人工录入金额最多保留两位，但厂商同步保留原始高精度", () => {
    expect(OperatingSnapshotSchema.safeParse({
      source: "ADMIN",
      collected_at: "2026-08-03T03:49:00.000Z",
      current_balance: "109.411",
    }).success).toBe(false);
    expect(OperatingSnapshotSchema.safeParse({
      source: "PROVIDER_SYNC",
      collected_at: "2026-08-03T03:49:00.000Z",
      current_balance: "109.41123456",
    }).success).toBe(true);
  });

  it("资金模式启用后拒绝从经营快照写余额或订阅费用", () => {
    const api = OperatingSnapshotSchema.parse({ source: "ADMIN",
      collected_at: "2026-09-03T00:00:00.000Z", current_balance: "100" });
    const plan = OperatingSnapshotSchema.parse({ source: "ADMIN",
      collected_at: "2026-09-03T00:00:00.000Z", total_quota: "1000",
      package_cost: "199" });
    expect(financeManagedOperatingSnapshotError("API", api)).toContain("current_balance");
    expect(financeManagedOperatingSnapshotError("CODING_PLAN", plan)).toContain("package_cost");
    expect(financeManagedOperatingSnapshotError("CODING_PLAN", {
      ...plan, package_cost: null,
    })).toBeNull();
  });
});
