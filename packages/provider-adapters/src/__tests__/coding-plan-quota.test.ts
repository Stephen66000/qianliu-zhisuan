import { describe, expect, it, vi } from "vitest";
import {
  queryCodingPlanQuota,
  ProviderCodingPlanQuotaError,
  CODING_PLAN_QUOTA_ADAPTER_VERSION,
  type QuotaFetch,
} from "../coding-plan-quota.js";

function ok(payload: unknown): QuotaFetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as QuotaFetch;
}
function failStatus(status: number): QuotaFetch {
  return vi.fn(async () => ({ ok: false, status, json: async () => ({}) })) as unknown as QuotaFetch;
}

describe("POOL-032 厂商 Coding Plan 额度窗口查询", () => {
  it("API 计费资源与 DeepSeek 不调用厂商额度接口，返回空窗口", async () => {
    const fetch = vi.fn() as unknown as QuotaFetch;
    const deepseek = await queryCodingPlanQuota({ providerCode: "deepseek", mode: "API", credential: "sk", fetch });
    const kimiApi = await queryCodingPlanQuota({ providerCode: "kimi", mode: "API", credential: "sk", fetch });
    expect(deepseek.windows).toEqual([]);
    expect(kimiApi.windows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Kimi 解析周额度与 5 小时窗口（POINT 制），含比率与重置时间", async () => {
    const fetch = ok({
      usage: { limit: "100", used: "60", remaining: "40", resetTime: "2026-08-10T03:00:00+08:00" },
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "3", remaining: "97", resetTime: "2026-08-07T11:16:00+08:00" } },
      ],
    });
    const result = await queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "kimi-token", fetch });
    expect(result.adapterVersion).toBe(CODING_PLAN_QUOTA_ADAPTER_VERSION);
    expect(result.windows).toHaveLength(2);
    const weekly = result.windows.find((w) => w.windowType === "WEEKLY")!;
    expect(weekly).toMatchObject({ limit: "100", used: "60", remaining: "40", unit: "POINT", unsupported: false });
    expect(weekly.ratio).toBe("0.600000");
    expect(weekly.resetAt).toEqual(new Date("2026-08-10T03:00:00+08:00"));
    const fiveHour = result.windows.find((w) => w.windowType === "FIVE_HOUR")!;
    expect(fiveHour).toMatchObject({ limit: "100", used: "3", unit: "POINT", unsupported: false });
    expect(fiveHour.ratio).toBe("0.030000");
    // 凭证走 Bearer 头，不进返回值。
    expect(JSON.stringify(result)).not.toContain("kimi-token");
    expect(fetch).toHaveBeenCalledWith("https://api.kimi.com/coding/v1/usages", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer kimi-token" }),
    }));
  });

  it("Kimi 字符串承载与字段缺失时防御性解析，缺失窗口不返回；remaining 从 limit-used 推导", async () => {
    const fetch = ok({ usage: { limit: "100", used: "60" }, limits: [] });
    const result = await queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "sk", fetch });
    // limits 为空 → 只有周窗口，无 5h 窗口（不伪造 0）。
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.windowType).toBe("WEEKLY");
    // remaining 缺失时从 limit-used 推导：100-60=40。
    expect(result.windows[0]!.remaining).toBe("40");
  });

  it("Kimi 5h 窗口 used 缺失时从 limit-remaining 推导", async () => {
    const fetch = ok({
      usage: { limit: "100", used: "38", remaining: "62" },
      limits: [
        { window: { duration: 300 }, detail: { limit: "100", remaining: "100", resetTime: "2026-08-07T11:16:04Z" } },
      ],
    });
    const result = await queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "sk", fetch });
    const fiveHour = result.windows.find((w) => w.windowType === "FIVE_HOUR")!;
    // used 缺失但 limit+remaining 都在 → used = 100-100 = 0。
    expect(fiveHour.used).toBe("0");
    expect(fiveHour.limit).toBe("100");
    expect(fiveHour.remaining).toBe("100");
  });

  it("智谱解析 5 小时百分比与周百分比（PERCENT 制），含重置时间戳", async () => {
    const fetch = ok({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 8, nextResetTime: 1786095078043 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 33, nextResetTime: 1786094589998 },
        ],
        level: "max",
      },
      success: true,
    });
    const result = await queryCodingPlanQuota({ providerCode: "zhipu", mode: "CODING_PLAN", credential: "zhipu-token", fetch });
    const fiveHour = result.windows.find((w) => w.windowType === "FIVE_HOUR")!;
    expect(fiveHour).toMatchObject({ limit: "100", used: "8", remaining: "92", unit: "PERCENT", unsupported: false });
    expect(fiveHour.ratio).toBe("0.080000");
    expect(fiveHour.resetAt).toEqual(new Date(1786095078043));
    const weekly = result.windows.find((w) => w.windowType === "WEEKLY")!;
    expect(weekly).toMatchObject({ limit: "100", used: "33", remaining: "67", unit: "PERCENT", unsupported: false });
    expect(weekly.ratio).toBe("0.330000");
    expect(fetch).toHaveBeenCalledWith("https://open.bigmodel.cn/api/monitor/usage/quota/limit", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer zhipu-token" }),
    }));
  });

  it("智谱缺失 TOKENS_LIMIT 窗口时标记 UNSUPPORTED，不显示 0", async () => {
    const fetch = ok({ data: { limits: [{ type: "TIME_LIMIT", unit: 5, percentage: 1 }] } });
    const result = await queryCodingPlanQuota({ providerCode: "zhipu", mode: "CODING_PLAN", credential: "sk", fetch });
    expect(result.windows.find((w) => w.windowType === "FIVE_HOUR")?.unsupported).toBe(true);
    expect(result.windows.find((w) => w.windowType === "WEEKLY")?.unsupported).toBe(true);
  });

  it("401/403 归 UNAUTHORIZED 且不重试", async () => {
    const fetch = failStatus(401);
    await expect(queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "bad", fetch }))
      .rejects.toMatchObject({ name: "ProviderCodingPlanQuotaError", code: "UNAUTHORIZED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("429 归 RATE_LIMITED（重试耗尽后抛出）", async () => {
    const fetch = failStatus(429);
    await expect(queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "sk", fetch, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("5xx 归 UPSTREAM_UNAVAILABLE", async () => {
    const fetch = failStatus(503);
    await expect(queryCodingPlanQuota({ providerCode: "zhipu", mode: "CODING_PLAN", credential: "sk", fetch, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("网络错误重试后仍失败归 UPSTREAM_UNAVAILABLE", async () => {
    const fetch = vi.fn(async () => { throw new Error("socket reset"); }) as unknown as QuotaFetch;
    await expect(queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "sk", fetch, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("错误实例可被 instanceof 识别，且不含凭证明文", async () => {
    const fetch = failStatus(401);
    try {
      await queryCodingPlanQuota({ providerCode: "kimi", mode: "CODING_PLAN", credential: "leak-me", fetch });
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProviderCodingPlanQuotaError);
      expect((cause as Error).message).not.toContain("leak-me");
    }
  });
});
