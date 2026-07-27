/**
 * W14 单元测试：额度门禁（quota-gate）。
 *
 * 覆盖（TRD §5.5、§9 行 600-607；WT-06）：
 *   - 无授权 / 授权过期 / 授权停用 → REJECT
 *   - 额度充足 → ALLOW
 *   - 耗尽 + 不允许超额 → REJECT_EXHAUSTED（耗尽停止）
 *   - 耗尽 + allow_overage → ALLOW_OVERAGE（记录超额量）
 *   - 结算校正：预占 estimated、实际 actual，多退少补（不为负）
 */
import { describe, it, expect } from "vitest";
import { evaluateQuotaGate, settleQuota, QUOTA_DECISION, type QuotaGateInput } from "../index.js";

const T0 = 1_800_000_000_000;

function input(overrides: Partial<QuotaGateInput> = {}): QuotaGateInput {
  return {
    hasGrant: true,
    grantStatus: "ACTIVE",
    validFrom: T0 - 1000,
    validUntil: T0 + 1_000_000,
    quotaValue: 10000n,
    usedValue: 3000n,
    estimatedCost: 500n,
    allowOverage: false,
    now: T0,
    ...overrides,
  };
}

describe("evaluateQuotaGate 门禁判定", () => {
  it("无授权 → REJECT_NO_GRANT", () => {
    expect(evaluateQuotaGate(input({ hasGrant: false })).decision).toBe(QUOTA_DECISION.REJECT_NO_GRANT);
  });

  it("授权停用/过期 → REJECT_GRANT_EXPIRED", () => {
    expect(evaluateQuotaGate(input({ grantStatus: "DISABLED" })).decision).toBe(QUOTA_DECISION.REJECT_GRANT_EXPIRED);
    expect(evaluateQuotaGate(input({ grantStatus: "EXPIRED" })).decision).toBe(QUOTA_DECISION.REJECT_GRANT_EXPIRED);
    expect(evaluateQuotaGate(input({ validUntil: T0 - 1 })).decision).toBe(QUOTA_DECISION.REJECT_GRANT_EXPIRED); // 已过期
    expect(evaluateQuotaGate(input({ validFrom: T0 + 1000 })).decision).toBe(QUOTA_DECISION.REJECT_GRANT_EXPIRED); // 未生效
  });

  it("额度充足 → ALLOW，剩余正确", () => {
    const r = evaluateQuotaGate(input());
    expect(r.decision).toBe(QUOTA_DECISION.ALLOW);
    expect(r.projectedRemaining).toBe(6500n); // 10000-3000-500
    expect(r.overageAmount).toBe(0n);
  });

  it("恰好耗尽边界：estimated == remaining → ALLOW（剩余 0）", () => {
    const r = evaluateQuotaGate(input({ estimatedCost: 7000n })); // 10000-3000=7000
    expect(r.decision).toBe(QUOTA_DECISION.ALLOW);
    expect(r.projectedRemaining).toBe(0n);
  });

  it("耗尽 + 不允许超额 → REJECT_EXHAUSTED（WT-06 耗尽停止）", () => {
    const r = evaluateQuotaGate(input({ estimatedCost: 7001n }));
    expect(r.decision).toBe(QUOTA_DECISION.REJECT_EXHAUSTED);
    expect(r.overageAmount).toBe(0n);
  });

  it("耗尽 + allow_overage → ALLOW_OVERAGE + 超额量（WT-06 恢复并产生超额记录）", () => {
    const r = evaluateQuotaGate(input({ estimatedCost: 8000n, allowOverage: true }));
    expect(r.decision).toBe(QUOTA_DECISION.ALLOW_OVERAGE);
    expect(r.overageAmount).toBe(1000n); // 8000-7000
    expect(r.projectedRemaining).toBe(-1000n);
  });

  it("已超额状态下继续 allow_overage", () => {
    const r = evaluateQuotaGate(input({ usedValue: 12000n, estimatedCost: 500n, allowOverage: true }));
    expect(r.decision).toBe(QUOTA_DECISION.ALLOW_OVERAGE);
    expect(r.overageAmount).toBe(2500n); // 12000+500-10000
  });
});

describe("settleQuota 结算校正", () => {
  it("实际 > 预估：补扣", () => {
    // 预占后 used=8000（原 3000+估 5000），实际 6000 → 3000+6000=9000
    expect(settleQuota(8000n, 5000n, 6000n)).toBe(9000n);
  });

  it("实际 < 预估：退补", () => {
    expect(settleQuota(8000n, 5000n, 3000n)).toBe(6000n);
  });

  it("实际 = 预估：不变", () => {
    expect(settleQuota(8000n, 5000n, 5000n)).toBe(8000n);
  });

  it("校正不为负（防御）", () => {
    expect(settleQuota(100n, 5000n, 0n)).toBe(0n);
  });
});
