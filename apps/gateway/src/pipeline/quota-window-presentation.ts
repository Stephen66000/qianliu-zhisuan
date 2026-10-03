/**
 * CPQW：窗口额度耗尽的北向呈现（计划§2/§3）——纯函数。
 *
 * 时间规则：每窗口只接受未来时间；整体 next_reset_at = 同资源阻断窗口 max，
 * 任一阻断窗口未知或已过点 → 整体 null；不把下一查询点冒充厂商恢复时间。
 * 中文统一 Asia/Shanghai，跨年补全年份；时间未知不推算（不加 5 小时/7 天）。
 */
import type {
  QuotaBlockErrorDetail,
  QuotaBlockErrorWindow,
  QuotaBlockNotCalculableReason,
} from "@qianliu/contracts";
import type { QuotaBlockState } from "@qianliu/domain";

export type QuotaWindowPresentation = QuotaBlockErrorDetail & {
  message: string;
  /** Retry-After 头（秒）；与 retry_after_ms 同源。 */
  retryAfterSeconds: number | null;
  /** 计划§3 code 映射：仅明确 5 小时用 upstream_window_exhausted。 */
  errorCode: "upstream_window_exhausted" | "upstream_quota_exhausted";
};

/** 呈现输入中的阻断窗口（已按来源标注）。 */
export interface PresentationWindow {
  type: "FIVE_HOUR" | "WEEKLY";
  resetAt: string | null;
  resetSource: "UPSTREAM_RESET_AT" | "UPSTREAM_RETRY_AFTER" | "PROVIDER_SNAPSHOT" | "EXHAUSTION_RECORD" | null;
}

