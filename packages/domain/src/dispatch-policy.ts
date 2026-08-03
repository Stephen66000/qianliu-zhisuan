/**
 * 经营调度（W16）—— 峰谷/成本/额度/周期策略匹配 + 动作判定 + 反事实节省（纯函数，确定性）。
 *
 * 依据：TRD §9.1 行 609-632（经营调度叠加）、§5.6 行 314-321（dispatch_policy_version）、
 * §5.7 行 342（dispatch_decision 不可覆盖）。
 *
 *   技术路由（W12）生成"能调用"的候选；经营调度（W16）决定"现在应该调用谁以及是否应该放行"：
 *   1. 以请求开始时间和企业时区命中价格/倍率版本（行 613）；
 *   2. 读取候选资源剩余额度、周期结束时间、预计耗尽时间和预测可信度（行 614）；
 *   3. 过滤不满足主体额度、成本边界或已发布调度策略的候选（行 615）；
 *   4. 只在 equivalent_resource_group 内执行自动 SWITCH（行 616）；
 *   5. 执行 ALLOW/SWITCH/RATE_LIMIT/REJECT/ALLOW_OVERAGE（行 617）；
 *   6. 冻结 dispatch_decision，后续配置变化不得改写本次理由（行 618）。
 *
 * 节省（行 620-632）：
 *   dispatch_saving = counterfactual_cost_of_published_baseline − actual_cost_after_executed_action
 *   - 反事实基线必须来自同一请求时点、已发布策略和可调用候选；
 *   - 只有动作实际执行并有价格/倍率证据时才落 dispatch_saving；
 *   - 仅提示、用户没有改变行为或基线不可比时标记 NOT_CALCULABLE；
 *   - 节省是经营分析派生值，不修改上游真实费用和 Token 用量事实。
 *
 * 确定性（工程规则 §7）：同输入同输出，时钟注入，无随机，可回放。
 */
import { toZonedTime } from "./billing-rule.js";

/** 经营调度策略版本（W16 冻结；调整需 Planning Change）。 */
export const DISPATCH_POLICY_VERSION = "w16-v1" as const;

/** 决策原因码（dispatch_decision.reason_code 稳定枚举，机器可读）。 */
export const DISPATCH_REASON = {
  ALLOW_NO_POLICY: "ALLOW_NO_POLICY", // 无命中策略，默认放行
  ALLOW_MATCHED: "ALLOW_MATCHED", // 命中 ALLOW 策略
  SWITCH_WITHIN_GROUP: "SWITCH_WITHIN_GROUP", // 命中 SWITCH 且目标在等价组内
  SWITCH_TARGET_NOT_IN_GROUP: "SWITCH_TARGET_NOT_IN_GROUP", // 目标不在等价组 → 降级 ALLOW（不可越界切换）
  SWITCH_NO_TARGET: "SWITCH_NO_TARGET", // 等价组无其他可用目标 → 降级 ALLOW
  RATE_LIMITED: "RATE_LIMITED", // 命中限流
  REJECTED: "REJECTED", // 命中拒绝
  ALLOW_OVERAGE_MATCHED: "ALLOW_OVERAGE_MATCHED", // 命中允许超额
} as const;

export type DispatchReason = (typeof DISPATCH_REASON)[keyof typeof DISPATCH_REASON];

/** 等价资源组（SWITCH 仅在此组内执行，TRD §9.1 行 616）。 */
export type EquivalentResourceGroup = readonly string[];

/** 管理员发布的经营调度策略（PUBLISHED 状态进入热路径）。 */
export interface DispatchPolicy {
  id: string;
  /** 策略状态（仅 PUBLISHED 参与 matching）。 */
  status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "RETIRED";
  // 匹配条件（nullable = 不限）
  matchUnifiedModel: string | null;
  matchResourceMode: "API" | "CODING_PLAN" | null;
  matchProviderResourceId: string | null;
  matchTimezone: string | null;
  matchDaysOfWeek: number[] | null;
  matchStartTime: string | null; // HH:mm:ss
  matchEndTime: string | null;
  /** 价格倍率下限（≥；用于命中高峰：当请求时点价格倍率 ≥ 此值时匹配）。 */
  matchPriceMultiplierMin: string | null;
  /** 剩余额度比例上限（≤；用于耗尽风险：remaining/quota ≤ 此值时匹配）。 */
  matchRemainingQuotaRatioMax: string | null;
  /** 仅当预计耗尽风险为真时匹配（forecastExhaustAt 在周期内）。 */
  matchForecastExhaustRisk: boolean | null;
  /** 主体范围（principalId 列表；null/空 = 任意主体）。 */
  matchPrincipalScope: string[] | null;
  // 动作
  action: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  /** SWITCH 专用：可切换的等价资源组。 */
  switchEquivalentGroup: EquivalentResourceGroup;
  /** RATE_LIMIT 专用：每分钟限流数（null=仅标记限流，不计具体数）。 */
  rateLimitPerMinute: number | null;
  // 版本
  policyVersion: string;
  /** 优先级（数值小优先；同请求多命中时取最高优先级）。 */
  priority: number;
}

