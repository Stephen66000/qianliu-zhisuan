/**
 * W11 单元测试：资源池状态机（resource-lifecycle）纯函数。
 *
 * 覆盖：
 *   - 处置矩阵：401→CREDENTIAL_INVALID、402→EXHAUSTED、429→冷却退避、临时故障→熔断阈值
 *   - 退避计算：指数增长、封顶、确定性（同输入同输出，可回放）
 *   - 成功路径：计数清零、UNAVAILABLE 半开成功→DEGRADED（一次成功不抹趋势）
 *   - 准入门禁：ACTIVE/DEGRADED 放行、冷却中拒绝、冷却到期半开探测、终态隔离拒绝
 *   - 幂等：隔离态重复事件不重复迁移
 *   - 恢复边界：CREDENTIAL_INVALID/EXHAUSTED/EXPIRED 仅 adminRecover 可恢复
 *
 * 依据：TRD §9 行 585-598、§5.4 行 243-249；WT-07/19。
 */
import { describe, it, expect } from "vitest";
import {
  RESOURCE_STATUS,
  STATE_REASON,
  RESOURCE_POOL_POLICY,
  computeCooldownMs,
  deriveResourceTransition,
  deriveSuccessTransition,
  deriveCredentialExpiry,
  deriveRefreshFailure,
  deriveAdminRecovery,
  evaluateAdmission,
  type ResourceRuntimeState,
} from "../index.js";

const T0 = 1_800_000_000_000; // 固定时钟（可回放）

function active(overrides: Partial<ResourceRuntimeState> = {}): ResourceRuntimeState {
  return { status: RESOURCE_STATUS.ACTIVE, consecutiveFailures: 0, cooldownUntil: null, ...overrides };
}

describe("computeCooldownMs 指数退避", () => {
  it("指数增长且确定性", () => {
    expect(computeCooldownMs(1, 30_000, 1_800_000)).toBe(30_000);
    expect(computeCooldownMs(2, 30_000, 1_800_000)).toBe(60_000);
    expect(computeCooldownMs(3, 30_000, 1_800_000)).toBe(120_000);
    expect(computeCooldownMs(4, 30_000, 1_800_000)).toBe(240_000);
    // 同输入同输出（无随机抖动，可回放）
    expect(computeCooldownMs(3, 30_000, 1_800_000)).toBe(computeCooldownMs(3, 30_000, 1_800_000));
  });

  it("封顶 cap", () => {
    expect(computeCooldownMs(100, 30_000, 1_800_000)).toBe(1_800_000);
  });
});

