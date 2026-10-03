/**
 * CPQW 单元测试：Coding Plan 窗口额度阻断记录纯函数（quota-block）。
 *
 * 覆盖计划§4 的 F1 关键规则：
 *   - 白名单 schema 解析：合法往返、未知字段/非法窗口/非法来源拒绝
 *   - 首次耗尽创建 incident、同 incident 合并新窗口、凭证代次变化重建
 *   - 失败不抹掉仍在未来的旧日期；非法/过去时间不写入
 *   - 正余量只解除对应窗口；缺失/UNSUPPORTED 不解除
 *   - Kimi 双窗口必需；智谱 FIVE_HOUR 必需且当次已知窗口全正
 *   - unknownWindow 只在双窗口可知且正余量时解除
 *   - 全部解除 → 记录清空（recovered）；下一检查时间取最早未来点
 */
import { describe, it, expect } from "vitest";
import {
  parseQuotaBlockState,
  serializeQuotaBlockState,
  mergeQuotaExhaustion,
  applyQuotaObservation,
  definiteZeroWindows,
  nextQuotaCheckAt,
  type QuotaBlockState,
  type QuotaWindowObservation,
} from "../quota-block.js";

const NOW = new Date("2026-10-03T00:00:00.000Z");
const FUTURE = "2026-10-03T01:16:00.000Z";
const LATER_FUTURE = "2026-10-05T03:16:00.000Z";
const PAST = "2026-10-01T00:00:00.000Z";

function observation(
  windowType: "FIVE_HOUR" | "WEEKLY",
  overrides: Partial<QuotaWindowObservation> = {},
): QuotaWindowObservation {
  return { windowType, known: true, unsupported: false, remaining: 100, resetAt: null, ...overrides };
}

function fiveHourBlock(resetAt: string | null = FUTURE): QuotaBlockState {
  return mergeQuotaExhaustion(null, {
    incidentId: "incident-1",
    credentialVersion: 3,
    now: NOW,
    observation: { windowType: "FIVE_HOUR", resetAt, resetSource: "UPSTREAM_RESET_AT" },
  });
}

describe("parseQuotaBlockState（白名单 schema v1）", () => {
  it("合法记录往返保持不变", () => {
    const state = fiveHourBlock();
    const parsed = parseQuotaBlockState(JSON.parse(serializeQuotaBlockState(state)));
    expect(parsed).toEqual(state);
  });

  it("拒绝未知字段、错误版本、非法窗口名与非法来源", () => {
    const state = fiveHourBlock();
    const raw = JSON.parse(serializeQuotaBlockState(state));
    expect(parseQuotaBlockState({ ...raw, extra: 1 })).toBeNull();
    expect(parseQuotaBlockState({ ...raw, schemaVersion: 2 })).toBeNull();
    expect(parseQuotaBlockState({ ...raw, windows: [{ ...raw.windows[0], type: "MONTHLY" }] })).toBeNull();
    expect(parseQuotaBlockState({ ...raw, windows: [{ ...raw.windows[0], resetSource: "GUESS" }] })).toBeNull();
    expect(parseQuotaBlockState({ ...raw, unknownWindow: "yes" })).toBeNull();
    expect(parseQuotaBlockState(null)).toBeNull();
  });
});

