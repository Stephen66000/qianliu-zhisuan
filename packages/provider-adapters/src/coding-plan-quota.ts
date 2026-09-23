/**
 * POOL-032：厂商 Coding Plan 额度窗口查询。
 *
 * 调用厂商官方客户端/插件使用的额度接口，解析 5 小时/周窗口的已用、上限、剩余
 * 和重置时间。这些接口非完整承诺长期稳定的第三方 REST 合约，因此：
 * - 字段防御性解析（number 优先、string 兜底、NaN/负数视为缺失）。
 * - 厂商未提供的窗口返回 UNSUPPORTED，绝不伪造 0 或本地估算。
 * - 凭证只在内存短暂用于 HTTP 头，不进日志/快照/响应。
 * - 严格超时 + 有限重试 + 指数退避，异常不影响 Gateway。
 */
import type { ProviderCode, ResourceMode } from "./model-discovery.js";
import { canonicalProviderCode } from "./provider-code.js";
import { resolveProviderEndpoint } from "./endpoint-policy.js";

/** 窗口类型。 */
export type QuotaWindowType = "FIVE_HOUR" | "WEEKLY";
/** 数值单位：PERCENT=智谱百分比，POINT=Kimi 100 点制；非 token。 */
export type QuotaWindowUnit = "PERCENT" | "POINT";

/** 适配器解析出的单个窗口快照（成功或 UNSUPPORTED，不含失败——失败抛错）。 */
export interface QuotaWindow {
  windowType: QuotaWindowType;
  limit: string | null;
  used: string | null;
  remaining: string | null;
  unit: QuotaWindowUnit;
  /** used/limit 比率字符串（0-1），便于进度条，可空。 */
  ratio: string | null;
  resetAt: Date | null;
  /** UNSUPPORTED=厂商未提供该窗口（如智谱周额度），此时 limit/used/remaining 全为 null。 */
  unsupported: boolean;
}

export interface CodingPlanQuotaResult {
  /** 适配器版本，字段变更时 bump，便于追溯同步失败原因。 */
  adapterVersion: string;
  /** 厂商数据时间（响应中的时间字段，缺失则为请求时刻）。 */
  providerDataAt: Date;
  windows: QuotaWindow[];
}

export class ProviderCodingPlanQuotaError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "INVALID_RESPONSE" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "ProviderCodingPlanQuotaError";
  }
}

export type QuotaFetch = (
  input: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// F-P2-6：额度端点唯一来源为 endpoint-policy 的 CODING_PLAN_QUOTA 分支
//（KIMI/ZHIPU_CODING_PLAN_QUOTA_URL 常量），本文件不再维护硬编码副本。

export const CODING_PLAN_QUOTA_ADAPTER_VERSION = "pool032-v1";

/**
 * 查询厂商 Coding Plan 额度窗口。只对 CODING_PLAN 的 kimi/zhipu 调真实接口；
 * 其他 provider/mode 返回空 windows（调用方据此显示「不适用」）。
 */
export async function queryCodingPlanQuota(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  fetch?: QuotaFetch;
  timeoutMs?: number;
  now?: Date;
}): Promise<CodingPlanQuotaResult> {
  // WP02：canonical code 命中，Kimi/Zhipu 大小写不再掉出额度同步分支。
  const code = canonicalProviderCode(input.providerCode);
  if (input.mode !== "CODING_PLAN" || (code !== "kimi" && code !== "zhipu")) {
    return { adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION, providerDataAt: input.now ?? new Date(), windows: [] };
  }
  // F-P2-6：端点经端点策略（CODING_PLAN_QUOTA）解析，不再本地硬编码双份；
  // 策略未覆盖（理论上不发生：kimi/zhipu 均有 MODE_DEFAULT）时按不适用处理。
  const endpoint = resolveProviderEndpoint({
    providerCode: code,
    resourceMode: input.mode,
    operation: "CODING_PLAN_QUOTA",
    env: process.env,
  });
  if (!endpoint.ok) {
    return { adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION, providerDataAt: input.now ?? new Date(), windows: [] };
  }
  if (code === "kimi") {
    return queryKimiQuota(input, endpoint.url);
  }
  return queryZhipuQuota(input, endpoint.url);
}

