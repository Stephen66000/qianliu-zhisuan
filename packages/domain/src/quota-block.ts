/**
 * Coding Plan 窗口额度阻断记录（计划§4，F1）——纯函数状态机。
 *
 * 职责：定义 provider_resource.quota_block_state 的白名单 schema v1、
 * 耗尽故障合并、按厂商规则的窗口解除条件与下一检查时间推导。
 * 事实落库与事务由 @qianliu/database 仓储承担；本模块无副作用、时钟由调用方注入。
 *
 * 关键规则（计划§2/§4/§5）：
 *   - 正余量才清除窗口；缺失/UNSUPPORTED/FAILED/STALE 不解除。
 *   - unknownWindow（套餐耗尽但窗口无法归属）须当次两窗口均可知且 >0 才解除。
 *   - Kimi 恢复须当次 FIVE_HOUR 与 WEEKLY 均可知且 >0；智谱须 FIVE_HOUR 可知且 >0
 *     且当次返回的其他已知窗口也 >0，且所有已记录阻断窗口当次 >0。
 *   - 不无限回溯旧零值：记录全部解除即清空，下一周期产生新 incident。
 */

export const QUOTA_BLOCK_SCHEMA_VERSION = 1;

export type QuotaBlockWindowType = "FIVE_HOUR" | "WEEKLY";

/** 预计恢复时间来源（计划§3 冻结枚举）。 */
export type QuotaBlockResetSource =
  | "UPSTREAM_RESET_AT"
  | "UPSTREAM_RETRY_AFTER"
  | "PROVIDER_SNAPSHOT"
  | "EXHAUSTION_RECORD";

export const QUOTA_BLOCK_WINDOW_TYPES: readonly QuotaBlockWindowType[] = ["FIVE_HOUR", "WEEKLY"];

export const QUOTA_BLOCK_RESET_SOURCES: readonly QuotaBlockResetSource[] = [
  "UPSTREAM_RESET_AT",
  "UPSTREAM_RETRY_AFTER",
  "PROVIDER_SNAPSHOT",
  "EXHAUSTION_RECORD",
];

/** block 内单个阻断窗口；resetAt 为 null 表示时间未知。 */
export interface QuotaBlockWindow {
  type: QuotaBlockWindowType;
  observedAt: string;
  resetAt: string | null;
  resetSource: QuotaBlockResetSource | null;
}

/** provider_resource.quota_block_state 白名单 schema v1。 */
export interface QuotaBlockState {
  schemaVersion: typeof QUOTA_BLOCK_SCHEMA_VERSION;
  incidentId: string;
  credentialVersion: number | null;
  startedAt: string;
  /** true 表示存在无法归属窗口的套餐阻断（windows 可同时非空）。 */
  unknownWindow: boolean;
  windows: QuotaBlockWindow[];
}

/** 一次明确耗尽故障的观察输入（来自上游响应或新鲜快照）。 */
export interface QuotaExhaustionObservation {
  /** undefined = 只能证明套餐耗尽、无法归属窗口。 */
  windowType?: QuotaBlockWindowType;
  resetAt?: string | null;
  resetSource?: QuotaBlockResetSource | null;
}

/** 一次额度 GET 的单窗口观察。 */
export interface QuotaWindowObservation {
  windowType: QuotaBlockWindowType;
  /** 当次 SUCCESS 且有数值才算已知；缺失/UNSUPPORTED/FAILED/STALE 不作为恢复或解除证据。 */
  known: boolean;
  unsupported: boolean;
  remaining: number | null;
  resetAt: string | null;
}

export interface QuotaObservationOutcome {
  /** null = 阻断全部解除，记录清空。 */
  state: QuotaBlockState | null;
  recovered: boolean;
  changed: boolean;
}

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isResetSource(value: unknown): value is QuotaBlockResetSource {
  return typeof value === "string" && (QUOTA_BLOCK_RESET_SOURCES as readonly string[]).includes(value);
}

/**
 * 严格白名单解析；任何未知字段、非法类型或非法窗口名都拒绝（返回 null）。
 * 调用方对"列非 NULL 但解析失败"必须保守处理（保持阻断、不得自动清除）。
 */
