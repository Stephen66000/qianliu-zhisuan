/**
 * 路由评分与选择（W12）—— 硬过滤之后的多因子版本化评分。
 *
 * 依据：TRD §9 行 568-583。
 *   - 行 573：套餐优先通过 Route 优先级表达，不写死厂商/账号；
 *   - 行 576：静态优先级/权重、健康、容量、负载、错误率、TTFT、额度、重置时间、成本、Affinity 版本化评分；
 *   - 行 577：Affinity 是可配置评分因子，不得绕过硬约束；
 *   - 行 578：稳定 tie-breaker，避免实例间随机漂移；
 *   - 行 579：冻结 route_candidate 原始因子/归一化值/总分/reason code/策略版本；
 *   - 行 583：评分不能替代硬过滤（硬过滤在 listServableResources 已完成）。
 *
 * W12 因子实现状态：
 *   - 已实现：静态 priority（分组）+ weight（归一化）+ 健康（DEGRADED/半开 probe 降权）+ Affinity（会话粘性）。
 *   - 预留（W15/W16 数据源就绪后接入）：容量余量、负载、错误率、TTFT、额度、重置时间、边际成本
 *     —— 因子框架已就位（ScoreFactor 数组 + 版本化权重），未就绪因子按 absent 处理（不计入，权重归一化）。
 *
 * 确定性（工程规则 §7）：同输入同输出，无随机、无时钟依赖；可 100% 回放。
 */

import type { ResourceStatus } from "./resource-lifecycle.js";

/** 路由策略版本（W12 冻结；调整需 Planning Change）。 */
export const ROUTING_POLICY = {
  /** 因子权重（和不必为 1，评分时按在场因子归一化）。 */
  weights: {
    /** 静态 weight 字段归一化（model_route.weight）。 */
    staticWeight: 0.4,
    /** 健康：ACTIVE=1、DEGRADED=0.6、半开 probe=0.3。 */
    health: 0.4,
    /** Affinity：会话最近成功资源命中=1，否则 0。 */
    affinity: 0.2,
  },
  /** DEGRADED 资源健康分。 */
  degradedHealthScore: 0.6,
  /** 半开探测资源健康分（比 DEGRADED 更低，但未排除）。 */
  probeHealthScore: 0.3,
  version: "w12-v1",
} as const;

/** 路由候选输入（硬过滤后的可服务资源 + model_route 配置 + 运行状态）。 */
export interface RoutingCandidateInput {
  /** model_route.id；同一资源可存在多个不同 upstream route，撤权时按 route 排除。 */
  routeId?: string;
  resourceId: string;
  /** model_route.upstream_model。 */
  upstreamModel: string;
  /** model_route.priority（数值越小优先级越高；只有同优先级候选参与评分竞争）。 */
  priority: number;
  /** model_route.weight（正整数；同优先级内归一化）。 */
  weight: number;
  /** 资源当前状态（ACTIVE/DEGRADED；UNAVAILABLE 半开由 probe 标记）。 */
  status: ResourceStatus;
  /** 半开探测标记（冷却到期后的第一次准入）。 */
  probe: boolean;
  /** providerResource.mode（API/CODING_PLAN）。 */
  mode: "API" | "CODING_PLAN";
  /** provider.code（deepseek/zhipu/kimi，Adapter 解析用）。 */
  providerCode: string;
}

/** 单个因子的归一化分数（0..1）与在场标记。 */
export interface ScoreFactor {
  name: string;
  /** 归一化值（0..1）。 */
  value: number;
  /** 该因子的权重（来自 ROUTING_POLICY.weights）。 */
  weight: number;
}

/** 一个候选的评分结果（冻结到 route_candidate.score_factors）。 */
export interface ScoredCandidate {
  input: RoutingCandidateInput;
  /** 各因子归一化分数（WT-18 可解释性：每个因子如何影响结果）。 */
  factors: ScoreFactor[];
  /** 加权总分（0..1，按在场因子权重归一化）。 */
  totalScore: number;
  /** 是否本轮选中。 */
  selected: boolean;
  /** 选中/未选中原因码。 */
  reasonCode: string;
}

/** 选路原因码（route_candidate.reason_code 稳定枚举）。 */
export const ROUTE_REASON = {
  SELECTED_TOP_SCORE: "SELECTED_TOP_SCORE", // 同优先级组内总分最高
  SELECTED_TIE_BREAK: "SELECTED_TIE_BREAK", // 同分，按 resourceId 字典序稳定选中
  NOT_TOP_PRIORITY: "NOT_TOP_PRIORITY", // 非最高优先级组（未参与竞争）
  LOWER_SCORE: "LOWER_SCORE", // 同组内总分低于选中者
  TIE_BREAK_LOST: "TIE_BREAK_LOST", // 同分但字典序靠后
  EXCLUDED_ALREADY_TRIED: "EXCLUDED_ALREADY_TRIED", // 本请求已尝试过（failover 排除）
} as const;

