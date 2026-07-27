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

export interface BillingRule {
  id: string;
  ruleType: "TIME_WINDOW" | "MODEL_TIER" | "CACHE_STATE" | "API_PRICE";
  ruleVersion: string;
  providerResourceId: string | null; // null = 企业级默认
  upstreamModel: string | null; // null = 全部模型
  effectiveFrom: number; // epoch ms
  effectiveTo: number | null;
  timezone: string | null;
  daysOfWeek: number[] | null; // ISO 1=周一..7=周日；null=每天
  startTime: string | null; // "HH:MM"
  endTime: string | null;
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
}

// ===== 时段判定（确定性，注入时钟）=====

/** 把 epoch ms 转成指定时区的「星期 + HH:MM」。仅用 Intl，无外部依赖，可回放。 */
export function toZonedTime(
  epochMs: number,
  timezone: string,
): { dayOfWeek: number; minutesOfDay: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dowMap[get("weekday")] ?? 1;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // Intl hour12:false 偶尔给 24
  const minutesOfDay = hour * 60 + parseInt(get("minute"), 10);
  return { dayOfWeek, minutesOfDay };
}

function parseHHMM(s: string): number {
  const [h = "0", m = "0"] = s.split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

/** 时段规则是否命中（星期 + 起止时间，支持跨午夜如 22:00–02:00）。 */
export function matchesTimeWindow(rule: BillingRule, epochMs: number): boolean {
  if (!rule.timezone || !rule.startTime || !rule.endTime) return false;
  const { dayOfWeek, minutesOfDay } = toZonedTime(epochMs, rule.timezone);
  if (rule.daysOfWeek && !rule.daysOfWeek.includes(dayOfWeek)) return false;
  const start = parseHHMM(rule.startTime);
  const end = parseHHMM(rule.endTime);
  if (start <= end) return minutesOfDay >= start && minutesOfDay < end;
  return minutesOfDay >= start || minutesOfDay < end; // 跨午夜
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
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 资源专属 > 企业默认；模型专属 > 全部
      const aSpecific = (a.providerResourceId !== null ? 2 : 0) + (a.upstreamModel !== null ? 1 : 0);
      const bSpecific = (b.providerResourceId !== null ? 2 : 0) + (b.upstreamModel !== null ? 1 : 0);
      return bSpecific - aSpecific;
    });
  const hit = candidates[0];
  if (!hit || hit.multiplier === null) return null;
  return { ruleId: hit.id, ruleVersion: hit.ruleVersion, multiplier: hit.multiplier };
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
  rule: { cacheHitPrice: string | null; cacheMissPrice: string | null; outputPrice: string | null },
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
  return cost.toFixed(8);
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
      return true;
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aSpecific = (a.providerResourceId !== null ? 2 : 0) + (a.upstreamModel !== null ? 1 : 0);
      const bSpecific = (b.providerResourceId !== null ? 2 : 0) + (b.upstreamModel !== null ? 1 : 0);
      return bSpecific - aSpecific;
    });
  return candidates[0] ?? null;
}

/** 套餐模式费用字段语义（TRD §10.2：PACKAGE_INCLUDED，不写数值 0）。 */
export const PACKAGE_INCLUDED = "PACKAGE_INCLUDED" as const;
