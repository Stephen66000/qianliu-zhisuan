/**
 * W16 单元测试：经营调度（matchPolicy / decideDispatch / computeDispatchSaving）。
 *
 * 覆盖：
 *   - matchPolicy：各匹配条件（模型/资源/模式/主体/时间窗/价格倍率/额度比例/耗尽风险）
 *   - decideDispatch：无策略默认 ALLOW；命中各动作；SWITCH 越界/无目标降级
 *   - computeDispatchSaving：可计算/NOT_CALCULABLE 各原因（行 628-632）
 *
 * 依据：TRD §9.1 行 609-632；WT-16/17。
 * 风格对齐 quota-gate.test.ts：注入时钟 T0，工厂函数，边界 case。
 */
import { describe, it, expect } from "vitest";
import {
  matchPolicy,
  decideDispatch,
  computeDispatchSaving,
  DISPATCH_REASON,
  DISPATCH_POLICY_VERSION,
  type DispatchPolicy,
  type DispatchInput,
} from "../index.js";

// 2026-07-27 15:30:00 UTC+8（周一 15:30，落在 14:00-18:00 高峰窗内）
const T0 = Date.UTC(2026, 6, 27, 7, 30, 0);
const RES_A = "res-a";
const RES_B = "res-b";
const RES_C = "res-c";
const PRINCIPAL = "principal-1";

function policy(overrides: Partial<DispatchPolicy> = {}): DispatchPolicy {
  return {
    id: "pol-1",
    status: "PUBLISHED",
    matchUnifiedModel: null,
    matchResourceMode: null,
    matchProviderResourceId: null,
    matchTimezone: null,
    matchDaysOfWeek: null,
    matchStartTime: null,
    matchEndTime: null,
    matchPriceMultiplierMin: null,
    matchRemainingQuotaRatioMax: null,
    matchForecastExhaustRisk: null,
    matchPrincipalScope: null,
    action: "ALLOW",
    switchEquivalentGroup: [],
    rateLimitPerMinute: null,
    policyVersion: DISPATCH_POLICY_VERSION,
    priority: 100,
    ...overrides,
  };
}

function input(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    now: T0,
    unifiedModel: "qianliu-glm-coding",
    selectedResourceId: RES_A,
    resourceMode: "CODING_PLAN",
    priceMultiplier: "1",
    remainingQuotaRatio: null,
    forecastExhaustRisk: false,
    principalId: PRINCIPAL,
    ...overrides,
  };
}

