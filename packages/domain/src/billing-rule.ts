/**
 * 计价规则匹配与计算（W13）—— 版本化、确定性、历史不重算。
 *
 * 依据：
 *   - TRD §10.1（API：cache 命中/未命中/输出分项 × 单价，按 Attempt 开始时间+资源+模型+规则版本）；
 *   - TRD §10.2（套餐：deducted_quota = raw_usage × matched_multiplier；费用字段 PACKAGE_INCLUDED）；
 *   - TRD §10.3（周期重置幂等、未用不结转）；
 *   - 调研文档「厂商额度扣减规则」：倍数不写死，按资源当期生效规则版本匹配；
 *     智谱分时（14:00–18:00 UTC+8 高峰 3 倍/非高峰 2 倍）、Kimi 模型档位（highspeed 3 倍）。
 *
 * 确定性（工程规则 §7）：同输入同输出；时钟由调用方注入（attemptStartedAt）。
 * 金额：decimal.js 十进制，避免浮点精度损失；输出字符串（PostgreSQL numeric）。
 */
import { Decimal } from "decimal.js";

// ===== 规则形状（与 0011 billing_rule 表对应）=====

export const BILLING_RULE_TYPE_W13 = {
  TIME_WINDOW: "TIME_WINDOW", // 分时倍率（智谱高峰）
  MODEL_TIER: "MODEL_TIER", // 模型档位倍率（Kimi highspeed）
  CACHE_STATE: "CACHE_STATE", // 缓存状态价格（DeepSeek 预留）
  API_PRICE: "API_PRICE", // Token 单价
} as const;

export interface BillingRuleWindow {
  timezone: string;
  daysOfWeek: number[] | null; // ISO 1=周一..7=周日；null=每天
  startTime: string; // "HH:MM" 或 "HH:MM:SS"
  endTime: string;
}

export interface BillingRule {
  /** Legacy absolute prices never multiply; multiplier prices freeze base prices in the same version. */
  pricingMode?: "ABSOLUTE" | "MULTIPLIER";
  id: string;
  ruleType: "TIME_WINDOW" | "MODEL_TIER" | "CACHE_STATE" | "API_PRICE";
  ruleVersion: string;
  providerResourceId: string | null; // null = 企业级默认
  upstreamModel: string | null; // null = 全部模型
  effectiveFrom: number; // epoch ms
  effectiveTo: number | null;
  timezone: string | null;
  daysOfWeek: number[] | null; // ISO 1=周一..7=周日；null=每天
  startTime: string | null; // "HH:MM" 或 "HH:MM:SS"
  endTime: string | null;
  /** POOL-001：有序多时间窗；旧数据为空时回退到上面的单窗字段。 */
  timeWindows: BillingRuleWindow[] | null;
  multiplier: string | null; // decimal 字符串
  cacheHitPrice: string | null;
  cacheMissPrice: string | null;
  outputPrice: string | null;
  currency: string;
  priority: number; // 数值小优先
}

/** 匹配结果（冻结到 ledger_line）。 */
export interface RuleMatch {
  ruleId: string;
  ruleVersion: string;
  /** 套餐扣减倍率（无倍数规则时 "1"）。 */
  multiplier: string;
  /** 命中的完整规则，用于把结算事实冻结到账本快照。 */
  rule: BillingRule;
  /** 实际命中的窗口；MODEL_TIER 等无窗口规则为 null。 */
  matchedWindow: BillingRuleWindow | null;
}

// ===== 时段判定（确定性，注入时钟）=====

/** 把 epoch ms 转成指定时区的「星期 + HH:MM:SS」。仅用 Intl，无外部依赖，可回放。 */
export function toZonedTime(
  epochMs: number,
  timezone: string,
): { dayOfWeek: number; minutesOfDay: number; secondsOfDay: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dowMap[get("weekday")] ?? 1;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // Intl hour12:false 偶尔给 24
  const minutesOfDay = hour * 60 + parseInt(get("minute"), 10);
  const secondsOfDay = minutesOfDay * 60 + parseInt(get("second"), 10);
  return { dayOfWeek, minutesOfDay, secondsOfDay };
}

function parseTimeSeconds(s: string): number {
  const [h = "0", m = "0", second = "0"] = s.split(":");
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(second, 10);
}

