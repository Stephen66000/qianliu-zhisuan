/**
 * CPQW 单元测试：窗口额度耗尽北向呈现（计划§2/§3 冻结合同）。
 *
 * 覆盖：中文北京时间格式（含跨年补全年份）、双窗口取较晚值、任一未知整体未知、
 * 已过点显示确认中（PROVIDER_RESET_TIME_PASSED / next_reset_at=null）、
 * retry_after_ms 与 Retry-After 同源且 ≥1s、code 映射、MODEL_POOL 聚合、
 * 存储记录 reset_source=EXHAUSTION_RECORD。
 */
import { describe, expect, it } from "vitest";
import {
  buildQuotaWindowPresentation,
  formatShanghaiResetTime,
  presentationFromStoredBlock,
} from "./quota-window-presentation.js";
import type { QuotaBlockState } from "@qianliu/domain";

const NOW = new Date("2026-10-05T02:16:00.000Z"); // 北京时间 10:16

function block(windows: Array<{ type: "FIVE_HOUR" | "WEEKLY"; resetAt: string | null }>, unknownWindow = false): QuotaBlockState {
  return {
    schemaVersion: 1,
    incidentId: "incident-1",
    credentialVersion: 1,
    startedAt: NOW.toISOString(),
    unknownWindow,
    windows: windows.map((window) => ({
      type: window.type,
      observedAt: NOW.toISOString(),
      resetAt: window.resetAt,
      resetSource: window.resetAt ? "UPSTREAM_RESET_AT" : null,
    })),
  };
}

describe("formatShanghaiResetTime", () => {
  it("北京时间格式；跨年补全年份", () => {
    expect(formatShanghaiResetTime(new Date("2026-10-05T03:16:00.000Z"), NOW))
      .toBe("10 月 5 日 11:16");
    expect(formatShanghaiResetTime(new Date("2027-01-02T04:00:00.000Z"), NOW))
      .toBe("2027年1月2日 12:00");
  });
});

