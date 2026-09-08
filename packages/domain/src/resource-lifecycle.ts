import type { ErrorClassification } from "./index.js";

/**
 * 资源池状态机（W11）—— 凭证生命周期与熔断/冷却/半开。
 *
 * 依据：
 *   - TRD §5.4 行 243-249（状态枚举、凭证刷新字段、健康/冷却字段）
 *   - TRD §9 行 585-598（错误分类 → 资源处置；熔断/冷却/半开）
 *   - TRD §14 行 833（401 → 标记凭证失效，尝试同池账号）
 *   - WT-07（套餐账号失效切换同池账号）、WT-19（刷新失败仅隔离对应资源；重新授权后受控恢复）
 *
 * 设计原则（工程规则 §7）：确定性、可回放、无 LLM 参与热路径。
 * 状态字段存 PostgreSQL（事实源）；本模块只做纯函数推导，副作用由仓储落库。
 *
 * 处置矩阵（deriveResourceTransition）：
 *   - 成功                        → 连续失败清零；UNAVAILABLE(冷却期)+成功 → DEGRADED（一次成功不抹掉趋势，TRD §9 行 598）
 *   - UPSTREAM_CREDENTIAL_INVALID → CREDENTIAL_INVALID（隔离；仅人工恢复，WT-19）
 *   - UPSTREAM_RATE_LIMITED       → RATE_LIMITED 短时冷却；同一波并发 429 去重，
 *                                   冷却到期仅允许一个半开探针
 *   - UPSTREAM_BILLING_BLOCKED    → EXHAUSTED（隔离；仅人工恢复）
 *   - UPSTREAM_TEMPORARY/TRANSPORT→ 连续失败+1 且只保持 DEGRADED，不产生硬隔离
 *   - 客户端/能力/账本类错误       → 不计入资源健康
 *
 * 恢复边界：
 *   - CREDENTIAL_INVALID / EXHAUSTED：默认只能 adminRecover；Coding Plan 厂商额度接口
 *     当次确认凭证有效且所有窗口有余量时，可由 deriveQuotaSyncRecovery 恢复
 *   - UNAVAILABLE：冷却到期 → 半开探测（evaluateAdmission）；探测成功 → DEGRADED
 *   - EXPIRED：凭证过期时间到达由 deriveCredentialExpiry 标记
 */

// ===== 状态与原因枚举 =====