async function fetchJson(
  endpoint: string,
  credential: string,
  fetchImpl: QuotaFetch,
  timeoutMs: number,
  retry = 2,
): Promise<unknown> {
  let lastError: ProviderCodingPlanQuotaError | null = null;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new ProviderCodingPlanQuotaError("UNAUTHORIZED", "厂商拒绝当前凭证，请检查 Coding Plan 凭证权限或有效期");
      }
      if (response.status === 429) {
        throw new ProviderCodingPlanQuotaError("RATE_LIMITED", "厂商额度查询被限流，稍后自动重试");
      }
      if (response.status >= 500) {
        throw new ProviderCodingPlanQuotaError("UPSTREAM_UNAVAILABLE", "厂商额度接口暂时不可用");
      }
      if (!response.ok) {
        throw new ProviderCodingPlanQuotaError("INVALID_RESPONSE", `厂商返回非预期状态 ${response.status}`);
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof ProviderCodingPlanQuotaError) {
        // 401/403 不重试（凭证问题）；429/5xx 指数退避重试。
        if (cause.code === "UNAUTHORIZED" || attempt === retry) throw cause;
        lastError = cause;
      } else {
        // abort/网络错误 → TIMEOUT/UPSTREAM，重试。
        lastError = new ProviderCodingPlanQuotaError("UPSTREAM_UNAVAILABLE", "额度查询超时或网络不可用");
        if (attempt === retry) throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ProviderCodingPlanQuotaError("UPSTREAM_UNAVAILABLE", "额度查询重试耗尽");
}

/** 防御性数值解析：number 优先、string→Number 兜底；NaN/负数/null → null。 */
function parseNumber(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return String(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return String(n);
  }
  return null;
}

/** 计算 used/limit 比率（保留 6 位），limit<=0 或缺失返回 null。 */
function computeRatio(used: string | null, limit: string | null): string | null {
  if (used === null || limit === null) return null;
  const u = Number(used);
  const l = Number(limit);
  if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return null;
  const r = Math.min(u / l, 1);
  return r.toFixed(6);
}

/** 防御性重置时间解析：支持 ISO 字符串、Date 对象、Unix 毫秒时间戳（number/string）。 */
function parseResetAt(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return new Date(raw);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    // 纯数字字符串 → Unix 毫秒时间戳。
    if (/^\d+$/.test(s)) return new Date(Number(s));
    const date = new Date(s);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** 从嵌套对象中按候选 key 取值（厂商字段名可能变化）。 */
function pickByKeys(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return null;
}

function toWindow(
  record: unknown,
  windowType: QuotaWindowType,
  unit: QuotaWindowUnit,
  resetKeys: string[],
  limitKeys: string[] = ["limit", "limit_value", "total"],
  usedKeys: string[] = ["used", "used_value", "usage"],
  remainingKeys: string[] = ["remaining", "remaining_value", "left"],
): QuotaWindow {
  const obj = (record && typeof record === "object" ? record : {}) as Record<string, unknown>;
  let limit = parseNumber(pickByKeys(obj, limitKeys));
  let used = parseNumber(pickByKeys(obj, usedKeys));
  let remaining = parseNumber(pickByKeys(obj, remainingKeys));
  // 厂商在 used=0 时可能省略该字段（如 Kimi 5h 窗口重置后只返回 limit+remaining）。
  // 此时从 limit-remaining 推导 used，避免显示空值。
  if (used === null && limit !== null && remaining !== null) {
    used = String(Math.max(0, Number(limit) - Number(remaining)));
  }
  // 反过来 remaining 缺失时也推导。
  if (remaining === null && limit !== null && used !== null) {
    remaining = String(Math.max(0, Number(limit) - Number(used)));
  }
  const hasValues = limit !== null || used !== null || remaining !== null;
  return {
    windowType,
    limit,
    used,
    remaining,
    unit,
    ratio: computeRatio(used, limit),
    resetAt: parseResetAt(pickByKeys(obj, resetKeys)),
    unsupported: !hasValues,
  };
}

async function queryKimiQuota(input: {
  credential: string; fetch?: QuotaFetch; timeoutMs?: number; now?: Date;
}, endpoint: string): Promise<CodingPlanQuotaResult> {
  const fetchImpl = input.fetch ?? (globalThis.fetch as unknown as QuotaFetch);
  const data = await fetchJson(endpoint, input.credential, fetchImpl, input.timeoutMs ?? 10_000);
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  // 周额度：顶层 usage 对象（limit/used/remaining/resetTime）。
  const usageRaw = obj.usage as Record<string, unknown> | undefined;
  const weekly = toWindow(
    usageRaw ?? {},
    "WEEKLY",
    "POINT",
    ["resetTime", "reset_time", "expires_at"],
    ["limit", "total"],
    ["used", "usage"],
    ["remaining", "left"],
  );
  if (!weekly.unsupported) windows.push(weekly);
  // 5 小时额度：limits 数组中 window.duration=300 分钟（5h）的 detail。
  const limitsRaw = Array.isArray(obj.limits) ? obj.limits : [];
  for (const item of limitsRaw) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const window = (entry.window ?? {}) as Record<string, unknown>;
    const detail = (entry.detail ?? {}) as Record<string, unknown>;
    // duration=300 + TIME_UNIT_MINUTE = 滚动 5 小时窗口。
    if (Number(window.duration) === 300) {
      const fiveHour = toWindow(
        detail,
        "FIVE_HOUR",
        "POINT",
        ["resetTime", "reset_time"],
        ["limit", "total"],
        ["used", "usage"],
        ["remaining", "left"],
      );
      if (!fiveHour.unsupported) windows.push(fiveHour);
    }
  }
  return {
    adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION,
    providerDataAt: input.now ?? new Date(),
    windows,
  };
}

