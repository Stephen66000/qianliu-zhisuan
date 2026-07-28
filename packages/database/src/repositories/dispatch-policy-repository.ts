/**
 * 经营调度策略仓储（W16）—— 策略发布 + 决策落库的落库侧。
 *
 * 依据：TRD §9.1 行 609-632、§5.6 行 314-321（dispatch_policy_version）、§5.7 行 342（dispatch_decision 不可覆盖）。
 *
 * 职责边界：
 *   - 判定规则在 @qianliu/domain（dispatch-policy.ts 纯函数：matchPolicy/decideDispatch/computeDispatchSaving）；
 *   - 本仓储做：策略 CRUD（DRAFT→PUBLISHED 状态机）+ 查询已发布策略（热路径）+ 决策落库（幂等，UNIQUE(ai_request_id)）。
 *   - 只有 PUBLISHED 进热路径（§5.6 行 320）；变更只影响新请求（行 321）。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { DispatchPolicy } from "@qianliu/domain";

/** 策略创建输入（管理员发布；状态默认 DRAFT）。 */
export interface CreateDispatchPolicyInput {
  enterpriseId: string;
  status?: "DRAFT" | "VALIDATED" | "PUBLISHED" | "RETIRED";
  matchUnifiedModel: string | null;
  matchResourceMode: "API" | "CODING_PLAN" | null;
  matchProviderResourceId: string | null;
  matchTimezone: string | null;
  matchDaysOfWeek: number[] | null;
  matchStartTime: string | null;
  matchEndTime: string | null;
  matchPriceMultiplierMin: string | null;
  matchRemainingQuotaRatioMax: string | null;
  matchForecastExhaustRisk: boolean | null;
  matchPrincipalScope: string[] | null;
  action: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  switchEquivalentGroup: string[] | null;
  rateLimitPerMinute: number | null;
  policyVersion: string;
  priority?: number;
  description?: string | null;
  source?: string | null;
}

/** 决策落库输入（每次请求前冻结，不可覆盖）。 */
export interface CreateDispatchDecisionInput {
  enterpriseId: string;
  aiRequestId: string;
  dispatchInput: Record<string, unknown> | null;
  matchedPolicyId: string | null;
  matchedPolicyVersion: string | null;
  matchedPolicyAction: string | null;
  finalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  reasonCode: string;
  reasonDetail?: string | null;
  switchTargetResourceId?: string | null;
  counterfactualCost?: string | null;
  actualCost?: string | null;
  dispatchSaving?: string | null;
  savingCalculable?: boolean;
  notCalculableReason?: string | null;
}

export class DispatchPolicyRepository {
  constructor(private db: Kysely<Database>) {}

