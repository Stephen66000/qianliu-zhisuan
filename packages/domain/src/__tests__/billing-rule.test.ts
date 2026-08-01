/**
 * W13 单元测试：计价规则匹配与计算（billing-rule）。
 *
 * 覆盖（TRD §10 + 调研文档）：
 *   - 时段规则：智谱高峰 14:00–18:00 UTC+8 命中/边界/跨时区；星期范围
 *   - 档位规则：Kimi kimi-for-coding-highspeed 3 倍档按模型匹配
 *   - 优先级与特异性：资源专属 > 企业默认；模型专属 > 全部；priority 数值小优先
 *   - 生效区间：effective_from/to 边界（历史版本不被新规则改写）
 *   - 套餐扣减：raw × multiplier，decimal 整数
 *   - API 计价：cache 命中/未命中/输出分项 × 单价，decimal 精度
 *   - 无规则回退：multiplier="1"（原始口径）
 */
import { describe, it, expect } from "vitest";
import {
  toZonedTime,
  findMatchedTimeWindow,
  matchesTimeWindow,
  matchMultiplierRule,
  matchPriceRule,
  computeDeductedQuota,
  computeApiCostFromRule,
  type BillingRule,
} from "../index.js";

// 2026-07-27 是周一。UTC+8 15:00 = UTC 07:00（智谱高峰内）；UTC+8 20:00 = UTC 12:00（高峰外）
const MON_1500_CST = Date.UTC(2026, 6, 27, 7, 0); // 周一 15:00 Asia/Shanghai
const MON_2000_CST = Date.UTC(2026, 6, 27, 12, 0); // 周一 20:00 Asia/Shanghai
const SAT_1500_CST = Date.UTC(2026, 7, 1, 7, 0); // 周六 15:00 Asia/Shanghai

function rule(overrides: Partial<BillingRule> = {}): BillingRule {
  return {
    id: "rule-1",
    ruleType: "TIME_WINDOW",
    ruleVersion: "v1",
    providerResourceId: null,
    upstreamModel: null,
    effectiveFrom: 0,
    effectiveTo: null,
    timezone: "Asia/Shanghai",
    daysOfWeek: null,
    startTime: "14:00",
    endTime: "18:00",
    timeWindows: null,
    multiplier: "3",
    cacheHitPrice: null,
    cacheMissPrice: null,
    outputPrice: null,
    currency: "CNY",
    priority: 100,
    ...overrides,
  };
}

describe("toZonedTime 时区转换", () => {
  it("UTC → Asia/Shanghai 星期与分钟", () => {
    const z = toZonedTime(MON_1500_CST, "Asia/Shanghai");
    expect(z.dayOfWeek).toBe(1); // 周一
    expect(z.minutesOfDay).toBe(15 * 60); // 15:00
  });
});

