import { describe, expect, it } from "vitest";

import {
  attentionText,
  formatBalanceAmount,
  providerRow,
  syncStateOf,
} from "./dashboard-home-providers.js";
import type {
  ProviderOperatingSyncState,
  ProviderResourceOperatingSnapshot,
} from "./provider-operating-repository.js";

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

describe("formatBalanceAmount（余额格式化）", () => {
  it("CNY 或空币种格式化为 ¥ 前缀两位小数", () => {
    expect(formatBalanceAmount("18.5", "CNY")).toBe("¥18.50");
    expect(formatBalanceAmount("20", null)).toBe("¥20.00");
    expect(formatBalanceAmount("0", "CNY")).toBe("¥0.00");
  });

  it("非 CNY 币种保留币种代码与两位小数", () => {
    expect(formatBalanceAmount("5.4", "USD")).toBe("USD 5.40");
  });
});

describe("attentionText（低余额关注信息派生）", () => {
  const emptySync = {
    failedCount: 0,
    failedErrorCodes: [],
    staleCount: 0,
    notRunCount: 0,
    resourceCount: 1,
  };

  it("单项资源低余额（≤ 20）时显示具体资源名与偏低金额建议充值", () => {
    const text = attentionText([], emptySync, [{
      resourceName: "DeepSeek API",
      balance: "18.50",
      currency: "CNY",
      formattedBalance: "¥18.50",
      isExhausted: false,
    }]);
    expect(text).toBe("DeepSeek API：当前余额偏低（¥18.50），建议及时充值");
  });

  it("单项资源余额为 0 时提示已耗尽建议充值", () => {
    const text = attentionText([], emptySync, [{
      resourceName: "DeepSeek API",
      balance: "0.00",
      currency: "CNY",
      formattedBalance: "¥0.00",
      isExhausted: true,
    }]);
    expect(text).toBe("DeepSeek API：当前余额已耗尽，建议及时充值");
  });

  it("多项资源低余额时合并提示资源项数", () => {
    const text = attentionText([], emptySync, [
      { resourceName: "API 1", balance: "15.00", currency: "CNY", formattedBalance: "¥15.00", isExhausted: false },
      { resourceName: "API 2", balance: "8.00", currency: "CNY", formattedBalance: "¥8.00", isExhausted: false },
    ]);
    expect(text).toBe("其中 2 项资源当前余额偏低，建议及时充值");
  });

  it("异常资源与低余额同时存在时分号隔开", () => {
    const text = attentionText(
      [{ resourceName: "DeepSeek 备", status: "CREDENTIAL_INVALID", mode: "API", label: "凭证失效" }],
      emptySync,
      [{ resourceName: "DeepSeek API", balance: "18.50", currency: "CNY", formattedBalance: "¥18.50", isExhausted: false }],
    );
    expect(text).toContain("DeepSeek 备：凭证失效，需要更新凭证");
    expect(text).toContain("DeepSeek API：当前余额偏低（¥18.50），建议及时充值");
    expect(text).toContain("；");
  });
});

describe("providerRow（厂商行关注聚合包含低余额）", () => {
  const now = new Date("2026-09-11T12:00:00Z");

  function makeSnapshot(balance: string | null): ProviderResourceOperatingSnapshot {
    return {
      id: "snap-1",
      enterprise_id: "ent-1",
      provider_resource_id: "res-ds",
      subscription_period_id: null,
      version: 1,
      source: "PROVIDER_SYNC",
      collected_at: now,
      currency: "CNY",
      recharge_amount: null,
      current_balance: balance,
      granted_balance: null,
      topped_up_balance: null,
      provider_balance_available: true,
      balance_source: "PROVIDER_API",
      cost_source: "NOT_SUPPORTED",
      cumulative_cost: null,
      current_period_cost: null,
      cost_period_start: null,
      cost_period_end: null,
      balance_updated_at: now,
      package_name: null,
      package_cost: null,
      total_quota: null,
      quota_unit: null,
      used_quota: null,
      remaining_quota: null,
      effective_from: null,
      effective_until: null,
      reset_cycle: null,
      reset_anchor_at: null,
      reset_timezone: null,
      usage_calculation: "MANUAL_SNAPSHOT",
      next_reset_at: null,
      created_at: now,
    };
  }

  it("DeepSeek 余额 18.50 元（≤ 20）时：调用状态正常，需要关注提示余额偏低建议充值", () => {
    const rows = [{
      provider_code: "deepseek",
      provider_name: "DeepSeek",
      resource_id: "res-ds",
      resource_name: "DeepSeek API",
      mode: "API",
      status: "ACTIVE",
      updated_at: now,
    }];
    const snapshots = new Map([["res-ds", makeSnapshot("18.50")]]);
    const syncMap = new Map([["res-ds", makeSync({ balance_status: "SUCCESS" })]]);

    const result = providerRow(rows, new Map(), syncMap, snapshots, now);
    expect(result.worstStatus).toBe("ACTIVE");
    expect(result.statusCategory).toBe("NORMAL");
    expect(result.statusLabel).toBe("正常");
    expect(result.attention).toBe("DeepSeek API：当前余额偏低（¥18.50），建议及时充值");
  });

  it("DeepSeek 余额 435.50 元（> 20）时：正常且不需要关注", () => {
    const rows = [{
      provider_code: "deepseek",
      provider_name: "DeepSeek",
      resource_id: "res-ds",
      resource_name: "DeepSeek API",
      mode: "API",
      status: "ACTIVE",
      updated_at: now,
    }];
    const snapshots = new Map([["res-ds", makeSnapshot("435.50")]]);
    const syncMap = new Map([["res-ds", makeSync({ balance_status: "SUCCESS" })]]);

    const result = providerRow(rows, new Map(), syncMap, snapshots, now);
    expect(result.worstStatus).toBe("ACTIVE");
    expect(result.statusCategory).toBe("NORMAL");
    expect(result.attention).toBeNull();
  });

  it("Coding Plan 资源不触发低余额预警", () => {
    const rows = [{
      provider_code: "kimi",
      provider_name: "月之暗面",
      resource_id: "res-kimi",
      resource_name: "Kimi Coding Plan",
      mode: "CODING_PLAN",
      status: "ACTIVE",
      updated_at: now,
    }];
    const snapshots = new Map([["res-kimi", makeSnapshot("10.00")]]);
    const syncMap = new Map([["res-kimi", makeSync({ balance_status: "NOT_SUPPORTED" })]]);

    const result = providerRow(rows, new Map(), syncMap, snapshots, now);
    expect(result.attention).toBeNull();
  });
});

