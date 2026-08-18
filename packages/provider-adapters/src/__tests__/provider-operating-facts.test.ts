import { describe, expect, it, vi } from "vitest";
import {
  queryProviderOperatingBalance,
  type ProviderOperatingFactsError,
  type ProviderOperatingFetch,
} from "../provider-operating-facts.js";

describe("POOL20-025 厂商经营事实", () => {
  it("只接受 DeepSeek 官方余额字段，不从余额推导费用", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{
          currency: "CNY", total_balance: "68.00", granted_balance: "8.00",
          topped_up_balance: "60.00",
        }],
      }),
    })) as unknown as ProviderOperatingFetch;
    const now = new Date("2026-08-18T00:00:00.000Z");
    await expect(queryProviderOperatingBalance({
      providerCode: "deepseek", mode: "API", credential: "secret", fetch, now,
    })).resolves.toEqual({
      currency: "CNY", totalBalance: "68.00", grantedBalance: "8.00",
      toppedUpBalance: "60.00", available: true, providerDataAt: now,
    });
    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/user/balance", expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });

  it("不支持的资源返回 null，响应缺字段则失败而不是补 0", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as ProviderOperatingFetch;
    await expect(queryProviderOperatingBalance({
      providerCode: "kimi", mode: "CODING_PLAN", credential: "secret", fetch,
    })).resolves.toBeNull();
    await expect(queryProviderOperatingBalance({
      providerCode: "deepseek", mode: "API", credential: "secret", fetch,
    })).rejects.toMatchObject<Partial<ProviderOperatingFactsError>>({ code: "INVALID_RESPONSE" });
  });
});