  /** 创建策略（默认 DRAFT；管理员校验后 PUBLISH）。 */
  async createPolicy(input: CreateDispatchPolicyInput): Promise<string> {
    const row = await this.db
      .insertInto("dispatch_policy")
      .values({
        enterprise_id: input.enterpriseId,
        status: input.status ?? "DRAFT",
        match_unified_model: input.matchUnifiedModel,
        match_resource_mode: input.matchResourceMode,
        match_provider_resource_id: input.matchProviderResourceId,
        match_timezone: input.matchTimezone,
        // jsonb 列需 JSON.stringify（与 billing_rule.days_of_week 同模式）
        match_days_of_week: input.matchDaysOfWeek
          ? (JSON.stringify(input.matchDaysOfWeek) as unknown as number[])
          : null,
        match_start_time: input.matchStartTime,
        match_end_time: input.matchEndTime,
        match_price_multiplier_min: input.matchPriceMultiplierMin,
        match_remaining_quota_ratio_max: input.matchRemainingQuotaRatioMax,
        match_forecast_exhaust_risk: input.matchForecastExhaustRisk,
        match_principal_scope: input.matchPrincipalScope
          ? (JSON.stringify(input.matchPrincipalScope) as unknown as string[])
          : null,
        action: input.action,
        switch_equivalent_group: input.switchEquivalentGroup
          ? (JSON.stringify(input.switchEquivalentGroup) as unknown as string[])
          : null,
        rate_limit_per_minute: input.rateLimitPerMinute,
        policy_version: input.policyVersion,
        priority: input.priority ?? 100,
        description: input.description ?? null,
        source: input.source ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** 更新策略状态（DRAFT→VALIDATED→PUBLISHED；PUBLISHED→RETIRED）。 */
  async updateStatus(policyId: string, status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "RETIRED"): Promise<void> {
    await this.db
      .updateTable("dispatch_policy")
      .set({ status, updated_at: new Date() })
      .where("id", "=", policyId)
      .execute();
  }

  /** 热路径查询：该企业已发布（PUBLISHED）的全部策略（按 priority 升序）。 */
  async listPublishedPolicies(enterpriseId: string): Promise<DispatchPolicy[]> {
    const rows = await this.db
      .selectFrom("dispatch_policy")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "PUBLISHED")
      .orderBy("priority", "asc")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      status: r.status as DispatchPolicy["status"],
      matchUnifiedModel: r.match_unified_model,
      matchResourceMode: r.match_resource_mode as DispatchPolicy["matchResourceMode"],
      matchProviderResourceId: r.match_provider_resource_id,
      matchTimezone: r.match_timezone,
      matchDaysOfWeek: r.match_days_of_week,
      matchStartTime: r.match_start_time,
      matchEndTime: r.match_end_time,
      matchPriceMultiplierMin: r.match_price_multiplier_min,
      matchRemainingQuotaRatioMax: r.match_remaining_quota_ratio_max,
      matchForecastExhaustRisk: r.match_forecast_exhaust_risk,
      matchPrincipalScope: r.match_principal_scope,
      action: r.action as DispatchPolicy["action"],
      switchEquivalentGroup: r.switch_equivalent_group ?? [],
      rateLimitPerMinute: r.rate_limit_per_minute,
      policyVersion: r.policy_version,
      priority: r.priority,
    }));
  }

  /**
   * 决策落库（幂等：UNIQUE(ai_request_id)，重放不重复）。
   * §5.7 行 342：不可覆盖；同请求只一条。
   * @returns 插入的决策 id；若该请求已有决策（重放）返回 null。
   */
  async createDecisionIfAbsent(input: CreateDispatchDecisionInput): Promise<string | null> {
    const existing = await this.db
      .selectFrom("dispatch_decision")
      .select("id")
      .where("ai_request_id", "=", input.aiRequestId)
      .executeTakeFirst();
    if (existing) return null; // 幂等：同请求已有决策
    const row = await this.db
      .insertInto("dispatch_decision")
      .values({
        enterprise_id: input.enterpriseId,
        ai_request_id: input.aiRequestId,
        dispatch_input: input.dispatchInput,
        matched_policy_id: input.matchedPolicyId,
        matched_policy_version: input.matchedPolicyVersion,
        matched_policy_action: input.matchedPolicyAction,
        final_action: input.finalAction,
        reason_code: input.reasonCode,
        reason_detail: input.reasonDetail ?? null,
        switch_target_resource_id: input.switchTargetResourceId ?? null,
        counterfactual_cost: input.counterfactualCost ?? null,
        actual_cost: input.actualCost ?? null,
        dispatch_saving: input.dispatchSaving ?? null,
        saving_calculable: input.savingCalculable ?? true,
        not_calculable_reason: input.notCalculableReason ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** 查询某请求的决策（诊断/WT-16 可解释）。 */
  async getDecision(aiRequestId: string): Promise<{
    id: string;
    dispatch_input: Record<string, unknown> | null;
    final_action: string;
    reason_code: string;
    reason_detail: string | null;
    matched_policy_id: string | null;
    matched_policy_version: string | null;
    matched_policy_action: string | null;
    switch_target_resource_id: string | null;
    counterfactual_cost: string | null;
    actual_cost: string | null;
    dispatch_saving: string | null;
    saving_calculable: boolean;
    not_calculable_reason: string | null;
  } | undefined> {
    return this.db
      .selectFrom("dispatch_decision")
      .selectAll()
      .where("ai_request_id", "=", aiRequestId)
      .executeTakeFirst() as never;
  }
}
