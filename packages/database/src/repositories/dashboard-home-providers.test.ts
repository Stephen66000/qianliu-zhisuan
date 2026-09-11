import { describe, expect, it } from "vitest";

import { syncStateOf } from "./dashboard-home-providers.js";
import type { ProviderOperatingSyncState } from "./provider-operating-repository.js";

function makeSync(partial: Partial<ProviderOperatingSyncState>): ProviderOperatingSyncState {
  return {
    provider_resource_id: "res-1",
    balance_status: "SUCCESS",
    cost_status: "NOT_SUPPORTED",
    provider_data_at: new Date("2026-09-11T00:00:00Z"),
    last_success_data_at: new Date("2026-09-11T00:00:00Z"),
    completed_at: new Date("2026-09-11T00:05:00Z"),
    next_sync_at: new Date("2026-09-12T00:00:00Z"),
    error_code: null,
    failure_reason: null,
    adapter_version: "test-v1",
    ...partial,
  };
}

describe("syncStateOf（经营数据同步状态判定）", () => {
  const now = new Date("2026-09-11T12:00:00Z");

  describe("Coding Plan 资源", () => {
    it("未同步记录时返回 NOT_SUPPORTED，不报 NOT_RUN", () => {
      expect(syncStateOf("CODING_PLAN", undefined, now)).toBe("NOT_SUPPORTED");
    });

    it("同步记录标记为 NOT_SUPPORTED 时返回 NOT_SUPPORTED，不报 STALE", () => {
      const sync = makeSync({
        balance_status: "NOT_SUPPORTED",
        cost_status: "NOT_SUPPORTED",
        last_success_data_at: null,
        error_code: "PROVIDER_BALANCE_API_NOT_SUPPORTED",
      });
      expect(syncStateOf("CODING_PLAN", sync, now)).toBe("NOT_SUPPORTED");
    });

    it("即使存在旧的成功记录，Coding Plan 也始终判定为 NOT_SUPPORTED", () => {
      const sync = makeSync({
        last_success_data_at: new Date("2026-08-01T00:00:00Z"), // > 36h
      });
      expect(syncStateOf("CODING_PLAN", sync, now)).toBe("NOT_SUPPORTED");
    });
  });

  describe("API 资源", () => {
    it("无同步记录时返回 NOT_RUN", () => {
      expect(syncStateOf("API", undefined, now)).toBe("NOT_RUN");
    });

    it("balance 或 cost 明确 FAILED 时返回 FAILED", () => {
      const sync = makeSync({
        balance_status: "FAILED",
        error_code: "UPSTREAM_TIMEOUT",
      });
      expect(syncStateOf("API", sync, now)).toBe("FAILED");

      const syncCostFailed = makeSync({
        cost_status: "FAILED",
        error_code: "COST_FAILED",
      });
      expect(syncStateOf("API", syncCostFailed, now)).toBe("FAILED");
    });

    it("厂商明确不支持余额且不支持费用（NOT_SUPPORTED）时返回 NOT_SUPPORTED", () => {
      const sync = makeSync({
        balance_status: "NOT_SUPPORTED",
        cost_status: "NOT_SUPPORTED",
        last_success_data_at: null,
      });
      expect(syncStateOf("API", sync, now)).toBe("NOT_SUPPORTED");
    });

    it("同步成功且新鲜（< 36 小时）时返回 OK", () => {
      const sync = makeSync({
        balance_status: "SUCCESS",
        last_success_data_at: new Date(now.getTime() - 2 * 3600 * 1000), // 2 小时前
      });
      expect(syncStateOf("API", sync, now)).toBe("OK");
    });

    it("同步成功但过期（> 36 小时）时返回 STALE", () => {
      const sync = makeSync({
        balance_status: "SUCCESS",
        last_success_data_at: new Date(now.getTime() - 40 * 3600 * 1000), // 40 小时前
      });
      expect(syncStateOf("API", sync, now)).toBe("STALE");
    });

    it("缺少 last_success_data_at 时返回 STALE", () => {
      const sync = makeSync({
        balance_status: "SUCCESS",
        last_success_data_at: null,
      });
      expect(syncStateOf("API", sync, now)).toBe("STALE");
    });
  });
});