describe("matchPolicy 匹配条件", () => {
  it("非 PUBLISHED 状态不匹配（只有 PUBLISHED 进热路径）", () => {
    expect(matchPolicy(policy({ status: "DRAFT" }), input())).toBe(false);
    expect(matchPolicy(policy({ status: "RETIRED" }), input())).toBe(false);
  });

  it("PUBLISHED 且无条件 → 匹配（通配策略）", () => {
    expect(matchPolicy(policy(), input())).toBe(true);
  });

  it("统一模型不匹配 → false", () => {
    expect(matchPolicy(policy({ matchUnifiedModel: "qianliu-kimi-k3" }), input())).toBe(false);
    expect(matchPolicy(policy({ matchUnifiedModel: "qianliu-glm-coding" }), input())).toBe(true);
  });

  it("资源模式不匹配 → false", () => {
    expect(matchPolicy(policy({ matchResourceMode: "API" }), input())).toBe(false);
    expect(matchPolicy(policy({ matchResourceMode: "CODING_PLAN" }), input())).toBe(true);
  });

  it("指定资源不匹配 → false", () => {
    expect(matchPolicy(policy({ matchProviderResourceId: RES_B }), input())).toBe(false);
    expect(matchPolicy(policy({ matchProviderResourceId: RES_A }), input())).toBe(true);
  });

  it("主体范围不匹配 → false（null/空=任意）", () => {
    expect(matchPolicy(policy({ matchPrincipalScope: ["other"] }), input())).toBe(false);
    expect(matchPolicy(policy({ matchPrincipalScope: [PRINCIPAL] }), input())).toBe(true);
    expect(matchPolicy(policy({ matchPrincipalScope: null }), input())).toBe(true);
    expect(matchPolicy(policy({ matchPrincipalScope: [] }), input())).toBe(true);
  });

  it("时间窗：高峰 14:00-18:00（Asia/Shanghai）命中（WT-16 峰谷）", () => {
    const p = policy({
      matchTimezone: "Asia/Shanghai",
      matchStartTime: "14:00:00",
      matchEndTime: "18:00:00",
    });
    // T0 = UTC+8 15:30 → 命中
    expect(matchPolicy(p, input({ now: T0 }))).toBe(true);
    // 非高峰时段（UTC+8 10:00）→ 不命中
    const offPeak = Date.UTC(2026, 6, 27, 2, 0, 0); // UTC+8 10:00
    expect(matchPolicy(p, input({ now: offPeak }))).toBe(false);
  });

  it("时间窗左闭右开并精确到秒：14:00:00 命中，18:00:00 不命中", () => {
    const p = policy({
      matchTimezone: "Asia/Shanghai",
      matchStartTime: "14:00:00",
      matchEndTime: "18:00:00",
    });
    expect(matchPolicy(p, input({ now: Date.UTC(2026, 6, 27, 6, 0, 0) }))).toBe(true);
    expect(matchPolicy(p, input({ now: Date.UTC(2026, 6, 27, 9, 59, 59) }))).toBe(true);
    expect(matchPolicy(p, input({ now: Date.UTC(2026, 6, 27, 10, 0, 0) }))).toBe(false);
  });

  it("跨午夜时间窗：23:00:30–02:00:15 正确命中两侧", () => {
    const p = policy({
      matchTimezone: "Asia/Shanghai",
      matchStartTime: "23:00:30",
      matchEndTime: "02:00:15",
    });
    expect(matchPolicy(p, input({ now: Date.UTC(2026, 6, 27, 15, 0, 30) }))).toBe(true);
    expect(matchPolicy(p, input({ now: Date.UTC(2026, 6, 27, 18, 0, 14) }))).toBe(true);
    expect(matchPolicy(p, input({ now: Date.UTC(2026, 6, 27, 18, 0, 15) }))).toBe(false);
  });

  it("时间窗：星期限定（仅周一）", () => {
    const p = policy({
      matchTimezone: "Asia/Shanghai",
      matchDaysOfWeek: [1], // 周一
      matchStartTime: "00:00:00",
      matchEndTime: "23:59:59",
    });
    expect(matchPolicy(p, input({ now: T0 }))).toBe(true); // 2026-07-27 周一
    const tuesday = Date.UTC(2026, 6, 28, 7, 30, 0); // 周二
    expect(matchPolicy(p, input({ now: tuesday }))).toBe(false);
  });

  it("价格倍率下限（≥）：高峰 ×3 命中", () => {
    const p = policy({ matchPriceMultiplierMin: "3" });
    expect(matchPolicy(p, input({ priceMultiplier: "3" }))).toBe(true);
    expect(matchPolicy(p, input({ priceMultiplier: "2" }))).toBe(false);
    expect(matchPolicy(p, input({ priceMultiplier: "3.5" }))).toBe(true);
  });

  it("剩余额度比例上限（≤）：耗尽风险（WT-16 额度策略）", () => {
    const p = policy({ matchRemainingQuotaRatioMax: "0.2" }); // ≤20% 命中
    expect(matchPolicy(p, input({ remainingQuotaRatio: 0.15 }))).toBe(true);
    expect(matchPolicy(p, input({ remainingQuotaRatio: 0.25 }))).toBe(false);
    // 未知额度比例不命中耗尽风险类策略（不伪精确）
    expect(matchPolicy(p, input({ remainingQuotaRatio: null }))).toBe(false);
  });

  it("预计耗尽风险：仅当 input 标记有风险时匹配", () => {
    const p = policy({ matchForecastExhaustRisk: true });
    expect(matchPolicy(p, input({ forecastExhaustRisk: true }))).toBe(true);
    expect(matchPolicy(p, input({ forecastExhaustRisk: false }))).toBe(false);
  });
});