/** provider_resource.status（与 0005 迁移 CHECK 一致）。 */
export const RESOURCE_STATUS = {
  ACTIVE: "ACTIVE",
  DEGRADED: "DEGRADED",
  EXHAUSTED: "EXHAUSTED",
  EXPIRED: "EXPIRED",
  CREDENTIAL_INVALID: "CREDENTIAL_INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ResourceStatus = (typeof RESOURCE_STATUS)[keyof typeof RESOURCE_STATUS];

/** 首页、告警与运维共用的严重度顺序；数值越大越需要优先处理。 */
export const RESOURCE_STATUS_SEVERITY: Readonly<Record<ResourceStatus, number>> = {
  ACTIVE: 0,
  DEGRADED: 1,
  RATE_LIMITED: 2,
  UNAVAILABLE: 3,
  EXHAUSTED: 4,
  EXPIRED: 5,
  CREDENTIAL_INVALID: 6,
};

export function worstResourceStatus(statuses: readonly ResourceStatus[]): ResourceStatus {
  return statuses.reduce<ResourceStatus>(
    (worst, status) => RESOURCE_STATUS_SEVERITY[status] > RESOURCE_STATUS_SEVERITY[worst]
      ? status
      : worst,
    RESOURCE_STATUS.ACTIVE,
  );
}

/** 状态迁移原因（resource_status_event.reason；检索/审计用稳定枚举）。 */
export const STATE_REASON = {
  PASSIVE_SUCCESS: "PASSIVE_SUCCESS", // 被动请求成功
  PASSIVE_FAILURE: "PASSIVE_FAILURE", // 未达阈值的失败计数
  CREDENTIAL_REJECTED: "CREDENTIAL_REJECTED", // 上游 401/403
  RATE_LIMITED: "RATE_LIMITED", // 429
  BILLING_BLOCKED: "BILLING_BLOCKED", // 余额/套餐耗尽
  FAILURE_THRESHOLD: "FAILURE_THRESHOLD", // 连续失败达阈值熔断
  CREDENTIAL_EXPIRED: "CREDENTIAL_EXPIRED", // 凭证到期
  REFRESH_FAILED: "REFRESH_FAILED", // 刷新失败（WT-19 隔离）
  ADMIN_RECOVER: "ADMIN_RECOVER", // 人工受控恢复（重新授权/充值后）
  QUOTA_SYNC_RECOVERED: "QUOTA_SYNC_RECOVERED", // 厂商额度接口确认凭证有效且窗口已恢复
  BALANCE_SYNC_RECOVERED: "BALANCE_SYNC_RECOVERED", // API 厂商余额接口确认已有可用余额
  HALF_OPEN_PROBE_OK: "HALF_OPEN_PROBE_OK", // 半开探测成功
} as const;

export type StateReason = (typeof STATE_REASON)[keyof typeof STATE_REASON];

export const CREDENTIAL_REFRESH_STATUS = {
  OK: "OK",
  REFRESHING: "REFRESHING",
  FAILED: "FAILED",
} as const;

export type CredentialRefreshStatus =
  (typeof CREDENTIAL_REFRESH_STATUS)[keyof typeof CREDENTIAL_REFRESH_STATUS];

// ===== 版本化参数（W11 冻结；调整需 Planning Change）=====

export const RESOURCE_POOL_POLICY = {
  /** 连续临时故障熔断阈值（TRD §9 行 598「连续失败达到阈值进入熔断」）。 */
  failureThreshold: 3,
  /** 上游未返回 Retry-After 时的 429 默认冷却毫秒。 */
  rateLimitCooldownBaseMs: 30_000,
  /** 熔断冷却基准毫秒。 */
  breakerCooldownBaseMs: 60_000,
  /** 冷却上限毫秒（退避封顶）。 */
  cooldownCapMs: 30 * 60_000,
  /** 五小时窗口的厂商时间允许 1 小时容差；超界值按此上限重新确认。 */
  providerWindowCooldownMaxMs: 6 * 60 * 60_000,
  version: "pool014-v3",
} as const;

// ===== 纯函数推导 =====

export interface ResourceRuntimeState {
  status: ResourceStatus;
  consecutiveFailures: number;
  cooldownUntil: number | null; // epoch ms
}

export interface StateTransition {
  toStatus: ResourceStatus;
  reason: StateReason;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  /** 该迁移是否暂时或永久阻止普通请求准入。 */
  isolates: boolean;
}

/** 把厂商返回的额度窗口恢复时间限制在可复核的可信范围内。 */
export function clampProviderWindowRecoveryAt(now: number, recoverAt: number): number {
  return Math.min(
    Math.max(now + 1_000, recoverAt),
    now + RESOURCE_POOL_POLICY.providerWindowCooldownMaxMs,
  );
}

const ISOLATED_STATUSES: ReadonlySet<ResourceStatus> = new Set([
  RESOURCE_STATUS.CREDENTIAL_INVALID,
  RESOURCE_STATUS.EXHAUSTED,
  RESOURCE_STATUS.EXPIRED,
  RESOURCE_STATUS.RATE_LIMITED,
  RESOURCE_STATUS.UNAVAILABLE,
]);

/** 指数退避冷却：base × 2^(failures-1)，封顶 cap。确定性，无随机抖动（可回放）。 */
export function computeCooldownMs(failures: number, baseMs: number, capMs: number): number {
  const exp = Math.max(0, failures - 1);
  return Math.min(baseMs * 2 ** exp, capMs);
}

/**
 * 被动请求失败 → 资源状态迁移。
 * 返回 null 表示该事件不改变资源状态（如客户端错误、隔离态下的重复 401）。
 *
 * @param state  当前资源运行状态
 * @param classification  Adapter classifyUpstreamError 输出（TRD §9）
 * @param now    epoch ms（调用方注入时钟，保证可回放）
 */
export function deriveResourceTransition(
  state: ResourceRuntimeState,
  classification: ErrorClassification,
  now: number,
  options: { retryAfterMs?: number; cooldownUntil?: number } = {},
): StateTransition | null {
  const terminallyIsolated =
    state.status === RESOURCE_STATUS.CREDENTIAL_INVALID ||
    state.status === RESOURCE_STATUS.EXHAUSTED ||
    state.status === RESOURCE_STATUS.EXPIRED;

  switch (classification) {
    case "UPSTREAM_CREDENTIAL_INVALID":
      // 已隔离则幂等（不重复迁移、不重复审计）
      if (state.status === RESOURCE_STATUS.CREDENTIAL_INVALID) return null;
      return {
        toStatus: RESOURCE_STATUS.CREDENTIAL_INVALID,
        reason: STATE_REASON.CREDENTIAL_REJECTED,
        consecutiveFailures: state.consecutiveFailures + 1,
        cooldownUntil: null,
        isolates: true,
      };

    case "UPSTREAM_BILLING_BLOCKED":
      if (state.status === RESOURCE_STATUS.EXHAUSTED) return null;
      return {
        toStatus: RESOURCE_STATUS.EXHAUSTED,
        reason: STATE_REASON.BILLING_BLOCKED,
        consecutiveFailures: state.consecutiveFailures + 1,
        cooldownUntil: null,
        isolates: true,
      };

    case "UPSTREAM_RATE_LIMITED": {
      // 同一冷却窗口内的并发 429 是一个故障波次：不重复累计失败，
      // 不指数放大冷却。冷却到期后的单探针若再次 429，才进入新波次。
      if (terminallyIsolated) return null;
      if (
        state.status === RESOURCE_STATUS.RATE_LIMITED
        && state.cooldownUntil !== null
        && now < state.cooldownUntil
      ) return null;
      const failures = state.consecutiveFailures + 1;
      const cooldownUntil = options.cooldownUntil === undefined
        ? now + Math.min(
          Math.max(
            1_000,
            options.retryAfterMs ?? RESOURCE_POOL_POLICY.rateLimitCooldownBaseMs,
          ),
          RESOURCE_POOL_POLICY.cooldownCapMs,
        )
        : clampProviderWindowRecoveryAt(now, options.cooldownUntil);
      return {
        toStatus: RESOURCE_STATUS.RATE_LIMITED,
        reason: STATE_REASON.RATE_LIMITED,
        consecutiveFailures: failures,
        cooldownUntil,
        isolates: true,
      };
    }

    case "UPSTREAM_TEMPORARY":
    case "TRANSPORT_ERROR":
    case "UNKNOWN": {
      if (terminallyIsolated) return null;
      const failures = state.consecutiveFailures + 1;
      // RA-W04：技术失败无论连续多少次都只降级／预警；不得以失败次数触发硬熔断。
      return {
        toStatus: RESOURCE_STATUS.DEGRADED,
        reason: STATE_REASON.PASSIVE_FAILURE,
        consecutiveFailures: failures,
        cooldownUntil: null,
        isolates: false,
      };
    }

    // 客户端/能力/下游/账本类错误不计入资源健康
    default:
      return null;
  }
}

/**
 * 厂商额度接口只能证明额度状态，不能证明 Chat 鉴权状态。
 * 因此仅额度类隔离可据此恢复；CREDENTIAL_INVALID 必须由同凭证 Chat 探测
 * 或管理员轮换凭证解除，避免“额度成功 → 投流 → 再次 401”的循环。
 */
export function deriveQuotaSyncRecovery(state: ResourceRuntimeState): StateTransition | null {
  if (
    state.status !== RESOURCE_STATUS.RATE_LIMITED
    && state.status !== RESOURCE_STATUS.EXHAUSTED
  ) return null;
  return {
    toStatus: RESOURCE_STATUS.DEGRADED,
    reason: STATE_REASON.QUOTA_SYNC_RECOVERED,
    consecutiveFailures: 0,
    cooldownUntil: null,
    isolates: false,
  };
}

/** API 厂商余额在状态故障之后确认为正数，先恢复到可服务的降级态。 */
export function deriveBalanceSyncRecovery(state: ResourceRuntimeState): StateTransition | null {
  if (state.status !== RESOURCE_STATUS.EXHAUSTED) return null;
  return {
    toStatus: RESOURCE_STATUS.DEGRADED,
    reason: STATE_REASON.BALANCE_SYNC_RECOVERED,
    consecutiveFailures: 0,
    cooldownUntil: null,
    isolates: false,
  };
}

/** 被动请求成功 → 状态迁移（成功路径与错误路径分开，语义清晰）。 */
export function deriveSuccessTransition(state: ResourceRuntimeState): StateTransition | null {
  if (state.status === RESOURCE_STATUS.ACTIVE && state.consecutiveFailures === 0) return null;
  if (
    state.status === RESOURCE_STATUS.CREDENTIAL_INVALID ||
    state.status === RESOURCE_STATUS.EXHAUSTED ||
    state.status === RESOURCE_STATUS.EXPIRED
  )
    return null; // 终态隔离资源不会被路由到；防御性忽略
  if (
    state.status === RESOURCE_STATUS.UNAVAILABLE
    || state.status === RESOURCE_STATUS.RATE_LIMITED
  ) {
    // 半开探测成功 → DEGRADED（一次成功不抹掉长期趋势，TRD §9 行 598）
    return {
      toStatus: RESOURCE_STATUS.DEGRADED,
      reason: STATE_REASON.HALF_OPEN_PROBE_OK,
      consecutiveFailures: 0,
      cooldownUntil: null,
      isolates: false,
    };
  }
  // DEGRADED/ACTIVE 带失败计数 → 清零恢复 ACTIVE
  return {
    toStatus: RESOURCE_STATUS.ACTIVE,
    reason: STATE_REASON.PASSIVE_SUCCESS,
    consecutiveFailures: 0,
    cooldownUntil: null,
    isolates: false,
  };
}

/**
 * 准入门禁（路由硬过滤前置，W12 评分在此过滤之后）：
 * 资源当前是否可接收新请求。
 * UNAVAILABLE / RATE_LIMITED 且冷却到期 → 允许半开探测（probe=true）。
 */
export function evaluateAdmission(
  state: ResourceRuntimeState,
  now: number,
): { admit: boolean; probe: boolean; blockReason: ResourceStatus | null } {
  switch (state.status) {
    case RESOURCE_STATUS.ACTIVE:
    case RESOURCE_STATUS.DEGRADED:
      return { admit: true, probe: false, blockReason: null };
    case RESOURCE_STATUS.UNAVAILABLE:
    case RESOURCE_STATUS.RATE_LIMITED:
      if (state.cooldownUntil !== null && now >= state.cooldownUntil) {
        return { admit: true, probe: true, blockReason: null }; // 半开探测窗口
      }
      return { admit: false, probe: false, blockReason: state.status };
    default:
      return { admit: false, probe: false, blockReason: state.status };
  }
}

/** 凭证到期检查（WT-19：OAuth/套餐凭证到期隔离）。到期才迁移，幂等。 */
export function deriveCredentialExpiry(
  state: ResourceRuntimeState,
  credentialExpiresAt: number | null,
  now: number,
): StateTransition | null {
  if (credentialExpiresAt === null) return null;
  if (now < credentialExpiresAt) return null;
  if (state.status === RESOURCE_STATUS.EXPIRED || state.status === RESOURCE_STATUS.CREDENTIAL_INVALID)
    return null;
  return {
    toStatus: RESOURCE_STATUS.EXPIRED,
    reason: STATE_REASON.CREDENTIAL_EXPIRED,
    consecutiveFailures: state.consecutiveFailures,
    cooldownUntil: null,
    isolates: true,
  };
}

/** 刷新失败 → 隔离（WT-19：仅隔离对应资源）。 */
export function deriveRefreshFailure(state: ResourceRuntimeState): StateTransition | null {
  if (state.status === RESOURCE_STATUS.CREDENTIAL_INVALID) return null;
  return {
    toStatus: RESOURCE_STATUS.CREDENTIAL_INVALID,
    reason: STATE_REASON.REFRESH_FAILED,
    consecutiveFailures: state.consecutiveFailures + 1,
    cooldownUntil: null,
    isolates: true,
  };
}

/**
 * 人工受控恢复（WT-19：重新授权/充值后 admin 触发）。
 * 只允许从隔离态恢复；恢复到 DEGRADED（需探测确认后才回 ACTIVE）。
 */
export function deriveAdminRecovery(state: ResourceRuntimeState): StateTransition | null {
  if (!ISOLATED_STATUSES.has(state.status)) return null;
  return {
    toStatus: RESOURCE_STATUS.DEGRADED,
    reason: STATE_REASON.ADMIN_RECOVER,
    consecutiveFailures: 0,
    cooldownUntil: null,
    isolates: false,
  };
}