export const QUOTA_WINDOW_LABELS: Readonly<Record<"FIVE_HOUR" | "WEEKLY", string>> = {
  FIVE_HOUR: "5 小时额度",
  WEEKLY: "周额度",
};

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function shanghaiParts(date: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of SHANGHAI_FORMATTER.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

/** "10 月 3 日 01:16"；与当前年份不同时补全 "2027年1月2日 12:00"。 */
export function formatShanghaiResetTime(resetAt: Date, now: Date): string {
  const reset = shanghaiParts(resetAt);
  const current = shanghaiParts(now);
  const hour = reset.hour === "24" ? "00" : reset.hour;
  if (reset.year !== current.year) {
    return `${reset.year}年${reset.month}月${reset.day}日 ${hour}:${reset.minute}`;
  }
  return `${reset.month} 月 ${reset.day} 日 ${hour}:${reset.minute}`;
}

function providerLabel(providerCode: "kimi" | "zhipu"): string {
  return providerCode === "kimi" ? "Kimi " : "智谱 ";
}

/**
 * 复审缺陷 3：生产历史 provider.code 可能是大写 "Kimi"/"Zhipu"（与额度同步/探针
 * 的 canonicalProviderCode 同口径）；窗口合同与文案必须输出 canonical 小写，
 * 否则提示缺厂商名、provider 字段遗漏。
 */
export function canonicalCodingPlanProvider(code: string | null | undefined): "kimi" | "zhipu" | undefined {
  const normalized = (code ?? "").trim().toLowerCase();
  return normalized === "kimi" || normalized === "zhipu" ? normalized : undefined;
}

function futureReset(resetAt: string | null | undefined, now: Date): string | null {
  if (!resetAt) return null;
  const parsed = Date.parse(resetAt);
  return Number.isFinite(parsed) && parsed > now.getTime() ? resetAt : null;
}

/**
 * 构建单资源（RESOURCE）或池级（MODEL_POOL）呈现。
 * storedRecord=true 时 reset_source 显示 EXHAUSTION_RECORD（等待期重复请求/准入拒绝）。
 */
export function buildQuotaWindowPresentation(input: {
  providerCode?: "kimi" | "zhipu";
  windows: readonly PresentationWindow[];
  unknownWindow: boolean;
  now: Date;
  scope?: "RESOURCE" | "MODEL_POOL";
  storedRecord?: boolean;
}): QuotaWindowPresentation {
  if (input.scope === "MODEL_POOL") {
    return {
      quota_block_scope: "MODEL_POOL",
      ...(input.providerCode ? { provider: input.providerCode } : {}),
      quota_windows: [],
      quota_window_unknown: true,
      next_reset_at: null,
      not_calculable_reason: "MULTIPLE_RESOURCE_RESET_TIMES",
      retryable: false,
      message: "套餐资源受阻，整体恢复时间未知，系统将自动检查并恢复服务，请稍后重试。",
      retryAfterSeconds: null,
      errorCode: "upstream_quota_exhausted",
    };
  }

  const windows = [...input.windows].sort(
    (left, right) => (left.type === "FIVE_HOUR" ? -1 : 1) - (right.type === "FIVE_HOUR" ? -1 : 1),
  );
  const detail: QuotaBlockErrorWindow[] = windows.map((window) => ({
    type: window.type,
    // 展示与整体计算都只接受未来时间；已过点的窗口显示 null（正在确认）。
    reset_at: futureReset(window.resetAt, input.now),
    reset_source: window.resetAt
      ? (input.storedRecord ? "EXHAUSTION_RECORD" : window.resetSource)
      : null,
  }));
  const futures = windows
    .map((window) => futureReset(window.resetAt, input.now))
    .filter((value): value is string => value !== null);
  const passed = windows.some((window) => {
    if (!window.resetAt) return false;
    const parsed = Date.parse(window.resetAt);
    return Number.isFinite(parsed) && parsed <= input.now.getTime();
  });
  const anyUnknown = input.unknownWindow || windows.some((window) => futureReset(window.resetAt, input.now) === null);
  const nextResetAt = anyUnknown ? null : (futures.length > 0 ? futures.reduce((max, value) => (value > max ? value : max)) : null);
  const notCalculableReason: QuotaBlockNotCalculableReason | null = nextResetAt !== null
    ? null
    : windows.length === 0 && input.unknownWindow
      ? "PROVIDER_RESET_TIME_UNKNOWN"
      : passed
        ? "PROVIDER_RESET_TIME_PASSED"
        : "PROVIDER_RESET_TIME_UNKNOWN";
  const retryAfterMs = nextResetAt !== null
    ? Math.max(1_000, Math.ceil((Date.parse(nextResetAt) - input.now.getTime()) / 1_000) * 1_000)
    : undefined;

  const knownTypes = windows.map((window) => window.type);
  const hasFive = knownTypes.includes("FIVE_HOUR");
  const hasWeekly = knownTypes.includes("WEEKLY");
  const prefix = input.providerCode ? providerLabel(input.providerCode) : "";
  const windowPhrase = knownTypes.length === 0
    ? `${prefix}厂商套餐额度已用完`
    : hasFive && hasWeekly
      ? `${prefix}厂商 5 小时与周额度已用完`
      : hasFive
        ? `${prefix}厂商 5 小时额度已用完`
        : `${prefix}厂商周额度已用完`;
  let message: string;
  if (nextResetAt !== null) {
    message = `${windowPhrase}，预计 ${formatShanghaiResetTime(new Date(nextResetAt), input.now)}（北京时间）恢复，系统将自动恢复服务，请届时重试。`;
  } else if (passed) {
    message = `${windowPhrase}，已到预计恢复时间，系统正在自动确认，请稍后重试。`;
  } else {
    message = `${windowPhrase}，整体恢复时间暂未知，系统将自动检查并恢复服务，请稍后重试。`;
  }

  return {
    quota_block_scope: "RESOURCE",
    ...(input.providerCode ? { provider: input.providerCode } : {}),
    quota_windows: detail,
    quota_window_unknown: input.unknownWindow,
    next_reset_at: nextResetAt,
    not_calculable_reason: notCalculableReason,
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    retryable: nextResetAt !== null,
    message,
    retryAfterSeconds: nextResetAt !== null && retryAfterMs !== undefined
      ? Math.max(1, Math.ceil(retryAfterMs / 1_000))
      : null,
    errorCode: windows.length === 1 && windows[0]!.type === "FIVE_HOUR" && !input.unknownWindow
      ? "upstream_window_exhausted"
      : "upstream_quota_exhausted",
  };
}

/** 从存储的当前耗尽记录构建呈现（准入/等待期重复请求路径）。 */
export function presentationFromStoredBlock(input: {
  block: QuotaBlockState;
  providerCode?: "kimi" | "zhipu";
  now: Date;
}): QuotaWindowPresentation {
  return buildQuotaWindowPresentation({
    providerCode: input.providerCode,
    windows: input.block.windows.map((window) => ({
      type: window.type,
      resetAt: window.resetAt,
      resetSource: window.resetSource,
    })),
    unknownWindow: input.block.unknownWindow,
    now: input.now,
    storedRecord: true,
  });
}