describe("deriveResourceTransition 处置矩阵（TRD §9）", () => {
  it("401/403 → CREDENTIAL_INVALID 隔离（仅人工恢复）", () => {
    const t = deriveResourceTransition(active(), "UPSTREAM_CREDENTIAL_INVALID", T0);
    expect(t).not.toBeNull();
    expect(t!.toStatus).toBe(RESOURCE_STATUS.CREDENTIAL_INVALID);
    expect(t!.reason).toBe(STATE_REASON.CREDENTIAL_REJECTED);
    expect(t!.isolates).toBe(true);
    expect(t!.cooldownUntil).toBeNull();
  });

  it("402 → EXHAUSTED 隔离", () => {
    const t = deriveResourceTransition(active(), "UPSTREAM_BILLING_BLOCKED", T0);
    expect(t!.toStatus).toBe(RESOURCE_STATUS.EXHAUSTED);
    expect(t!.reason).toBe(STATE_REASON.BILLING_BLOCKED);
    expect(t!.isolates).toBe(true);
  });

  it("普通 429 无论连续次数都只降级，不触发硬隔离", () => {
    const t1 = deriveResourceTransition(active(), "UPSTREAM_RATE_LIMITED", T0);
    expect(t1!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t1!.reason).toBe(STATE_REASON.RATE_LIMITED);
    expect(t1!.cooldownUntil).toBeNull();
    expect(t1!.isolates).toBe(false);

    const t2 = deriveResourceTransition(
      active({ status: RESOURCE_STATUS.DEGRADED, consecutiveFailures: 1 }),
      "UPSTREAM_RATE_LIMITED",
      T0 + 1_000,
    );
    expect(t2!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t2!.consecutiveFailures).toBe(2);
    expect(t2!.cooldownUntil).toBeNull();

    const t3 = deriveResourceTransition(
      active({ status: RESOURCE_STATUS.DEGRADED, consecutiveFailures: 2 }),
      "UPSTREAM_RATE_LIMITED",
      T0 + 2_000,
    );
    expect(t3!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t3!.cooldownUntil).toBeNull();
    expect(t3!.isolates).toBe(false);
  });

  it("临时故障达到旧阈值后仍保持 DEGRADED + ALLOW", () => {
    const t1 = deriveResourceTransition(active(), "UPSTREAM_TEMPORARY", T0);
    expect(t1!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t1!.reason).toBe(STATE_REASON.PASSIVE_FAILURE);
    expect(t1!.consecutiveFailures).toBe(1);
    expect(t1!.isolates).toBe(false);

    const t2 = deriveResourceTransition(
      active({ status: RESOURCE_STATUS.DEGRADED, consecutiveFailures: RESOURCE_POOL_POLICY.failureThreshold - 1 }),
      "UPSTREAM_TEMPORARY",
      T0,
    );
    expect(t2!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t2!.reason).toBe(STATE_REASON.PASSIVE_FAILURE);
    expect(t2!.isolates).toBe(false);
    expect(t2!.cooldownUntil).toBeNull();
  });

  it("TRANSPORT_ERROR 与 UNKNOWN 只计入健康降级", () => {
    const t = deriveResourceTransition(
      active({ consecutiveFailures: RESOURCE_POOL_POLICY.failureThreshold - 1 }),
      "TRANSPORT_ERROR",
      T0,
    );
    expect(t!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t!.isolates).toBe(false);
  });

  it("客户端/能力/下游/账本错误不计入资源健康", () => {
    for (const c of ["CLIENT_INVALID", "CAPABILITY_UNSUPPORTED", "DOWNSTREAM_AUTH_OR_QUOTA", "LEDGER_FAILURE", "STREAM_INTERRUPTED_AFTER_COMMIT"] as const) {
      expect(deriveResourceTransition(active(), c, T0)).toBeNull();
    }
  });

  it("幂等：CREDENTIAL_INVALID 重复 401 不重复迁移；终态隔离忽略临时故障", () => {
    const isolated = active({ status: RESOURCE_STATUS.CREDENTIAL_INVALID, consecutiveFailures: 1 });
    expect(deriveResourceTransition(isolated, "UPSTREAM_CREDENTIAL_INVALID", T0)).toBeNull();
    expect(deriveResourceTransition(isolated, "UPSTREAM_TEMPORARY", T0)).toBeNull();
    expect(deriveResourceTransition(isolated, "UPSTREAM_RATE_LIMITED", T0)).toBeNull();
    const exhausted = active({ status: RESOURCE_STATUS.EXHAUSTED });
    expect(deriveResourceTransition(exhausted, "UPSTREAM_BILLING_BLOCKED", T0)).toBeNull();
  });
});

describe("deriveSuccessTransition 成功路径", () => {
  it("ACTIVE 无失败 → 无迁移", () => {
    expect(deriveSuccessTransition(active())).toBeNull();
  });

  it("DEGRADED 成功 → ACTIVE 清零", () => {
    const t = deriveSuccessTransition(active({ status: RESOURCE_STATUS.DEGRADED, consecutiveFailures: 2 }));
    expect(t!.toStatus).toBe(RESOURCE_STATUS.ACTIVE);
    expect(t!.consecutiveFailures).toBe(0);
    expect(t!.reason).toBe(STATE_REASON.PASSIVE_SUCCESS);
  });

  it("UNAVAILABLE 半开探测成功 → DEGRADED（一次成功不抹掉长期趋势）", () => {
    const t = deriveSuccessTransition(
      active({ status: RESOURCE_STATUS.UNAVAILABLE, consecutiveFailures: 3, cooldownUntil: T0 - 1 }),
    );
    expect(t!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t!.reason).toBe(STATE_REASON.HALF_OPEN_PROBE_OK);
    expect(t!.consecutiveFailures).toBe(0);
  });

  it("终态隔离资源成功被防御性忽略", () => {
    expect(deriveSuccessTransition(active({ status: RESOURCE_STATUS.CREDENTIAL_INVALID }))).toBeNull();
    expect(deriveSuccessTransition(active({ status: RESOURCE_STATUS.EXHAUSTED }))).toBeNull();
  });
});