export function parseQuotaBlockState(raw: unknown): QuotaBlockState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const knownKeys = new Set([
    "schemaVersion", "incidentId", "credentialVersion", "startedAt", "unknownWindow", "windows",
  ]);
  if (Object.keys(record).some((key) => !knownKeys.has(key))) return null;
  if (record.schemaVersion !== QUOTA_BLOCK_SCHEMA_VERSION) return null;
  if (typeof record.incidentId !== "string" || record.incidentId.length === 0 || record.incidentId.length > 64) return null;
  if (record.credentialVersion !== null && typeof record.credentialVersion !== "number") return null;
  if (!isIsoString(record.startedAt)) return null;
  if (typeof record.unknownWindow !== "boolean") return null;
  if (!Array.isArray(record.windows)) return null;
  const windows: QuotaBlockWindow[] = [];
  for (const item of record.windows) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const window = item as Record<string, unknown>;
    const windowKeys = new Set(["type", "observedAt", "resetAt", "resetSource"]);
    if (Object.keys(window).some((key) => !windowKeys.has(key))) return null;
    if (typeof window.type !== "string"
      || !(QUOTA_BLOCK_WINDOW_TYPES as readonly string[]).includes(window.type)) return null;
    if (!isIsoString(window.observedAt)) return null;
    if (window.resetAt !== null && !isIsoString(window.resetAt)) return null;
    if (window.resetSource !== null && !isResetSource(window.resetSource)) return null;
    windows.push({
      type: window.type as QuotaBlockWindowType,
      observedAt: window.observedAt,
      resetAt: window.resetAt,
      resetSource: window.resetSource,
    });
  }
  return {
    schemaVersion: QUOTA_BLOCK_SCHEMA_VERSION,
    incidentId: record.incidentId,
    credentialVersion: record.credentialVersion,
    startedAt: record.startedAt,
    unknownWindow: record.unknownWindow,
    windows,
  };
}

export function serializeQuotaBlockState(state: QuotaBlockState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    incidentId: state.incidentId,
    credentialVersion: state.credentialVersion,
    startedAt: state.startedAt,
    unknownWindow: state.unknownWindow,
    windows: state.windows.map((window) => ({
      type: window.type,
      observedAt: window.observedAt,
      resetAt: window.resetAt,
      resetSource: window.resetSource,
    })),
  });
}

function validFutureReset(resetAt: string | null | undefined, now: Date): string | null {
  if (!resetAt) return null;
  const parsed = Date.parse(resetAt);
  return Number.isFinite(parsed) && parsed > now.getTime() ? resetAt : null;
}

/** 合并一次明确耗尽故障：无记录或凭证代次变化时创建新 incident。 */
export function mergeQuotaExhaustion(
  state: QuotaBlockState | null,
  input: {
    incidentId: string;
    credentialVersion: number | null;
    now: Date;
    observation: QuotaExhaustionObservation;
  },
): QuotaBlockState {
  const freshReset = validFutureReset(input.observation.resetAt, input.now);
  const credentialChanged = state === null || state.credentialVersion !== input.credentialVersion;
  if (credentialChanged) {
    return {
      schemaVersion: QUOTA_BLOCK_SCHEMA_VERSION,
      incidentId: input.incidentId,
      credentialVersion: input.credentialVersion,
      startedAt: input.now.toISOString(),
      unknownWindow: input.observation.windowType === undefined,
      windows: input.observation.windowType
        ? [{
          type: input.observation.windowType,
          observedAt: input.now.toISOString(),
          resetAt: freshReset,
          resetSource: freshReset ? (input.observation.resetSource ?? "UPSTREAM_RESET_AT") : null,
        }]
        : [],
    };
  }
  const existing = state!;
  const windows = [...existing.windows];
  if (input.observation.windowType) {
    const type = input.observation.windowType;
    const index = windows.findIndex((window) => window.type === type);
    const previous = index >= 0 ? windows[index] : null;
    const merged: QuotaBlockWindow = {
      type,
      observedAt: input.now.toISOString(),
      // 新故障带回的未来时间优先；否则保留仍在未来的旧时间，失败不抹掉未来日期。
      resetAt: freshReset ?? validFutureReset(previous?.resetAt ?? null, input.now),
      resetSource: freshReset
        ? (input.observation.resetSource ?? "UPSTREAM_RESET_AT")
        : freshReset === null && previous?.resetAt && validFutureReset(previous.resetAt, input.now)
          ? previous.resetSource
          : null,
    };
    if (index >= 0) windows[index] = merged;
    else windows.push(merged);
  }
  return {
    ...existing,
    unknownWindow: existing.unknownWindow || input.observation.windowType === undefined,
    windows,
  };
}