describe("decideDispatch 动作判定", () => {
  it("无匹配策略 → 默认 ALLOW_NO_POLICY", () => {
    const d = decideDispatch([], input(), new Set([RES_A]));
    expect(d.finalAction).toBe("ALLOW");
    expect(d.reasonCode).toBe(DISPATCH_REASON.ALLOW_NO_POLICY);
    expect(d.matchedPolicy).toBeNull();
    expect(d.switchTargetResourceId).toBeNull();
  });

  it("命中 ALLOW → ALLOW_MATCHED", () => {
    const d = decideDispatch([policy({ action: "ALLOW" })], input(), new Set([RES_A]));
    expect(d.finalAction).toBe("ALLOW");
    expect(d.reasonCode).toBe(DISPATCH_REASON.ALLOW_MATCHED);
  });

  it("命中 REJECT → REJECTED", () => {
    const d = decideDispatch([policy({ action: "REJECT" })], input(), new Set([RES_A]));
    expect(d.finalAction).toBe("REJECT");
    expect(d.reasonCode).toBe(DISPATCH_REASON.REJECTED);
  });

  it("命中 RATE_LIMIT → RATE_LIMITED", () => {
    const d = decideDispatch([policy({ action: "RATE_LIMIT", rateLimitPerMinute: 10 })], input(), new Set([RES_A]));
    expect(d.finalAction).toBe("RATE_LIMIT");
    expect(d.reasonCode).toBe(DISPATCH_REASON.RATE_LIMITED);
  });

  it("命中 ALLOW_OVERAGE", () => {
    const d = decideDispatch([policy({ action: "ALLOW_OVERAGE" })], input(), new Set([RES_A]));
    expect(d.finalAction).toBe("ALLOW_OVERAGE");
    expect(d.reasonCode).toBe(DISPATCH_REASON.ALLOW_OVERAGE_MATCHED);
  });

  it("命中 SWITCH 且目标在等价组∩可用 → SWITCH_WITHIN_GROUP（WT-16 等价切换）", () => {
    const p = policy({
      action: "SWITCH",
      switchEquivalentGroup: [RES_A, RES_B, RES_C],
    });
    const d = decideDispatch([p], input({ selectedResourceId: RES_A }), new Set([RES_A, RES_B, RES_C]));
    expect(d.finalAction).toBe("SWITCH");
    expect(d.reasonCode).toBe(DISPATCH_REASON.SWITCH_WITHIN_GROUP);
    expect(d.switchTargetResourceId).toBe(RES_B); // 等价组内第一个非当前资源
  });

  it("SWITCH：等价组内其他资源都不可用 → 降级 ALLOW_NO_TARGET（不无账放行）", () => {
    const p = policy({
      action: "SWITCH",
      switchEquivalentGroup: [RES_A, RES_B],
    });
    // 只有 RES_A 可用，RES_B 不可用
    const d = decideDispatch([p], input({ selectedResourceId: RES_A }), new Set([RES_A]));
    expect(d.finalAction).toBe("ALLOW");
    expect(d.reasonCode).toBe(DISPATCH_REASON.SWITCH_NO_TARGET);
    expect(d.switchTargetResourceId).toBeNull();
  });

  it("SWITCH：等价组只含当前资源 → 降级 ALLOW_NO_TARGET", () => {
    const p = policy({
      action: "SWITCH",
      switchEquivalentGroup: [RES_A], // 只有自己
    });
    const d = decideDispatch([p], input({ selectedResourceId: RES_A }), new Set([RES_A]));
    expect(d.finalAction).toBe("ALLOW");
    expect(d.reasonCode).toBe(DISPATCH_REASON.SWITCH_NO_TARGET);
  });

  it("多策略命中 → 取最高优先级（priority 数值最小）", () => {
    const allowP = policy({ id: "pol-allow", action: "ALLOW", priority: 200 });
    const rejectP = policy({ id: "pol-reject", action: "REJECT", priority: 50 }); // 更高优先级
    const d = decideDispatch([allowP, rejectP], input(), new Set([RES_A]));
    expect(d.finalAction).toBe("REJECT");
    expect(d.matchedPolicy?.id).toBe("pol-reject");
  });

  it("同优先级按策略 ID 稳定决胜，与数据库返回顺序无关", () => {
    const later = policy({ id: "policy-z", action: "ALLOW", priority: 50 });
    const earlier = policy({ id: "policy-a", action: "REJECT", priority: 50 });
    const first = decideDispatch([later, earlier], input(), new Set([RES_A]));
    const second = decideDispatch([earlier, later], input(), new Set([RES_A]));
    expect(first.matchedPolicy?.id).toBe("policy-a");
    expect(second.matchedPolicy?.id).toBe("policy-a");
    expect(first.finalAction).toBe("REJECT");
  });
});