describe("mergeQuotaExhaustion（故障合并）", () => {
  it("首次明确 5 小时耗尽创建 incident 并保存未来重置点", () => {
    const state = fiveHourBlock();
    expect(state.schemaVersion).toBe(1);
    expect(state.incidentId).toBe("incident-1");
    expect(state.unknownWindow).toBe(false);
    expect(state.windows).toEqual([
      { type: "FIVE_HOUR", observedAt: NOW.toISOString(), resetAt: FUTURE, resetSource: "UPSTREAM_RESET_AT" },
    ]);
  });

  it("未知窗口套餐耗尽创建 unknownWindow 记录", () => {
    const state = mergeQuotaExhaustion(null, {
      incidentId: "incident-u", credentialVersion: null, now: NOW,
      observation: { resetAt: null, resetSource: null },
    });
    expect(state.unknownWindow).toBe(true);
    expect(state.windows).toEqual([]);
  });

  it("同凭证新窗口合并进当前 incident，同窗口保留仍在未来的旧日期", () => {
    let state = fiveHourBlock();
    state = mergeQuotaExhaustion(state, {
      incidentId: "ignored", credentialVersion: 3, now: NOW,
      observation: { windowType: "WEEKLY", resetAt: LATER_FUTURE, resetSource: "UPSTREAM_RESET_AT" },
    });
    expect(state.incidentId).toBe("incident-1");
    expect(state.windows.map((window) => window.type).sort()).toEqual(["FIVE_HOUR", "WEEKLY"]);

    const withoutTime = mergeQuotaExhaustion(state, {
      incidentId: "ignored", credentialVersion: 3, now: NOW,
      observation: { windowType: "WEEKLY", resetAt: null, resetSource: null },
    });
    const weekly = withoutTime.windows.find((window) => window.type === "WEEKLY")!;
    expect(weekly.resetAt).toBe(LATER_FUTURE);
  });

  it("过去时间与非法日期不能写入预计恢复时间", () => {
    const state = mergeQuotaExhaustion(null, {
      incidentId: "i", credentialVersion: 1, now: NOW,
      observation: { windowType: "FIVE_HOUR", resetAt: PAST, resetSource: "UPSTREAM_RESET_AT" },
    });
    expect(state.windows[0].resetAt).toBeNull();
  });

  it("凭证代次变化废弃旧 incident、以新凭证重建", () => {
    const state = fiveHourBlock();
    const rotated = mergeQuotaExhaustion(state, {
      incidentId: "incident-2", credentialVersion: 4, now: NOW,
      observation: { windowType: "FIVE_HOUR", resetAt: null, resetSource: null },
    });
    expect(rotated.incidentId).toBe("incident-2");
    expect(rotated.credentialVersion).toBe(4);
    expect(rotated.windows).toHaveLength(1);
  });
});