describe("matchesTimeWindow 时段判定", () => {
  it("高峰内命中，高峰外不命中", () => {
    const r = rule();
    expect(matchesTimeWindow(r, MON_1500_CST)).toBe(true); // 15:00 在 14-18
    expect(matchesTimeWindow(r, MON_2000_CST)).toBe(false); // 20:00 不在
  });

  it("边界：start 含、end 不含", () => {
    const r = rule();
    const start = Date.UTC(2026, 6, 27, 6, 0); // 14:00 CST
    const end = Date.UTC(2026, 6, 27, 10, 0); // 18:00 CST
    expect(matchesTimeWindow(r, start)).toBe(true);
    expect(matchesTimeWindow(r, end)).toBe(false);
  });

  it("同一规则两个高峰窗：09:00–12:00、14:00–18:00 任一命中且边界为 [start,end)", () => {
    const r = rule({
      ruleType: "API_PRICE",
      multiplier: null,
      timeWindows: [
        {
          timezone: "Asia/Shanghai",
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
          startTime: "09:00",
          endTime: "12:00",
        },
        {
          timezone: "Asia/Shanghai",
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
          startTime: "14:00",
          endTime: "18:00",
        },
      ],
    });
    const at = (hour: number) => Date.UTC(2026, 6, 27, hour - 8, 0);
    expect(matchesTimeWindow(r, at(9))).toBe(true);
    expect(matchesTimeWindow(r, at(12))).toBe(false);
    expect(matchesTimeWindow(r, at(14))).toBe(true);
    expect(findMatchedTimeWindow(r, at(14))?.startTime).toBe("14:00");
    expect(matchesTimeWindow(r, at(18))).toBe(false);
  });

  it("星期范围：仅工作日命中，周末不命中", () => {
    const r = rule({ daysOfWeek: [1, 2, 3, 4, 5] });
    expect(matchesTimeWindow(r, MON_1500_CST)).toBe(true); // 周一
    expect(matchesTimeWindow(r, SAT_1500_CST)).toBe(false); // 周六
  });

  it("跨午夜时段（22:00–02:00）", () => {
    const r = rule({ startTime: "22:00", endTime: "02:00" });
    const night23 = Date.UTC(2026, 6, 27, 15, 0); // 23:00 CST
    const night01 = Date.UTC(2026, 6, 27, 17, 0); // 次日 01:00 CST
    expect(matchesTimeWindow(r, night23)).toBe(true);
    expect(matchesTimeWindow(r, night01)).toBe(true);
    expect(matchesTimeWindow(r, MON_1500_CST)).toBe(false);
  });

  it("跨午夜窗口的星期归属开始日", () => {
    const mondayOnly = rule({
      daysOfWeek: [1],
      startTime: "23:00",
      endTime: "02:00",
    });
    const monday2300 = Date.UTC(2026, 6, 27, 15, 0);
    const tuesday0100 = Date.UTC(2026, 6, 27, 17, 0);
    const tuesday2300 = Date.UTC(2026, 6, 28, 15, 0);
    const wednesday0100 = Date.UTC(2026, 6, 28, 17, 0);
    expect(matchesTimeWindow(mondayOnly, monday2300)).toBe(true);
    expect(matchesTimeWindow(mondayOnly, tuesday0100)).toBe(true);
    expect(matchesTimeWindow(mondayOnly, tuesday2300)).toBe(false);
    expect(matchesTimeWindow(mondayOnly, wednesday0100)).toBe(false);
  });

  it("跨午夜边界：恰好 22:00 命中、21:59 不命中、02:00 不命中", () => {
    const r = rule({ startTime: "22:00", endTime: "02:00" });
    const at2200 = Date.UTC(2026, 6, 27, 14, 0); // 22:00 CST
    const before2159 = Date.UTC(2026, 6, 27, 13, 59); // 21:59 CST
    const at0200 = Date.UTC(2026, 6, 27, 18, 0); // 02:00 CST
    expect(matchesTimeWindow(r, at2200)).toBe(true); // 恰好 start
    expect(matchesTimeWindow(r, before2159)).toBe(false); // start 前
    expect(matchesTimeWindow(r, at0200)).toBe(false); // 恰好 end（>= end 排除）
  });

  it("非跨午夜边界：恰好 start 命中、恰好 end 不命中", () => {
    const r = rule({ startTime: "14:00", endTime: "18:00" });
    const at1400 = Date.UTC(2026, 6, 27, 6, 0); // 14:00 CST
    const at1800 = Date.UTC(2026, 6, 27, 10, 0); // 18:00 CST
    expect(matchesTimeWindow(r, at1400)).toBe(true); // 恰好 start（>= start）
    expect(matchesTimeWindow(r, at1800)).toBe(false); // 恰好 end（< end 排除）
  });

  it("带秒窗口按秒精确匹配，不提前进入或退出", () => {
    const r = rule({ startTime: "09:00:30", endTime: "12:00:30" });
    const at = (hour: number, minute: number, second: number) =>
      Date.UTC(2026, 6, 27, hour - 8, minute, second);
    expect(matchesTimeWindow(r, at(9, 0, 29))).toBe(false);
    expect(matchesTimeWindow(r, at(9, 0, 30))).toBe(true);
    expect(matchesTimeWindow(r, at(12, 0, 29))).toBe(true);
    expect(matchesTimeWindow(r, at(12, 0, 30))).toBe(false);
  });
});