/** 兼容旧单窗列：新数组优先，旧数据自动投影成单元素数组。 */
export function configuredTimeWindows(rule: BillingRule): BillingRuleWindow[] {
  if (rule.timeWindows && rule.timeWindows.length > 0) return rule.timeWindows;
  if (!rule.timezone || !rule.startTime || !rule.endTime) return [];
  return [{
    timezone: rule.timezone,
    daysOfWeek: rule.daysOfWeek,
    startTime: rule.startTime,
    endTime: rule.endTime,
  }];
}

function matchesWindow(window: BillingRuleWindow, epochMs: number): boolean {
  const { dayOfWeek, secondsOfDay } = toZonedTime(epochMs, window.timezone);
  const start = parseTimeSeconds(window.startTime);
  const end = parseTimeSeconds(window.endTime);
  if (start <= end) {
    if (window.daysOfWeek && !window.daysOfWeek.includes(dayOfWeek)) return false;
    return secondsOfDay >= start && secondsOfDay < end;
  }

  // 跨午夜窗口的星期归属开始日：例如“周一 23:00–02:00”包含周二 01:00。
  // 结束日凌晨段要用前一天判断，避免要求管理员同时勾选周二而产生歧义。
  const startDay = secondsOfDay >= start
    ? dayOfWeek
    : dayOfWeek === 1
      ? 7
      : dayOfWeek - 1;
  if (window.daysOfWeek && !window.daysOfWeek.includes(startDay)) return false;
  return secondsOfDay >= start || secondsOfDay < end;
}

/**
 * 返回实际命中的窗口。多个窗口重叠时按配置数组顺序取第一个；
 * 同一规则内单价/倍率相同，顺序只用于账本解释保持确定性。
 */
export function findMatchedTimeWindow(
  rule: BillingRule,
  epochMs: number,
): BillingRuleWindow | null {
  return configuredTimeWindows(rule).find((window) => matchesWindow(window, epochMs)) ?? null;
}

/** 时段规则是否命中（任一窗口；边界 [start,end)，支持跨午夜）。 */
export function matchesTimeWindow(rule: BillingRule, epochMs: number): boolean {
  return findMatchedTimeWindow(rule, epochMs) !== null;
}

function scopeSpecificity(rule: BillingRule): number {
  return (rule.providerResourceId !== null ? 2 : 0) + (rule.upstreamModel !== null ? 1 : 0);
}

/**
 * 所有计价规则共用的确定性顺序：
 * priority（小优先）→ 资源/模型特异性 → 时窗特异性 → 较新生效版本 → id。
 *
 * 最后以 id 兜底，保证即使管理员配置了完全重叠的同优先级规则，同一输入仍唯一命中。
 */
function compareRulePrecedence(a: BillingRule, b: BillingRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const scope = scopeSpecificity(b) - scopeSpecificity(a);
  if (scope !== 0) return scope;
  const timeWindow = Number(configuredTimeWindows(b).length > 0)
    - Number(configuredTimeWindows(a).length > 0);
  if (timeWindow !== 0) return timeWindow;
  if (a.effectiveFrom !== b.effectiveFrom) return b.effectiveFrom - a.effectiveFrom;
  return a.id.localeCompare(b.id);
}

/**
 * 匹配套餐扣减倍率规则。
 * 候选顺序：优先级（数值小优先）→ 资源专属优先于企业默认 → 模型专属优先于全部模型。
 * 返回命中的最高优先级倍率；无规则时 multiplier="1"（原始口径，不折算）。
 */
export function matchMultiplierRule(
  rules: BillingRule[],
  resourceId: string,
  upstreamModel: string,
  attemptStartedAt: number,
): RuleMatch | null {
  const candidates = rules
    .filter((r) => {
      if (r.ruleType !== "TIME_WINDOW" && r.ruleType !== "MODEL_TIER") return false;
      if (r.providerResourceId !== null && r.providerResourceId !== resourceId) return false;
      if (r.upstreamModel !== null && r.upstreamModel !== upstreamModel) return false;
      if (attemptStartedAt < r.effectiveFrom) return false;
      if (r.effectiveTo !== null && attemptStartedAt >= r.effectiveTo) return false;
      if (r.ruleType === "TIME_WINDOW") return matchesTimeWindow(r, attemptStartedAt);
      return true; // MODEL_TIER 只按模型匹配
    })
    .sort(compareRulePrecedence);
  const hit = candidates[0];
  if (!hit || hit.multiplier === null) return null;
  return {
    ruleId: hit.id,
    ruleVersion: hit.ruleVersion,
    multiplier: hit.multiplier,
    rule: hit,
    matchedWindow: hit.ruleType === "TIME_WINDOW"
      ? findMatchedTimeWindow(hit, attemptStartedAt)
      : null,
  };
}