export type RouteReason = (typeof ROUTE_REASON)[keyof typeof ROUTE_REASON];

/**
 * 计算候选的健康因子分。
 * ACTIVE=1；DEGRADED=degradedHealthScore；半开 probe=probeHealthScore。
 */
export function healthScore(status: ResourceStatus, probe: boolean): number {
  if (probe) return ROUTING_POLICY.probeHealthScore;
  if (status === "DEGRADED") return ROUTING_POLICY.degradedHealthScore;
  return 1;
}

/**
 * 多因子评分 + 稳定选择。
 *
 * 流程（TRD §9 行 570-578）：
 *   1. 排除已尝试资源（failover 重评时 excludeResourceIds）。
 *   2. 取最小 priority 的候选组（只有同优先级参与竞争）。
 *   3. 组内计算多因子加权总分（weight 归一化 + 健康 + Affinity）。
 *   4. 总分最高者选中；同分按 resourceId 字典序（稳定 tie-break）。
 *
 * @param candidates  硬过滤后的可服务候选（listServableResources ∩ model_route）
 * @param affinityResourceId  WT-13 会话最近成功资源（若有；仅作评分因子，不绕过硬约束）
 * @param excludeResourceIds  本请求已尝试过的资源（failover 重评时排除）
 * @returns 全部候选的评分快照（含未中选者，供 route_candidate 冻结 + WT-18 解释）
 */
export function scoreAndSelect(
  candidates: RoutingCandidateInput[],
  affinityResourceId: string | null = null,
  excludeResourceIds: ReadonlySet<string> = new Set(),
): ScoredCandidate[] {
  // 1. 标记已尝试（不参与竞争，但仍出现在快照中供解释）
  const eligible = candidates.filter((c) => !excludeResourceIds.has(c.resourceId));

  // 2. 最高优先级组（最小 priority 数值）
  const topPriority = eligible.length > 0 ? Math.min(...eligible.map((c) => c.priority)) : null;

  const results: ScoredCandidate[] = candidates.map((c) => {
    const excluded = excludeResourceIds.has(c.resourceId);
    const inTopGroup = !excluded && c.priority === topPriority;

    // 3. 因子计算（仅在场因子；W12 四因子：weight 归一化/健康/Affinity）
    const sameGroup = eligible.filter((x) => x.priority === c.priority);
    const weightSum = sameGroup.reduce((s, x) => s + x.weight, 0);
    const factors: ScoreFactor[] = [
      {
        name: "static_weight",
        value: weightSum > 0 ? c.weight / weightSum : 0,
        weight: ROUTING_POLICY.weights.staticWeight,
      },
      {
        name: "health",
        value: healthScore(c.status, c.probe),
        weight: ROUTING_POLICY.weights.health,
      },
      {
        name: "affinity",
        value: affinityResourceId !== null && c.resourceId === affinityResourceId ? 1 : 0,
        weight: ROUTING_POLICY.weights.affinity,
      },
    ];
    const weightTotal = factors.reduce((s, f) => s + f.weight, 0);
    const totalScore = weightTotal > 0 ? factors.reduce((s, f) => s + f.value * f.weight, 0) / weightTotal : 0;

    return {
      input: c,
      factors,
      totalScore,
      selected: false,
      reasonCode: excluded
        ? ROUTE_REASON.EXCLUDED_ALREADY_TRIED
        : inTopGroup
          ? ROUTE_REASON.LOWER_SCORE // 暂记，选中后回填
          : ROUTE_REASON.NOT_TOP_PRIORITY,
    };
  });

  // 4. 选中：最高优先级组内总分最高；同分按 resourceId 字典序（稳定 tie-break）
  const competitors = results
    .filter((r) => !excludeResourceIds.has(r.input.resourceId) && r.input.priority === topPriority)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return a.input.resourceId.localeCompare(b.input.resourceId); // 稳定 tie-break
    });

  if (competitors.length > 0) {
    const winner = competitors[0]!;
    winner.selected = true;
    const tied = competitors.length > 1 && competitors[1]!.totalScore === winner.totalScore;
    winner.reasonCode = tied ? ROUTE_REASON.SELECTED_TIE_BREAK : ROUTE_REASON.SELECTED_TOP_SCORE;
    // 同分落选者标记
    for (const loser of competitors.slice(1)) {
      if (loser.totalScore === winner.totalScore) loser.reasonCode = ROUTE_REASON.TIE_BREAK_LOST;
    }
  }

  return results;
}

/** 从评分结果取选中者（无可用候选时 undefined —— 不无账放行，返回上游不可用）。 */
export function pickWinner(results: ScoredCandidate[]): ScoredCandidate | undefined {
  return results.find((r) => r.selected);
}