describe("matchMultiplierRule 倍率匹配", () => {
  it("智谱高峰 3 倍：高峰内命中 3，高峰外命中非高峰 2", () => {
    const peak = rule({ id: "peak", multiplier: "3", priority: 10 });
    const offpeak = rule({ id: "offpeak", multiplier: "2", priority: 100, startTime: "00:00", endTime: "23:59" });
    const rules = [offpeak, peak];
    expect(matchMultiplierRule(rules, "res", "glm-5.2", MON_1500_CST)!.multiplier).toBe("3");
    // 非高峰：peak 不命中（时段），offpeak 命中
    expect(matchMultiplierRule(rules, "res", "glm-5.2", MON_2000_CST)!.multiplier).toBe("2");
  });

  it("Kimi 档位：highspeed 模型 3 倍，普通模型不命中", () => {
    const tier = rule({
      id: "tier",
      ruleType: "MODEL_TIER",
      upstreamModel: "kimi-for-coding-highspeed",
      multiplier: "3",
      timezone: null,
      startTime: null,
      endTime: null,
    });
    expect(matchMultiplierRule([tier], "res", "kimi-for-coding-highspeed", MON_1500_CST)!.multiplier).toBe("3");
    expect(matchMultiplierRule([tier], "res", "kimi-k3", MON_1500_CST)).toBeNull();
  });

  it("特异性：资源专属 > 企业默认", () => {
    const enterprise = rule({ id: "ent", multiplier: "2", providerResourceId: null });
    const specific = rule({ id: "spec", multiplier: "5", providerResourceId: "res-x" });
    expect(matchMultiplierRule([enterprise, specific], "res-x", "m", MON_1500_CST)!.multiplier).toBe("5");
    expect(matchMultiplierRule([enterprise, specific], "res-y", "m", MON_1500_CST)!.multiplier).toBe("2");
  });

  it("特异性：模型专属 + 资源&模型双专属 > 仅资源 > 企业默认", () => {
    // 用 MODEL_TIER（无时段干扰）专注验特异性排序
    const enterprise = rule({ id: "ent", ruleType: "MODEL_TIER", multiplier: "2", providerResourceId: null, upstreamModel: null, timezone: null, startTime: null, endTime: null });
    const resOnly = rule({ id: "res", ruleType: "MODEL_TIER", multiplier: "3", providerResourceId: "res-x", upstreamModel: null, timezone: null, startTime: null, endTime: null });
    const modelOnly = rule({ id: "model", ruleType: "MODEL_TIER", multiplier: "4", providerResourceId: null, upstreamModel: "glm-5.2", timezone: null, startTime: null, endTime: null });
    const both = rule({ id: "both", ruleType: "MODEL_TIER", multiplier: "5", providerResourceId: "res-x", upstreamModel: "glm-5.2", timezone: null, startTime: null, endTime: null });
    // res-x + glm-5.2：双专属胜
    expect(matchMultiplierRule([enterprise, resOnly, modelOnly, both], "res-x", "glm-5.2", MON_1500_CST)!.ruleId).toBe("both");
    // res-x + 其他模型：仅资源胜（modelOnly/both 不命中）
    expect(matchMultiplierRule([enterprise, resOnly, modelOnly, both], "res-x", "glm-4", MON_1500_CST)!.ruleId).toBe("res");
    // 其他资源 + glm-5.2：仅模型胜（resOnly/both 不命中）
    expect(matchMultiplierRule([enterprise, resOnly, modelOnly, both], "res-y", "glm-5.2", MON_1500_CST)!.ruleId).toBe("model");
  });

  it("生效区间：历史 attempt 匹配旧版本，不被新规则改写", () => {
    // 用 MODEL_TIER（无时段）专注验 effective_from/to 版本边界
    const oldRule = rule({ id: "old", ruleType: "MODEL_TIER", ruleVersion: "v1", multiplier: "2", effectiveFrom: 0, effectiveTo: 1000, timezone: null, startTime: null, endTime: null });
    const newRule = rule({ id: "new", ruleType: "MODEL_TIER", ruleVersion: "v2", multiplier: "3", effectiveFrom: 1000, timezone: null, startTime: null, endTime: null });
    // attempt 在 500（旧版本生效期）：命中 v1
    expect(matchMultiplierRule([oldRule, newRule], "res", "m", 500)!.ruleVersion).toBe("v1");
    // attempt 在 1500（新版本生效期）：命中 v2
    expect(matchMultiplierRule([oldRule, newRule], "res", "m", 1500)!.ruleVersion).toBe("v2");
    // 历史 attempt 重算（用当时时间）仍得 v1 —— 不被新规则改写
    expect(matchMultiplierRule([oldRule, newRule], "res", "m", 500)!.multiplier).toBe("2");
  });

  it("无规则 → null（调用方按 multiplier=1 原始口径）", () => {
    expect(matchMultiplierRule([], "res", "m", MON_1500_CST)).toBeNull();
  });
});

