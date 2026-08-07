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

/** Kimi Code 额度接口（官方 CLI 使用）。 */
const KIMI_USAGES_ENDPOINT = "https://api.kimi.com/coding/v1/usages";
/** 智谱 Coding Plan 5 小时额度接口（官方 glm-plan-usage 插件使用）。 */
const ZHIPU_QUOTA_LIMIT_ENDPOINT = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

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
  if (input.mode !== "CODING_PLAN" || (input.providerCode !== "kimi" && input.providerCode !== "zhipu")) {
    return { adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION, providerDataAt: input.now ?? new Date(), windows: [] };
  }
  if (input.providerCode === "kimi") {
    return queryKimiQuota(input);
  }
  return queryZhipuQuota(input);
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

/** 防御性重置时间解析：尝试多个候选字段名（文档未给出确切字段名）。 */
function parseResetAt(raw: unknown): Date | null {
  for (const candidate of [raw]) {
    if (candidate === null || candidate === undefined) continue;
    const date = candidate instanceof Date ? candidate : new Date(String(candidate));
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
): QuotaWindow {
  const obj = (record && typeof record === "object" ? record : {}) as Record<string, unknown>;
  const limit = parseNumber(pickByKeys(obj, ["limit", "limit_value", "total", "tokens_limit", "TOKENS_LIMIT"]));
  const used = parseNumber(pickByKeys(obj, ["used", "used_value", "usage", "tokens_used", "TOKENS_USED"]));
  const remaining = parseNumber(pickByKeys(obj, ["remaining", "remaining_value", "left"]));
  // 厂商只给百分比（智谱 TOKENS_LIMIT）时，把百分比当作 limit=100 的隐含比率。
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
}): Promise<CodingPlanQuotaResult> {
  const fetchImpl = input.fetch ?? (globalThis.fetch as unknown as QuotaFetch);
  const data = await fetchJson(KIMI_USAGES_ENDPOINT, input.credential, fetchImpl, input.timeoutMs ?? 10_000);
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  // Kimi 响应结构文档未给逐字段 schema，按候选 key 防御性解析周/5h 窗口。
  const weeklyRaw = pickByKeys(obj, ["weekly", "week", "weekly_usage", "weeklyQuota"]);
  const fiveHourRaw = pickByKeys(obj, ["five_hour", "fiveHour", "rolling_5h", "rolling5h", "hour5"]);
  const windows: QuotaWindow[] = [];
  const weekly = toWindow(weeklyRaw, "WEEKLY", "POINT", ["reset_at", "resetAt", "expires_at", "next_reset_at"]);
  if (!weekly.unsupported) windows.push(weekly);
  const fiveHour = toWindow(fiveHourRaw, "FIVE_HOUR", "POINT", ["reset_at", "resetAt", "refresh_at", "next_refresh_at"]);
  if (!fiveHour.unsupported) windows.push(fiveHour);
  return {
    adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION,
    providerDataAt: input.now ?? new Date(),
    windows,
  };
}

async function queryZhipuQuota(input: {
  credential: string; fetch?: QuotaFetch; timeoutMs?: number; now?: Date;
}): Promise<CodingPlanQuotaResult> {
  const fetchImpl = input.fetch ?? (globalThis.fetch as unknown as QuotaFetch);
  const data = await fetchJson(ZHIPU_QUOTA_LIMIT_ENDPOINT, input.credential, fetchImpl, input.timeoutMs ?? 10_000);
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  // 智谱 5 小时：TOKENS_LIMIT 是使用百分比（glm-plan-usage 插件口径）。
  const tokensLimit = parseNumber(pickByKeys(obj, ["TOKENS_LIMIT", "tokens_limit", "tokensLimit"]));
  const fiveHour: QuotaWindow = {
    windowType: "FIVE_HOUR",
    limit: tokensLimit !== null ? "100" : null,
    used: tokensLimit,
    remaining: tokensLimit !== null ? String(Math.max(0, 100 - Number(tokensLimit))) : null,
    unit: "PERCENT",
    ratio: tokensLimit !== null ? (Number(tokensLimit) / 100).toFixed(6) : null,
    resetAt: parseResetAt(pickByKeys(obj, ["reset_at", "resetAt", "next_reset_at", "expire_at"])),
    unsupported: tokensLimit === null,
  };
  const windows: QuotaWindow[] = [];
  // 智谱 5h：始终 push——有 TOKENS_LIMIT 显示百分比，缺失则标记 unsupported（前端显示「厂商未提供」）。
  windows.push(fiveHour);
  // 智谱周额度：公开插件未提供实时解析，明确返回 UNSUPPORTED，不伪造。
  windows.push({ windowType: "WEEKLY", limit: null, used: null, remaining: null, unit: "PERCENT", ratio: null, resetAt: null, unsupported: true });
  return {
    adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION,
    providerDataAt: input.now ?? new Date(),
    windows,
  };
}