// ===== 计算 =====

/** 套餐扣减：raw_usage × multiplier（decimal 精度，整数 token）。 */
export function computeDeductedQuota(rawUsage: number, multiplier: string): string {
  return new Decimal(rawUsage).times(new Decimal(multiplier)).toFixed(0);
}

/**
 * API 计价（TRD §10.1）：
 *   api_cost = cache_hit_input × hit_price + cache_miss_input × miss_price + output × output_price
 * cache = cache 命中 input；cache_miss_input = input - cache。
 * 价格取匹配到的 API_PRICE 规则（缺失分项按 0 处理）。
 */
export function computeApiCostFromRule(
  rule: { cacheHitPrice: string | null; cacheMissPrice: string | null; outputPrice: string | null;
    pricingMode?: "ABSOLUTE" | "MULTIPLIER"; multiplier?: string | null },
  input: number,
  output: number,
  cache: number,
): string {
  const hit = new Decimal(cache);
  const miss = new Decimal(input).minus(hit);
  const cost = hit
    .times(new Decimal(rule.cacheHitPrice ?? "0"))
    .plus(miss.times(new Decimal(rule.cacheMissPrice ?? "0")))
    .plus(new Decimal(output).times(new Decimal(rule.outputPrice ?? "0")));
  if (rule.pricingMode === "MULTIPLIER") {
    if (!rule.multiplier || !new Decimal(rule.multiplier).gt(0)
      || [rule.cacheHitPrice, rule.cacheMissPrice, rule.outputPrice].some((value) => value === null)) {
      throw new Error("incomplete_multiplier_price");
    }
    return cost.times(rule.multiplier).toFixed(8);
  }
  return cost.toFixed(8);
}

/** Absolute time-window prices have no factual scalar ratio; never infer one. */
export function billingPriceMultiplier(rule: BillingRule | null): string | null {
  if (!rule) return null;
  if (rule.ruleType !== "API_PRICE") return rule.multiplier;
  if (rule.pricingMode === "MULTIPLIER") return rule.multiplier;
  return configuredTimeWindows(rule).length === 0 ? "1" : null;
}

/** 匹配套餐/API 价格规则（API_PRICE 类型，按生效版本）。 */
export function matchPriceRule(
  rules: BillingRule[],
  resourceId: string,
  upstreamModel: string,
  attemptStartedAt: number,
): BillingRule | null {
  const candidates = rules
    .filter((r) => {
      if (r.ruleType !== "API_PRICE") return false;
      if (r.providerResourceId !== null && r.providerResourceId !== resourceId) return false;
      if (r.upstreamModel !== null && r.upstreamModel !== upstreamModel) return false;
      if (attemptStartedAt < r.effectiveFrom) return false;
      if (r.effectiveTo !== null && attemptStartedAt >= r.effectiveTo) return false;
      const hasWindow = configuredTimeWindows(r).length > 0;
      if (hasWindow && !matchesTimeWindow(r, attemptStartedAt)) return false;
      return true;
    })
    .sort(compareRulePrecedence);
  return candidates[0] ?? null;
}

export type BillingResourceMode = "API" | "CODING_PLAN";

/**
 * 资源进入目录、授权或调用前必须命中的统一计费适用性合同。
 *
 * API 只接受至少配置一个 Token 单价的 API_PRICE；套餐只接受配置了倍率的
 * TIME_WINDOW／MODEL_TIER。随后统一复用正式匹配器校验资源、上游型号、版本
 * 生效区间与时间窗，避免管理面把真实结算不能使用的规则误判为就绪。
 */
export function matchApplicableBillingRule(
  rules: BillingRule[],
  resourceId: string,
  upstreamModel: string,
  resourceMode: BillingResourceMode,
  at: number,
): BillingRule | null {
  if (resourceMode === "API") {
    return matchPriceRule(
      rules.filter((rule) => rule.cacheHitPrice !== null
        || rule.cacheMissPrice !== null
        || rule.outputPrice !== null),
      resourceId,
      upstreamModel,
      at,
    );
  }
  return matchMultiplierRule(
    rules.filter((rule) => rule.multiplier !== null),
    resourceId,
    upstreamModel,
    at,
  )?.rule ?? null;
}

/** 套餐模式费用字段语义（TRD §10.2：PACKAGE_INCLUDED，不写数值 0）。 */
export const PACKAGE_INCLUDED = "PACKAGE_INCLUDED" as const;
