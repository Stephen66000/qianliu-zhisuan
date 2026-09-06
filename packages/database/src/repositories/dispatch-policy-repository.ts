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
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import type { DispatchPolicy } from "@qianliu/domain";
import { resolveResourceOperatingInput } from "./dispatch-operating-input.js";
import { policyPricingReadiness } from "./dispatch-pricing-readiness.js";
import {
  copyRetiredPolicyAsDraft,
  restoreRetiredPolicyAsPublished,
} from "./dispatch-policy-clone.js";
import { mapPolicy } from "./dispatch-policy-mapping.js";

export interface DispatchPolicyRecord extends DispatchPolicy {
  archivedAt: Date | null;
  version: number;
  description: string | null;
  source: string | null;
  copiedFromPolicyId: string | null;
  createdByAdminId: string | null;
  validatedAt: Date | null;
  validatedByAdminId: string | null;
  publishedAt: Date | null;
  publishedByAdminId: string | null;
  effectiveAt: Date | null;
  retiredAt: Date | null;
  retiredByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RestoreDispatchPolicyResult =
  | { kind: "created" | "replayed"; policy: DispatchPolicyRecord }
  | { kind: "conflict" }
  | { kind: "invalid_reference"; message: string };

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
  copiedFromPolicyId?: string | null;
  createdByAdminId?: string | null;
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

  /** 经营输入保持原查询口径；实现按读取职责独立。 */
  async resolveResourceOperatingInput(
    enterpriseId: string,
    providerResourceId: string,
    now: number = Date.now(),
    upstreamModel?: string,
  ): ReturnType<typeof resolveResourceOperatingInput> {
    return resolveResourceOperatingInput(this.db, enterpriseId, providerResourceId, now, upstreamModel);
  }

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
        copied_from_policy_id: input.copiedFromPolicyId ?? null,
        created_by_admin_id: input.createdByAdminId ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** 仅允许原地编辑草稿；已校验/发布版本保持不可变。 */
  async updateDraftPolicy(
    enterpriseId: string,
    policyId: string,
    input: Omit<CreateDispatchPolicyInput, "enterpriseId" | "status">,
  ): Promise<boolean> {
    const row = await this.db
      .updateTable("dispatch_policy")
      .set({
        match_unified_model: input.matchUnifiedModel,
        match_resource_mode: input.matchResourceMode,
        match_provider_resource_id: input.matchProviderResourceId,
        match_timezone: input.matchTimezone,
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
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", policyId)
      .where("status", "=", "DRAFT")
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /** 企业隔离的状态迁移；调用方负责传入允许的前态。 */
  async transitionStatus(
    enterpriseId: string,
    policyId: string,
    from: DispatchPolicy["status"],
    to: DispatchPolicy["status"],
    actorAdminId: string | null = null,
    expectedVersion?: number,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom("dispatch_policy").selectAll()
      .where("id", "=", policyId).where("enterprise_id", "=", enterpriseId).forUpdate().executeTakeFirst();
    if (!current || current.status !== from || (expectedVersion !== undefined && current.version !== expectedVersion)) return false;
    if ((to === "VALIDATED" || to === "PUBLISHED") && await policyPricingReadiness(trx, enterpriseId, current)) return false;
    const now = new Date();
    const timelinePatch = to === "VALIDATED"
      ? { validated_at: now, validated_by_admin_id: actorAdminId }
      : to === "PUBLISHED"
        ? {
            published_at: now,
            published_by_admin_id: actorAdminId,
            effective_at: now,
          }
        : to === "RETIRED"
          ? { retired_at: now, retired_by_admin_id: actorAdminId }
          : {};
    const row = await trx
      .updateTable("dispatch_policy")
      .set({ status: to, ...timelinePatch, updated_at: now, version: sql`version + 1` })
      .where("id", "=", policyId)
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", from)
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
    });
  }

  /** 历史版本只读；复制全部条件为新草稿并生成递增版本号。 */
  async copyPolicyAsDraft(
    enterpriseId: string,
    policyId: string,
    actorAdminId: string,
  ): Promise<DispatchPolicyRecord | undefined> {
    const created = await copyRetiredPolicyAsDraft(this.db, enterpriseId, policyId, actorAdminId);
    return created ? mapPolicy(created) : undefined;
  }

  /**
   * 恢复历史配置时创建递增的新发布版本；源 RETIRED 版本保持不可变。
   * 调用方须先完成引用校验和用户确认，本事务负责复制与发布的原子性。
   */
  async restorePolicyAsPublished(
    enterpriseId: string,
    policyId: string,
    actorAdminId: string,
  ): Promise<RestoreDispatchPolicyResult> {
    const result = await restoreRetiredPolicyAsPublished(this.db, enterpriseId, policyId, actorAdminId);
    return "policy" in result ? { ...result, policy: mapPolicy(result.policy) } : result;
  }

  async getPolicy(
    enterpriseId: string,
    policyId: string,
  ): Promise<DispatchPolicyRecord | undefined> {
    const row = await this.db
      .selectFrom("dispatch_policy")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", policyId)
      .executeTakeFirst();
    return row ? mapPolicy(row) : undefined;
  }

  /** 管理面查询全部状态；历史版本不覆盖。 */
  async listPolicies(enterpriseId: string): Promise<DispatchPolicyRecord[]> {
    const rows = await this.db
      .selectFrom("dispatch_policy")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapPolicy);
  }

  /** 热路径查询：该企业已发布（PUBLISHED）的全部策略（按 priority 升序）。 */
  async listPublishedPolicies(enterpriseId: string): Promise<DispatchPolicy[]> {
    const rows = await this.db
      .selectFrom("dispatch_policy")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "PUBLISHED")
      .where("archived_at", "is", null)
      .orderBy("priority", "asc")
      .execute();
    return rows.map(mapPolicy);
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

  /**
   * 首次决策已在执行经营动作前冻结；上游完成后只补充实际资源、Usage 与成本证据，
   * 不改写策略版本、最终动作或理由。
   */
  async enrichDecisionSettlementEvidence(input: {
    enterpriseId: string;
    aiRequestId: string;
    dispatchInput: Record<string, unknown>;
    counterfactualCost: string | null;
    actualCost: string | null;
    dispatchSaving: string | null;
    savingCalculable: boolean;
    notCalculableReason: string | null;
  }): Promise<void> {
    const updated = await this.db.updateTable("dispatch_decision").set({
      dispatch_input: input.dispatchInput,
      counterfactual_cost: input.counterfactualCost,
      actual_cost: input.actualCost,
      dispatch_saving: input.dispatchSaving,
      saving_calculable: input.savingCalculable,
      not_calculable_reason: input.notCalculableReason,
    }).where("enterprise_id", "=", input.enterpriseId)
      .where("ai_request_id", "=", input.aiRequestId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new Error("dispatch_decision_missing_before_settlement");
    }
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