/** 请求时经营输入快照（冻结到 dispatch_decision.dispatch_input）。 */
export interface DispatchInput {
  /** 请求开始时间（epoch ms，注入）。 */
  now: number;
  /** 统一模型别名。 */
  unifiedModel: string;
  /** 评分选中的资源 ID（技术路由 winner）。 */
  selectedResourceId: string;
  /** 资源模式。 */
  resourceMode: "API" | "CODING_PLAN";
  /** 该请求时点命中的价格倍率（来自 W13 billing_rule；无规则="1"）。 */
  priceMultiplier: string;
  /** 剩余额度比例（remaining/quota，0..1；未知=null）。 */
  remainingQuotaRatio: number | null;
  /** 预计耗尽是否在周期内（来自 W15 forecast；true=有耗尽风险）。 */
  forecastExhaustRisk: boolean;
  /** 主体 ID。 */
  principalId: string;
}

/** 决策结果。 */
export interface DispatchDecision {
  /** 命中的最高优先级策略（无则 null → 默认 ALLOW）。 */
  matchedPolicy: DispatchPolicy | null;
  /** 最终动作（结合硬约束：SWITCH 越界/无目标时降级 ALLOW）。 */
  finalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  /** 原因码。 */
  reasonCode: DispatchReason;
  /** SWITCH 时的目标资源（等价组内；非 SWITCH 动作为 null）。 */
  switchTargetResourceId: string | null;
}

/**
 * 单条策略是否匹配请求输入（TRD §9.1 行 613-617）。
 * 任一匹配条件不满足即不匹配；nullable 条件 = 不限。
 */
export function matchPolicy(policy: DispatchPolicy, input: DispatchInput): boolean {
  if (policy.status !== "PUBLISHED") return false; // 只有 PUBLISHED 进热路径（§5.6 行 320）

  // 统一模型
  if (policy.matchUnifiedModel !== null && policy.matchUnifiedModel !== input.unifiedModel) return false;
  // 资源模式
  if (policy.matchResourceMode !== null && policy.matchResourceMode !== input.resourceMode) return false;
  // 指定资源
  if (policy.matchProviderResourceId !== null && policy.matchProviderResourceId !== input.selectedResourceId) return false;
  // 主体范围
  if (
    policy.matchPrincipalScope !== null &&
    policy.matchPrincipalScope.length > 0 &&
    !policy.matchPrincipalScope.includes(input.principalId)
  ) {
    return false;
  }
  // 时间窗（星期 + 起止时间，复用 W13 时区逻辑）
  if (policy.matchTimezone && policy.matchStartTime && policy.matchEndTime) {
    if (!matchTimeWindowInternal(policy, input.now)) return false;
  }
  // 价格倍率下限（≥）
  if (policy.matchPriceMultiplierMin !== null) {
    if (compareDecimal(input.priceMultiplier, policy.matchPriceMultiplierMin) < 0) return false;
  }
  // 剩余额度比例上限（≤）
  if (policy.matchRemainingQuotaRatioMax !== null) {
    if (input.remainingQuotaRatio === null) return false; // 未知额度不命中耗尽风险类策略（不伪精确）
    if (input.remainingQuotaRatio > Number(policy.matchRemainingQuotaRatioMax)) return false;
  }
  // 预计耗尽风险（仅当 input 标记有风险时匹配）
  if (policy.matchForecastExhaustRisk === true && !input.forecastExhaustRisk) return false;

  return true;
}

/** 时间窗匹配（内部复用 billing-rule.toZonedTime，支持跨午夜）。 */
function matchTimeWindowInternal(policy: DispatchPolicy, epochMs: number): boolean {
  const { dayOfWeek, secondsOfDay } = toZonedTime(epochMs, policy.matchTimezone!);
  if (policy.matchDaysOfWeek && policy.matchDaysOfWeek.length > 0 && !policy.matchDaysOfWeek.includes(dayOfWeek)) {
    return false;
  }
  const start = parseTimeSeconds(policy.matchStartTime!);
  const end = parseTimeSeconds(policy.matchEndTime!);
  if (start < end) return secondsOfDay >= start && secondsOfDay < end;
  return secondsOfDay >= start || secondsOfDay < end; // 跨午夜
}

function parseTimeSeconds(s: string): number {
  const [h = "0", m = "0", second = "0"] = s.split(":");
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(second, 10);
}