describe("computeDeductedQuota 套餐扣减", () => {
  it("raw × multiplier，decimal 整数", () => {
    expect(computeDeductedQuota(1000, "3")).toBe("3000");
    expect(computeDeductedQuota(1078, "2")).toBe("2156");
    expect(computeDeductedQuota(500, "1")).toBe("500");
    expect(computeDeductedQuota(333, "1.5")).toBe("500"); // 499.5 → toFixed(0) = 500
  });
});

describe("computeApiCostFromRule API 计价（TRD §10.1）", () => {
  it("cache 命中/未命中/输出分项 × 单价", () => {
    // input=1000, cache=400（命中）, miss=600, output=500
    const cost = computeApiCostFromRule(
      { cacheHitPrice: "0.0000005", cacheMissPrice: "0.000001", outputPrice: "0.000002" },
      1000, 500, 400,
    );
    // 400*0.0000005 + 600*0.000001 + 500*0.000002 = 0.0002+0.0006+0.001 = 0.0018
    expect(cost).toBe("0.00180000");
  });

  it("decimal 精度：大 token 数无浮点误差", () => {
    const cost = computeApiCostFromRule(
      { cacheHitPrice: null, cacheMissPrice: "0.0000001", outputPrice: "0.0000003" },
      123456789, 98765432, 0,
    );
    // 123456789*1e-7 + 98765432*3e-7 = 12.3456789 + 29.6296296 = 41.9753085
    expect(cost).toBe("41.97530850");
  });
});