describe("computeDispatchSaving 反事实节省（WT-17，§9.1 行 620-632）", () => {
  it("可计算：反事实 − 实际 = 正节省（切换到更便宜资源）", () => {
    const r = computeDispatchSaving({
      finalAction: "SWITCH",
      counterfactualCost: "0.100",
      actualCost: "0.060",
      actionExecuted: true,
    });
    expect(r.saving).not.toBe("NOT_CALCULABLE");
    expect(Number(r.saving)).toBeCloseTo(0.04, 6); // 派生值，落库时 toFixed(8)
    expect(r.reason).toBeNull();
  });

  it("可计算：负节省（实际更贵，允许为负）", () => {
    const r = computeDispatchSaving({
      finalAction: "SWITCH",
      counterfactualCost: "0.050",
      actualCost: "0.080",
      actionExecuted: true,
    });
    expect(r.saving).not.toBe("NOT_CALCULABLE");
    expect(Number(r.saving)).toBeCloseTo(-0.03, 6);
  });

  it("仅提示（actionExecuted=false）→ NOT_CALCULABLE（行 631：仅提示/未改变行为）", () => {
    const r = computeDispatchSaving({
      finalAction: "ALLOW",
      counterfactualCost: "0.100",
      actualCost: "0.100",
      actionExecuted: false,
    });
    expect(r.saving).toBe("NOT_CALCULABLE");
    expect(r.reason).toBe("no_action_executed");
  });

  it("反事实基线不可比（counterfactualCost=null）→ NOT_CALCULABLE（行 628, 631）", () => {
    const r = computeDispatchSaving({
      finalAction: "ALLOW",
      counterfactualCost: null,
      actualCost: "0.060",
      actionExecuted: true,
    });
    expect(r.saving).toBe("NOT_CALCULABLE");
    expect(r.reason).toBe("baseline_not_comparable");
  });

  it("无实际成本证据（actualCost=null）→ NOT_CALCULABLE（行 630：无价格证据）", () => {
    const r = computeDispatchSaving({
      finalAction: "SWITCH",
      counterfactualCost: "0.100",
      actualCost: null,
      actionExecuted: true,
    });
    expect(r.saving).toBe("NOT_CALCULABLE");
    expect(r.reason).toBe("baseline_not_comparable");
  });

  it("成本值无效 → NOT_CALCULABLE", () => {
    const r = computeDispatchSaving({
      finalAction: "SWITCH",
      counterfactualCost: "abc",
      actualCost: "0.060",
      actionExecuted: true,
    });
    expect(r.saving).toBe("NOT_CALCULABLE");
    expect(r.reason).toBe("invalid_cost_value");
  });
});