describe("buildQuotaWindowPresentation（RESOURCE）", () => {
  it("仅 5 小时窗口且未来时间：code=upstream_window_exhausted，三者同源", () => {
    const presentation = buildQuotaWindowPresentation({
      providerCode: "kimi",
      windows: [{ type: "FIVE_HOUR", resetAt: "2026-10-05T03:16:00.000Z", resetSource: "UPSTREAM_RESET_AT" }],
      unknownWindow: false,
      now: NOW,
    });
    expect(presentation.errorCode).toBe("upstream_window_exhausted");
    expect(presentation.message).toBe("Kimi 厂商 5 小时额度已用完，预计 10 月 5 日 11:16（北京时间）恢复，系统将自动恢复服务，请届时重试。");
    expect(presentation.next_reset_at).toBe("2026-10-05T03:16:00.000Z");
    expect(presentation.retry_after_ms).toBe(3_600_000);
    expect(presentation.retryAfterSeconds).toBe(3_600);
    expect(presentation.retryable).toBe(true);
    expect(presentation.not_calculable_reason).toBeNull();
    expect(presentation.quota_windows).toEqual([
      { type: "FIVE_HOUR", reset_at: "2026-10-05T03:16:00.000Z", reset_source: "UPSTREAM_RESET_AT" },
    ]);
  });

  it("双窗口都已知：写明两项，整体取较晚值；周为较晚", () => {
    const presentation = buildQuotaWindowPresentation({
      providerCode: "zhipu",
      windows: [
        { type: "WEEKLY", resetAt: "2026-10-11T00:00:00.000Z", resetSource: "UPSTREAM_RESET_AT" },
        { type: "FIVE_HOUR", resetAt: "2026-10-05T03:16:00.000Z", resetSource: "UPSTREAM_RESET_AT" },
      ],
      unknownWindow: false,
      now: NOW,
    });
    expect(presentation.errorCode).toBe("upstream_quota_exhausted");
    expect(presentation.next_reset_at).toBe("2026-10-11T00:00:00.000Z");
    expect(presentation.message).toContain("智谱 厂商 5 小时与周额度已用完");
    expect(presentation.message).toContain("10 月 11 日 08:00");
    expect(presentation.quota_windows.map((window) => window.type)).toEqual(["FIVE_HOUR", "WEEKLY"]);
  });

  it("一个窗口时间未知：整体未知，不推算时间", () => {
    const presentation = buildQuotaWindowPresentation({
      providerCode: "kimi",
      windows: [
        { type: "WEEKLY", resetAt: null, resetSource: null },
        { type: "FIVE_HOUR", resetAt: "2026-10-05T03:16:00.000Z", resetSource: "UPSTREAM_RESET_AT" },
      ],
      unknownWindow: false,
      now: NOW,
    });
    expect(presentation.next_reset_at).toBeNull();
    expect(presentation.not_calculable_reason).toBe("PROVIDER_RESET_TIME_UNKNOWN");
    expect(presentation.retryable).toBe(false);
    expect(presentation.retryAfterSeconds).toBeNull();
    expect(presentation.retry_after_ms).toBeUndefined();
    expect(presentation.message).toContain("整体恢复时间暂未知");
  });

  it("原预计点已过：显示正在自动确认，不造下一恢复日期", () => {
    const presentation = buildQuotaWindowPresentation({
      providerCode: "kimi",
      windows: [{ type: "WEEKLY", resetAt: "2026-10-05T01:00:00.000Z", resetSource: "UPSTREAM_RESET_AT" }],
      unknownWindow: false,
      now: NOW,
    });
    expect(presentation.next_reset_at).toBeNull();
    expect(presentation.not_calculable_reason).toBe("PROVIDER_RESET_TIME_PASSED");
    expect(presentation.retryable).toBe(false);
    expect(presentation.message).toBe("Kimi 厂商周额度已用完，已到预计恢复时间，系统正在自动确认，请稍后重试。");
    expect(presentation.quota_windows[0]!.reset_at).toBeNull();
  });

  it("未知套餐阻断：写套餐额度，不猜窗口", () => {
    const presentation = buildQuotaWindowPresentation({
      providerCode: "zhipu",
      windows: [],
      unknownWindow: true,
      now: NOW,
    });
    expect(presentation.quota_windows).toEqual([]);
    expect(presentation.quota_window_unknown).toBe(true);
    expect(presentation.not_calculable_reason).toBe("PROVIDER_RESET_TIME_UNKNOWN");
    expect(presentation.message).toBe("智谱 厂商套餐额度已用完，整体恢复时间暂未知，系统将自动检查并恢复服务，请稍后重试。");
    expect(presentation.errorCode).toBe("upstream_quota_exhausted");
  });

  it("retry_after_ms 下限 1000ms", () => {
    const presentation = buildQuotaWindowPresentation({
      providerCode: "kimi",
      windows: [{ type: "FIVE_HOUR", resetAt: new Date(NOW.getTime() + 200).toISOString(), resetSource: "UPSTREAM_RESET_AT" }],
      unknownWindow: false,
      now: NOW,
    });
    expect(presentation.retry_after_ms).toBe(1_000);
    expect(presentation.retryAfterSeconds).toBe(1);
  });
});

describe("MODEL_POOL 与存储记录", () => {
  it("池级不可聚合：无 provider 时间、MULTIPLE_RESOURCE_RESET_TIMES", () => {
    const presentation = buildQuotaWindowPresentation({
      windows: [],
      unknownWindow: true,
      now: NOW,
      scope: "MODEL_POOL",
    });
    expect(presentation.quota_block_scope).toBe("MODEL_POOL");
    expect(presentation.provider).toBeUndefined();
    expect(presentation.next_reset_at).toBeNull();
    expect(presentation.not_calculable_reason).toBe("MULTIPLE_RESOURCE_RESET_TIMES");
    expect(presentation.retryable).toBe(false);
    expect(presentation.message).toContain("套餐资源受阻");
  });

  it("存储记录呈现：reset_source=EXHAUSTION_RECORD，未来日期持续可展示", () => {
    const presentation = presentationFromStoredBlock({
      block: block([
        { type: "FIVE_HOUR", resetAt: "2026-10-08T00:00:00.000Z" },
        { type: "WEEKLY", resetAt: "2026-10-11T00:00:00.000Z" },
      ]),
      providerCode: "kimi",
      now: NOW,
    });
    expect(presentation.quota_windows.every((window) => window.reset_source === "EXHAUSTION_RECORD")).toBe(true);
    expect(presentation.next_reset_at).toBe("2026-10-11T00:00:00.000Z");
    expect(presentation.message).toContain("10 月 11 日 08:00");
  });
});