async function queryZhipuQuota(input: {
  credential: string; fetch?: QuotaFetch; timeoutMs?: number; now?: Date;
}, endpoint: string): Promise<CodingPlanQuotaResult> {
  const fetchImpl = input.fetch ?? (globalThis.fetch as unknown as QuotaFetch);
  const data = await fetchJson(endpoint, input.credential, fetchImpl, input.timeoutMs ?? 10_000);
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  // 智谱真实结构：{ data: { limits: [ {type, unit, number, percentage, ...} ] } }
  // unit 语义：3=小时(number=5 → 5h窗口)，6=天(number=1 → 周窗口)。
  // percentage 是已用百分比（0-100），limit 固定 100。
  const dataObj = (obj.data ?? obj) as Record<string, unknown>;
  const limitsRaw = Array.isArray(dataObj.limits) ? dataObj.limits : [];
  const windows: QuotaWindow[] = [];
  let fiveHourPercentage: string | null = null;
  let fiveHourReset: Date | null = null;
  let weeklyPercentage: string | null = null;
  let weeklyReset: Date | null = null;
  for (const item of limitsRaw) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const type = String(entry.type ?? "");
    const unit = Number(entry.unit);
    const number = Number(entry.number);
    const percentage = parseNumber(entry.percentage);
    const nextReset = parseResetAt(entry.nextResetTime ?? entry.next_reset_time);
    // TOKENS_LIMIT type：unit=3(小时) number=5 → 5小时窗口；unit=6(天) number=1 → 周窗口。
    if (type === "TOKENS_LIMIT" && percentage !== null) {
      if (unit === 3 && number === 5) {
        fiveHourPercentage = percentage;
        fiveHourReset = nextReset;
      } else if (unit === 6 && number === 1) {
        weeklyPercentage = percentage;
        weeklyReset = nextReset;
      }
    }
  }
  // 5 小时窗口（智谱只提供百分比，limit 固定 100）。
  if (fiveHourPercentage !== null) {
    windows.push({
      windowType: "FIVE_HOUR", limit: "100", used: fiveHourPercentage,
      remaining: String(Math.max(0, 100 - Number(fiveHourPercentage))),
      unit: "PERCENT", ratio: (Number(fiveHourPercentage) / 100).toFixed(6),
      resetAt: fiveHourReset, unsupported: false,
    });
  } else {
    windows.push({ windowType: "FIVE_HOUR", limit: null, used: null, remaining: null, unit: "PERCENT", ratio: null, resetAt: null, unsupported: true });
  }
  // 周窗口（同口径百分比）。
  if (weeklyPercentage !== null) {
    windows.push({
      windowType: "WEEKLY", limit: "100", used: weeklyPercentage,
      remaining: String(Math.max(0, 100 - Number(weeklyPercentage))),
      unit: "PERCENT", ratio: (Number(weeklyPercentage) / 100).toFixed(6),
      resetAt: weeklyReset, unsupported: false,
    });
  } else {
    windows.push({ windowType: "WEEKLY", limit: null, used: null, remaining: null, unit: "PERCENT", ratio: null, resetAt: null, unsupported: true });
  }
  return {
    adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION,
    providerDataAt: input.now ?? new Date(),
    windows,
  };
}