/** decimal 字符串比较（>0 表示 a>b；避免 number 精度）。 */
function compareDecimal(a: string, b: string): number {
  const da = Number(a);
  const db = Number(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return da < db ? -1 : da > db ? 1 : 0;
}

/**
 * 经营调度判定（TRD §9.1 行 611-618）。
 *
 * 流程：
 *   1. 从已发布策略中找出所有匹配的，取最高优先级（priority 数值最小）；
 *   2. 无匹配 → 默认 ALLOW_NO_POLICY；
 *   3. 命中 SWITCH：
 *      - 目标必须在等价组内（行 616），否则降级 ALLOW（不越界）；
 *      - 等价组无其他可用候选 → 降级 ALLOW；
 *   4. 其他动作原样执行。
 *
 * @param policies  该企业已发布的全部策略（热路径查询后传入）
 * @param input     请求时经营输入
 * @param availableResourceIds  当前可调用候选（SWITCH 目标必须在此 ∩ 等价组内）
 */
export function decideDispatch(
  policies: readonly DispatchPolicy[],
  input: DispatchInput,
  availableResourceIds: ReadonlySet<string>,
): DispatchDecision {
  const matched = policies
    .filter((p) => matchPolicy(p, input))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  if (matched.length === 0) {
    return {
      matchedPolicy: null,
      finalAction: "ALLOW",
      reasonCode: DISPATCH_REASON.ALLOW_NO_POLICY,
      switchTargetResourceId: null,
    };
  }

  const policy = matched[0]!;

  switch (policy.action) {
    case "SWITCH": {
      // 目标 = 等价组内 ∩ 可用候选，排除当前选中资源
      const targets = policy.switchEquivalentGroup.filter(
        (rid) => rid !== input.selectedResourceId && availableResourceIds.has(rid),
      );
      if (targets.length === 0) {
        // 等价组无可用目标 → 降级 ALLOW（不无账放行）
        return {
          matchedPolicy: policy,
          finalAction: "ALLOW",
          reasonCode: DISPATCH_REASON.SWITCH_NO_TARGET,
          switchTargetResourceId: null,
        };
      }
      const target = targets[0]!;
      // 目标必须在等价组内（防御：availableResourceIds 已过滤，此处再确认）
      if (!policy.switchEquivalentGroup.includes(target)) {
        return {
          matchedPolicy: policy,
          finalAction: "ALLOW",
          reasonCode: DISPATCH_REASON.SWITCH_TARGET_NOT_IN_GROUP,
          switchTargetResourceId: null,
        };
      }
      return {
        matchedPolicy: policy,
        finalAction: "SWITCH",
        reasonCode: DISPATCH_REASON.SWITCH_WITHIN_GROUP,
        switchTargetResourceId: target,
      };
    }
    case "RATE_LIMIT":
      return { matchedPolicy: policy, finalAction: "RATE_LIMIT", reasonCode: DISPATCH_REASON.RATE_LIMITED, switchTargetResourceId: null };
    case "REJECT":
      return { matchedPolicy: policy, finalAction: "REJECT", reasonCode: DISPATCH_REASON.REJECTED, switchTargetResourceId: null };
    case "ALLOW_OVERAGE":
      return { matchedPolicy: policy, finalAction: "ALLOW_OVERAGE", reasonCode: DISPATCH_REASON.ALLOW_OVERAGE_MATCHED, switchTargetResourceId: null };
    case "ALLOW":
    default:
      return { matchedPolicy: policy, finalAction: "ALLOW", reasonCode: DISPATCH_REASON.ALLOW_MATCHED, switchTargetResourceId: null };
  }
}

/**
 * 计算反事实节省（TRD §9.1 行 620-632）。
 *
 *   dispatch_saving = counterfactual_cost_of_published_baseline − actual_cost_after_executed_action
 *
 * 标记 NOT_CALCULABLE 的条件（行 631）：
 *   - 仅提示（finalAction=ALLOW 但用户行为未改变 / RATE_LIMIT 未实际拒绝）；
 *   - 反事实基线不可比（counterfactualCost=null 或 actualCost=null）；
 *   - 无价格/倍率证据（行 630）。
 *
 * @returns saving：可计算时为 8 位小数（可负）；不可计算时为 "NOT_CALCULABLE"。
 */
export function computeDispatchSaving(input: {
  finalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  /** 反事实基线成本（若选用评分 winner 的预期成本）。 */
  counterfactualCost: string | null;
  /** 实际执行后的成本（decimal 字符串）。 */
  actualCost: string | null;
  /** 动作是否实际执行并改变了资源/行为（SWITCH 实际切换=true；仅提示=false）。 */
  actionExecuted: boolean;
}): { saving: string | "NOT_CALCULABLE"; reason: string | null } {
  // 仅提示、用户没有改变行为 → NOT_CALCULABLE（行 631）
  if (!input.actionExecuted) {
    return { saving: "NOT_CALCULABLE", reason: "no_action_executed" };
  }
  // 基线不可比 → NOT_CALCULABLE（行 628, 631）
  if (input.counterfactualCost === null || input.actualCost === null) {
    return { saving: "NOT_CALCULABLE", reason: "baseline_not_comparable" };
  }
  const cf = decimalToScaled(input.counterfactualCost, 8);
  const actual = decimalToScaled(input.actualCost, 8);
  if (cf === null || actual === null) {
    return { saving: "NOT_CALCULABLE", reason: "invalid_cost_value" };
  }
  // 节省 = 反事实 − 实际（可正可负；可负表示实际更贵）
  return { saving: scaledToDecimal(cf - actual, 8), reason: null };
}

function decimalToScaled(value: string, scale: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > scale) return null;
  const scaled = BigInt(match[2]!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"));
  return match[1] === "-" ? -scaled : scaled;
}

function scaledToDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const factor = 10n ** BigInt(scale);
  const integer = absolute / factor;
  const fraction = (absolute % factor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}