describe("matchPriceRule 价格规则", () => {
  it("DeepSeek 单条 API_PRICE 两个高峰窗，09:00/12:00/14:00/18:00 边界正确", () => {
    const price = rule({
      id: "deepseek-two-windows",
      ruleType: "API_PRICE",
      timezone: null,
      daysOfWeek: null,
      startTime: null,
      endTime: null,
      timeWindows: [
        {
          timezone: "Asia/Shanghai",
          daysOfWeek: null,
          startTime: "09:00",
          endTime: "12:00",
        },
        {
          timezone: "Asia/Shanghai",
          daysOfWeek: null,
          startTime: "14:00",
          endTime: "18:00",
        },
      ],
      multiplier: null,
      cacheHitPrice: "0.000001",
      cacheMissPrice: "0.000002",
      outputPrice: "0.000004",
    });
    const at = (hour: number) => Date.UTC(2026, 6, 27, hour - 8, 0);
    expect(matchPriceRule([price], "res", "deepseek-chat", at(9))?.id).toBe(price.id);
    expect(matchPriceRule([price], "res", "deepseek-chat", at(12))).toBeNull();
    expect(matchPriceRule([price], "res", "deepseek-chat", at(14))?.id).toBe(price.id);
    expect(matchPriceRule([price], "res", "deepseek-chat", at(18))).toBeNull();
  });

  it("按生效版本匹配 API_PRICE", () => {
    const price = rule({
      id: "p1",
      ruleType: "API_PRICE",
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
    });
    expect(matchPriceRule([price], "res", "m", MON_1500_CST)!.id).toBe("p1");
    expect(matchPriceRule([price], "res", "m", -1)).toBeNull(); // 生效前
  });

  it("资源专属规则：resourceId 不匹配 → 不命中", () => {
    const specific = rule({
      id: "p-specific",
      ruleType: "API_PRICE",
      providerResourceId: "res-A",
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
    });
    // res-A 命中
    expect(matchPriceRule([specific], "res-A", "m", MON_1500_CST)!.id).toBe("p-specific");
    // res-B 不命中（资源专属过滤）
    expect(matchPriceRule([specific], "res-B", "m", MON_1500_CST)).toBeNull();
  });

  it("模型专属规则：upstreamModel 不匹配 → 不命中", () => {
    const specific = rule({
      id: "p-model",
      ruleType: "API_PRICE",
      upstreamModel: "glm-5.2",
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
    });
    expect(matchPriceRule([specific], "res", "glm-5.2", MON_1500_CST)!.id).toBe("p-model");
    // 其他模型不命中（模型专属过滤）
    expect(matchPriceRule([specific], "res", "glm-4", MON_1500_CST)).toBeNull();
  });

  it("effectiveFrom 边界：恰好等于 effectiveFrom → 命中（< 才排除）", () => {
    const price = rule({
      id: "p-eff",
      ruleType: "API_PRICE",
      effectiveFrom: MON_1500_CST,
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
    });
    // 恰好等于 effectiveFrom → 命中（变异 < → <= 会把此 case 改为不命中，测试抓住）
    expect(matchPriceRule([price], "res", "m", MON_1500_CST)!.id).toBe("p-eff");
    // 早 1ms → 不命中
    expect(matchPriceRule([price], "res", "m", MON_1500_CST - 1)).toBeNull();
  });

  it("effectiveTo 过滤：attemptStartedAt >= effectiveTo → 不命中", () => {
    const price = rule({
      id: "p-to",
      ruleType: "API_PRICE",
      effectiveFrom: 0,
      effectiveTo: MON_2000_CST,
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
    });
    // 早于 effectiveTo → 命中
    expect(matchPriceRule([price], "res", "m", MON_1500_CST)!.id).toBe("p-to");
    // 等于 effectiveTo → 不命中（>= effectiveTo 排除；变异 if(false) 会放过，测试抓住）
    expect(matchPriceRule([price], "res", "m", MON_2000_CST)).toBeNull();
    // 晚于 effectiveTo → 不命中
    expect(matchPriceRule([price], "res", "m", MON_2000_CST + 1)).toBeNull();
  });

  it("特异性排序：资源专属 + 模型专属 > 仅资源专属 > 企业默认", () => {
    const def = rule({
      id: "p-default",
      ruleType: "API_PRICE",
      providerResourceId: null,
      upstreamModel: null,
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
      priority: 100,
    });
    const resSpecific = rule({
      id: "p-res",
      ruleType: "API_PRICE",
      providerResourceId: "res-A",
      upstreamModel: null,
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
      priority: 100,
    });
    const resModelSpecific = rule({
      id: "p-res-model",
      ruleType: "API_PRICE",
      providerResourceId: "res-A",
      upstreamModel: "glm-5.2",
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
      priority: 100,
    });
    // 同 priority：资源+模型专属 > 仅资源 > 默认
    const matched = matchPriceRule([def, resSpecific, resModelSpecific], "res-A", "glm-5.2", MON_1500_CST);
    expect(matched!.id).toBe("p-res-model");
  });

  it("DeepSeek 双高峰窗口：[09:00,12:00) 与 [14:00,18:00)，边界正确", () => {
    const base = rule({
      id: "deepseek-base",
      ruleType: "API_PRICE",
      timezone: null,
      startTime: null,
      endTime: null,
      cacheHitPrice: "0.0000005",
      cacheMissPrice: "0.000001",
      outputPrice: "0.000002",
      multiplier: null,
      priority: 100,
    });
    const morning = rule({
      ...base,
      id: "deepseek-peak-am",
      timezone: "Asia/Shanghai",
      startTime: "09:00",
      endTime: "12:00",
      cacheHitPrice: "0.000001",
      cacheMissPrice: "0.000002",
      outputPrice: "0.000004",
      priority: 10,
    });
    const afternoon = rule({
      ...morning,
      id: "deepseek-peak-pm",
      startTime: "14:00",
      endTime: "18:00",
    });
    const at = (hour: number, minute = 0) => Date.UTC(2026, 6, 27, hour - 8, minute);
    const rules = [base, morning, afternoon];

    expect(matchPriceRule(rules, "res", "m", at(9))!.id).toBe("deepseek-peak-am");
    expect(matchPriceRule(rules, "res", "m", at(12))!.id).toBe("deepseek-base");
    expect(matchPriceRule(rules, "res", "m", at(14))!.id).toBe("deepseek-peak-pm");
    expect(matchPriceRule(rules, "res", "m", at(18))!.id).toBe("deepseek-base");
  });

  it("完全重叠规则仍确定性命中：较新生效版本优先，最终按 id 兜底", () => {
    const older = rule({
      id: "rule-z",
      ruleType: "API_PRICE",
      timezone: null,
      startTime: null,
      endTime: null,
      multiplier: null,
      effectiveFrom: 100,
    });
    const newerB = rule({ ...older, id: "rule-b", effectiveFrom: 200 });
    const newerA = rule({ ...newerB, id: "rule-a" });
    expect(matchPriceRule([older, newerB, newerA], "res", "m", 300)!.id).toBe("rule-a");
  });
});