describe("applyQuotaObservation（解除与恢复）", () => {
  it("正余量只解除对应窗口，另一窗口仍零保持阻断", () => {
    let state = fiveHourBlock();
    state = mergeQuotaExhaustion(state, {
      incidentId: "x", credentialVersion: 3, now: NOW,
      observation: { windowType: "WEEKLY", resetAt: LATER_FUTURE, resetSource: "UPSTREAM_RESET_AT" },
    });
    const outcome = applyQuotaObservation(state, "kimi", [
      observation("FIVE_HOUR", { remaining: 500 }),
      observation("WEEKLY", { remaining: 0, resetAt: LATER_FUTURE }),
    ], NOW);
    expect(outcome.recovered).toBe(false);
    expect(outcome.state?.windows.map((window) => window.type)).toEqual(["WEEKLY"]);
  });

  it("Kimi 双窗口正余量且全部解除 → 记录清空", () => {
    let state = fiveHourBlock();
    state = mergeQuotaExhaustion(state, {
      incidentId: "x", credentialVersion: 3, now: NOW,
      observation: { windowType: "WEEKLY", resetAt: LATER_FUTURE, resetSource: "UPSTREAM_RESET_AT" },
    });
    const outcome = applyQuotaObservation(state, "kimi", [
      observation("FIVE_HOUR", { remaining: 10 }),
      observation("WEEKLY", { remaining: 20 }),
    ], NOW);
    expect(outcome.recovered).toBe(true);
    expect(outcome.state).toBeNull();
  });

  it("周窗口缺失（UNSUPPORTED）不解除已记录的周阻断", () => {
    let state = fiveHourBlock();
    state = mergeQuotaExhaustion(state, {
      incidentId: "x", credentialVersion: 3, now: NOW,
      observation: { windowType: "WEEKLY", resetAt: LATER_FUTURE, resetSource: "UPSTREAM_RESET_AT" },
    });
    const outcome = applyQuotaObservation(state, "kimi", [
      observation("FIVE_HOUR", { remaining: 10 }),
      observation("WEEKLY", { known: false, unsupported: true, remaining: null }),
    ], NOW);
    expect(outcome.recovered).toBe(false);
    expect(outcome.state?.windows.map((window) => window.type)).toEqual(["WEEKLY"]);
  });

  it("Kimi 周窗口正余量但 5 小时仍为零 → 不恢复", () => {
    const state = fiveHourBlock();
    const outcome = applyQuotaObservation(state, "kimi", [
      observation("FIVE_HOUR", { remaining: 0, resetAt: FUTURE }),
      observation("WEEKLY", { remaining: 42 }),
    ], NOW);
    expect(outcome.recovered).toBe(false);
    expect(outcome.state?.windows).toHaveLength(1);
  });

  it("智谱 FIVE_HOUR 正余量即可恢复（周 UNSUPPORTED 不作为证据）", () => {
    const state = fiveHourBlock();
    const outcome = applyQuotaObservation(state, "zhipu", [
      observation("FIVE_HOUR", { remaining: 10 }),
      observation("WEEKLY", { known: false, unsupported: true, remaining: null }),
    ], NOW);
    expect(outcome.recovered).toBe(true);
    expect(outcome.state).toBeNull();
  });

  it("智谱当次返回的其他已知窗口为零则不恢复", () => {
    const state = fiveHourBlock();
    const outcome = applyQuotaObservation(state, "zhipu", [
      observation("FIVE_HOUR", { remaining: 10 }),
      observation("WEEKLY", { remaining: 0 }),
    ], NOW);
    expect(outcome.recovered).toBe(false);
  });

  it("unknownWindow 只在双窗口可知且正余量时解除", () => {
    const unknown = mergeQuotaExhaustion(null, {
      incidentId: "i", credentialVersion: 1, now: NOW, observation: {},
    });
    const stillUnknown = applyQuotaObservation(unknown, "kimi", [
      observation("FIVE_HOUR", { remaining: 5 }),
      observation("WEEKLY", { known: false, unsupported: true, remaining: null }),
    ], NOW);
    expect(stillUnknown.state?.unknownWindow).toBe(true);

    const cleared = applyQuotaObservation(unknown, "kimi", [
      observation("FIVE_HOUR", { remaining: 5 }),
      observation("WEEKLY", { remaining: 6 }),
    ], NOW);
    expect(cleared.recovered).toBe(true);
    expect(cleared.state).toBeNull();
  });

  it("仍为零的窗口可用当次厂商未来重置点更新日期", () => {
    const state = fiveHourBlock(FUTURE);
    const outcome = applyQuotaObservation(state, "kimi", [
      observation("FIVE_HOUR", { remaining: 0, resetAt: LATER_FUTURE }),
      observation("WEEKLY", { remaining: 1 }),
    ], NOW);
    const window = outcome.state?.windows.find((item) => item.type === "FIVE_HOUR");
    expect(window?.resetAt).toBe(LATER_FUTURE);
    expect(window?.resetSource).toBe("UPSTREAM_RESET_AT");
  });
});

describe("definiteZeroWindows / nextQuotaCheckAt", () => {
  it("识别明确零值窗口", () => {
    expect(definiteZeroWindows([
      observation("FIVE_HOUR", { remaining: 0 }),
      observation("WEEKLY", { remaining: 7 }),
      observation("WEEKLY", { known: false, unsupported: true, remaining: null }),
    ])).toEqual(["FIVE_HOUR"]);
  });

  it("下一检查取最早未来点；未知或过点取 now+retry", () => {
    let state = fiveHourBlock(FUTURE);
    state = mergeQuotaExhaustion(state, {
      incidentId: "x", credentialVersion: 3, now: NOW,
      observation: { windowType: "WEEKLY", resetAt: LATER_FUTURE, resetSource: "UPSTREAM_RESET_AT" },
    });
    expect(nextQuotaCheckAt(state, NOW, 300_000)).toBe(Date.parse(FUTURE));

    const unknown = mergeQuotaExhaustion(null, {
      incidentId: "u", credentialVersion: 1, now: NOW, observation: {},
    });
    expect(nextQuotaCheckAt(unknown, NOW, 300_000)).toBe(NOW.getTime() + 300_000);

    const passed = fiveHourBlock(PAST);
    expect(nextQuotaCheckAt(passed, NOW, 300_000)).toBe(NOW.getTime() + 300_000);

    expect(nextQuotaCheckAt(null, NOW, 300_000)).toBeNull();
  });
});
