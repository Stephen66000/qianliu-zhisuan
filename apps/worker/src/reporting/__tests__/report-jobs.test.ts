import { describe, expect, it } from "vitest";
import { MemoryMilestoneStore } from "../milestone-store.js";
import { checkAndDispatchTop1Milestone } from "../incentive-jobs.js";

describe("Report and Incentive Jobs Logic", () => {
  describe("MemoryMilestoneStore - 频控状态存储", () => {
    it("正确记录与限制当日流动红旗发放", async () => {
      const store = new MemoryMilestoneStore();
      const entId = "ent-001";
      const today = "2026-09-10";

      expect(await store.hasTop1IssuedToday(entId, today)).toBe(false);

      await store.recordTop1IssuedToday(entId, today);
      expect(await store.hasTop1IssuedToday(entId, today)).toBe(true);

      // 其他企业或日期不受影响
      expect(await store.hasTop1IssuedToday("ent-002", today)).toBe(false);
      expect(await store.hasTop1IssuedToday(entId, "2026-09-11")).toBe(false);
    });

    it("正确记录与限制员工当周流动红旗领取", async () => {
      const store = new MemoryMilestoneStore();
      const entId = "ent-001";
      const week = "2026-W37";
      const user = "user-100";

      expect(await store.hasUserAwardedTop1ThisWeek(entId, week, user)).toBe(false);

      await store.recordUserAwardedTop1ThisWeek(entId, week, user);
      expect(await store.hasUserAwardedTop1ThisWeek(entId, week, user)).toBe(true);
      expect(await store.hasUserAwardedTop1ThisWeek(entId, week, "user-200")).toBe(false);
    });

    it("正确记录与限制员工月度超越50%领取", async () => {
      const store = new MemoryMilestoneStore();
      const entId = "ent-001";
      const month = "2026-09";
      const user = "user-100";

      expect(await store.hasUserAwardedOver50ThisMonth(entId, month, user)).toBe(false);

      await store.recordUserAwardedOver50ThisMonth(entId, month, user);
      expect(await store.hasUserAwardedOver50ThisMonth(entId, month, user)).toBe(true);
      expect(await store.hasUserAwardedOver50ThisMonth(entId, month, "user-200")).toBe(false);
      expect(await store.hasUserAwardedOver50ThisMonth(entId, "2026-10", user)).toBe(false);
    });
  });

  describe("checkAndDispatchTop1Milestone 静默期规则", () => {
    it("周一与周二自动进入蓄水静默期，不触发发放", async () => {
      const store = new MemoryMilestoneStore();
      const monday = new Date("2026-09-07T10:00:00+08:00"); // Monday
      const tuesday = new Date("2026-09-08T10:00:00+08:00"); // Tuesday

      // Mock DB (不被调用，直接在星期校验时返回)
      const mockDb = {} as any;

      const resMon = await checkAndDispatchTop1Milestone({
        db: mockDb,
        kekBase64: "dGVzdC1rZWs=",
        enterpriseId: "ent-001",
        milestoneStore: store,
        now: monday,
        dryRun: true,
      });
      expect(resMon?.triggered).toBe(false);
      expect(resMon?.reason).toBe("SILENT_PERIOD_MON_TUE");

      const resTue = await checkAndDispatchTop1Milestone({
        db: mockDb,
        kekBase64: "dGVzdC1rZWs=",
        enterpriseId: "ent-001",
        milestoneStore: store,
        now: tuesday,
        dryRun: true,
      });
      expect(resTue?.triggered).toBe(false);
      expect(resTue?.reason).toBe("SILENT_PERIOD_MON_TUE");
    });
  });
});