describe("evaluateAdmission 准入门禁（硬过滤）", () => {
  it("ACTIVE / DEGRADED 放行", () => {
    expect(evaluateAdmission(active(), T0).admit).toBe(true);
    expect(evaluateAdmission(active({ status: RESOURCE_STATUS.DEGRADED }), T0).admit).toBe(true);
  });

  it("UNAVAILABLE 冷却中拒绝；冷却到期允许半开探测", () => {
    const cooling = active({ status: RESOURCE_STATUS.UNAVAILABLE, cooldownUntil: T0 + 10_000 });
    const blocked = evaluateAdmission(cooling, T0);
    expect(blocked.admit).toBe(false);
    expect(blocked.blockReason).toBe(RESOURCE_STATUS.UNAVAILABLE);

    const probe = evaluateAdmission(cooling, T0 + 10_000);
    expect(probe.admit).toBe(true);
    expect(probe.probe).toBe(true);
  });

  it("终态隔离（CREDENTIAL_INVALID/EXHAUSTED/EXPIRED）拒绝", () => {
    for (const s of [RESOURCE_STATUS.CREDENTIAL_INVALID, RESOURCE_STATUS.EXHAUSTED, RESOURCE_STATUS.EXPIRED] as const) {
      const r = evaluateAdmission(active({ status: s }), T0);
      expect(r.admit).toBe(false);
      expect(r.blockReason).toBe(s);
    }
  });
});

describe("凭证生命周期（WT-19）", () => {
  it("deriveCredentialExpiry：到期 → EXPIRED；未到期/已隔离 → 无迁移", () => {
    expect(deriveCredentialExpiry(active(), T0 + 1, T0)).toBeNull(); // 未到期
    expect(deriveCredentialExpiry(active(), null, T0)).toBeNull(); // 无过期时间（API_KEY）
    const t = deriveCredentialExpiry(active(), T0, T0);
    expect(t!.toStatus).toBe(RESOURCE_STATUS.EXPIRED);
    expect(t!.reason).toBe(STATE_REASON.CREDENTIAL_EXPIRED);
    expect(t!.isolates).toBe(true);
    // 幂等
    expect(deriveCredentialExpiry(active({ status: RESOURCE_STATUS.EXPIRED }), T0, T0 + 1)).toBeNull();
  });

  it("deriveRefreshFailure：刷新失败 → CREDENTIAL_INVALID 隔离；幂等", () => {
    const t = deriveRefreshFailure(active());
    expect(t!.toStatus).toBe(RESOURCE_STATUS.CREDENTIAL_INVALID);
    expect(t!.reason).toBe(STATE_REASON.REFRESH_FAILED);
    expect(deriveRefreshFailure(active({ status: RESOURCE_STATUS.CREDENTIAL_INVALID }))).toBeNull();
  });

  it("deriveAdminRecovery：仅隔离态可恢复，恢复到 DEGRADED（受控）", () => {
    expect(deriveAdminRecovery(active())).toBeNull(); // ACTIVE 不可"恢复"
    expect(deriveAdminRecovery(active({ status: RESOURCE_STATUS.DEGRADED }))).toBeNull();
    for (const s of [RESOURCE_STATUS.CREDENTIAL_INVALID, RESOURCE_STATUS.EXHAUSTED, RESOURCE_STATUS.EXPIRED, RESOURCE_STATUS.UNAVAILABLE] as const) {
      const t = deriveAdminRecovery(active({ status: s, consecutiveFailures: 5 }));
      expect(t!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
      expect(t!.reason).toBe(STATE_REASON.ADMIN_RECOVER);
      expect(t!.consecutiveFailures).toBe(0);
    }
  });
});
