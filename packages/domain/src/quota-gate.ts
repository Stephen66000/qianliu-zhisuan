/**
 * 额度门禁（W14）—— 主体额度判定（纯函数，确定性）。
 *
 * 依据：TRD §5.5（principal_grant / quota_counter）、§9 行 600-607（停止条件）。
 *   - 主体额度耗尽且不允许超额 → REJECT（停止）；
 *   - allow_overage=true → 耗尽后 ALLOW_OVERAGE（产生超额记录）；
 *   - 额度按 deducted_quota（W13 倍率折算后）扣减，不是 raw。
 *
 * 热路径流程（real-pipeline 步骤 3b 前）：
 *   1. evaluateQuotaGate：判定 ALLOW / ALLOW_OVERAGE / REJECT；
 *   2. ALLOW → 预占（quota_counter.used += estimated）；
 *   3. Attempt 后按实际 deducted_quota 校正（多退少补）。
 *
 * 确定性：同输入同输出；时钟注入。金额/token 用 bigint（整数 token）。
 */

/** 门禁判定结果。 */
export const QUOTA_DECISION = {
  ALLOW: "ALLOW", // 额度充足
  ALLOW_OVERAGE: "ALLOW_OVERAGE", // 超额但允许（记录超额）
  REJECT_EXHAUSTED: "REJECT_EXHAUSTED", // 耗尽且不允许超额
  REJECT_NO_GRANT: "REJECT_NO_GRANT", // 无有效授权
  REJECT_GRANT_EXPIRED: "REJECT_GRANT_EXPIRED", // 授权过期/停用
} as const;

export type QuotaDecision = (typeof QUOTA_DECISION)[keyof typeof QUOTA_DECISION];

export interface QuotaGateInput {
  /** 是否存在有效授权（principal_grant）。 */
  hasGrant: boolean;
  /** 授权状态（ACTIVE/EXPIRED/DISABLED）。 */
  grantStatus: "ACTIVE" | "EXPIRED" | "DISABLED" | null;
  /** 授权有效期。 */
  validFrom: number | null;
  validUntil: number | null;
  /** 额度总量（quota_value）。 */
  quotaValue: bigint;
  /** 当前周期已用（quota_counter.used_value）。 */
  usedValue: bigint;
  /** 本请求预估扣减（deducted_quota 预估；结算时按实际校正）。 */
  estimatedCost: bigint;
  /** 是否允许超额。 */
  allowOverage: boolean;
  /** 当前时间（epoch ms，注入）。 */
  now: number;
}

export interface QuotaGateResult {
  decision: QuotaDecision;
  /** 放行后的预计剩余（REJECT 时为当前剩余）。 */
  projectedRemaining: bigint;
  /** 是否产生超额（ALLOW_OVERAGE 时超出部分）。 */
  overageAmount: bigint;
}

/** 额度门禁判定。 */
export function evaluateQuotaGate(input: QuotaGateInput): QuotaGateResult {
  if (!input.hasGrant) {
    return { decision: QUOTA_DECISION.REJECT_NO_GRANT, projectedRemaining: 0n, overageAmount: 0n };
  }
  if (input.grantStatus !== "ACTIVE") {
    return { decision: QUOTA_DECISION.REJECT_GRANT_EXPIRED, projectedRemaining: 0n, overageAmount: 0n };
  }
  if (input.validFrom !== null && input.now < input.validFrom) {
    return { decision: QUOTA_DECISION.REJECT_GRANT_EXPIRED, projectedRemaining: 0n, overageAmount: 0n };
  }
  if (input.validUntil !== null && input.now >= input.validUntil) {
    return { decision: QUOTA_DECISION.REJECT_GRANT_EXPIRED, projectedRemaining: 0n, overageAmount: 0n };
  }

  const remaining = input.quotaValue - input.usedValue;
  const projectedRemaining = remaining - input.estimatedCost;

  if (projectedRemaining >= 0n) {
    return { decision: QUOTA_DECISION.ALLOW, projectedRemaining, overageAmount: 0n };
  }
  // 耗尽
  if (input.allowOverage) {
    return {
      decision: QUOTA_DECISION.ALLOW_OVERAGE,
      projectedRemaining,
      overageAmount: -projectedRemaining, // 超出部分
    };
  }
  return { decision: QUOTA_DECISION.REJECT_EXHAUSTED, projectedRemaining: remaining, overageAmount: 0n };
}

/**
 * 结算校正：预占 estimated，实际 actual。
 * 返回 quota_counter 应有的新 used_value（多退少补，不为负）。
 */
export function settleQuota(usedAfterReserve: bigint, estimated: bigint, actual: bigint): bigint {
  const corrected = usedAfterReserve - estimated + actual;
  return corrected < 0n ? 0n : corrected;
}