/** 当次 GET 中明确为零（known 且 remaining<=0）的窗口。 */
export function definiteZeroWindows(
  observations: readonly QuotaWindowObservation[],
): QuotaBlockWindowType[] {
  return observations
    .filter((observation) => observation.known && observation.remaining !== null && observation.remaining <= 0)
    .map((observation) => observation.windowType);
}

function knownPositive(
  observations: readonly QuotaWindowObservation[],
  windowType: QuotaBlockWindowType,
): boolean {
  const observation = observations.find((item) => item.windowType === windowType);
  return Boolean(observation?.known && observation.remaining !== null && observation.remaining > 0);
}

/**
 * 应用一次额度 GET 观察：正余量只解除对应窗口；恢复需同时满足厂商必需窗口条件。
 * state 为 null 时观察不产生阻断（新阻断由调用方经 mergeQuotaExhaustion 创建）。
 */
export function applyQuotaObservation(
  state: QuotaBlockState | null,
  providerCode: "kimi" | "zhipu",
  observations: readonly QuotaWindowObservation[],
  now: Date,
): QuotaObservationOutcome {
  if (state === null) return { state: null, recovered: false, changed: false };
  const keptWindows: QuotaBlockWindow[] = [];
  let changed = false;
  for (const window of state.windows) {
    const observation = observations.find((item) => item.windowType === window.type);
    if (observation?.known && observation.remaining !== null && observation.remaining > 0) {
      changed = true; // 正余量解除该窗口
      continue;
    }
    const futureReset = validFutureReset(observation?.resetAt ?? null, now);
    if (observation?.known && futureReset && futureReset !== window.resetAt) {
      // 仍为零的窗口可用当次厂商未来重置点更新日期。
      keptWindows.push({ ...window, resetAt: futureReset, resetSource: "UPSTREAM_RESET_AT" });
      changed = true;
      continue;
    }
    keptWindows.push(window);
  }
  const unknownCleared = knownPositive(observations, "FIVE_HOUR") && knownPositive(observations, "WEEKLY");
  const unknownWindow = state.unknownWindow && !unknownCleared;
  if (unknownWindow !== state.unknownWindow) changed = true;
  const requiredPositive = providerCode === "kimi"
    ? knownPositive(observations, "FIVE_HOUR") && knownPositive(observations, "WEEKLY")
    : knownPositive(observations, "FIVE_HOUR")
      && observations.every((item) => !item.known || (item.remaining !== null && item.remaining > 0));
  const recovered = keptWindows.length === 0 && !unknownWindow && requiredPositive;
  if (recovered) return { state: null, recovered: true, changed: true };
  return {
    state: { ...state, unknownWindow, windows: keptWindows },
    recovered: false,
    changed,
  };
}

/**
 * 当次 GET 是否满足厂商必需窗口的正余量条件（不含 block 记录本身的解除判定）。
 * 也用于无 block 记录的存量 RATE_LIMITED/EXHAUSTED 资源的恢复确认。
 */
export function quotaObservationConfirmsRecovery(
  providerCode: "kimi" | "zhipu",
  observations: readonly QuotaWindowObservation[],
): boolean {
  return providerCode === "kimi"
    ? knownPositive(observations, "FIVE_HOUR") && knownPositive(observations, "WEEKLY")
    : knownPositive(observations, "FIVE_HOUR")
      && observations.every((item) => !item.known || (item.remaining !== null && item.remaining > 0));
}

/**
 * 活跃 block 的下一检查时间（仅调度，永不充当 next_reset_at）：
 * 取已耗尽窗口的最早未来点；未知、已过点或全部缺失时取 now + retryIntervalMs。
 * 无活跃 block 返回 null（健康资源按调用方节流）。
 */
export function nextQuotaCheckAt(
  state: QuotaBlockState | null,
  now: Date,
  retryIntervalMs: number,
): number | null {
  if (state === null) return null;
  const futureResets = state.windows
    .map((window) => validFutureReset(window.resetAt, now))
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .sort((left, right) => left - right);
  return futureResets[0] ?? now.getTime() + retryIntervalMs;
}
