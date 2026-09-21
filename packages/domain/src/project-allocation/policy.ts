import {
  collectBoundaries, intervalCovers, intervalContains, intervalsOverlap,
  type TemporalInterval,
} from "./timeline.js";

/**
 * 员工归集规则集合的发布前校验（合同 §3；计划 v1.2 §3.3）。
 * 纯逻辑、不访问数据库。发布方在员工级 advisory lock 内合并完整规则后调用：
 * 任意有效时刻，员工全部带权重项目关系（参与∩权重∩核算）的权重和 ≤10000；
 * 小于 10000 保留余量，不归一化；0% 为显式合法段；100% 专属规则仍属成员规则。
 */

/** 待发布的规则段（绑定其参与关系）。 */
export interface PolicyRuleInput {
  projectPrincipalId: string;
  membershipId: string;
  weightBps: number;
  validFrom: Date;
  validUntil: Date | null;
}

/** 员工当前有效参与（ACTIVE 修订定义的区间）。 */
export interface MembershipContext {
  membershipId: string;
  projectPrincipalId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

/** 项目核算窗口；项目未配置生命周期 = 不设限。 */
export interface AccountingContext {
  projectPrincipalId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export type PolicyConflictKind =
  | "UNKNOWN_MEMBERSHIP"
  | "RULE_OUTSIDE_MEMBERSHIP"
  | "RULE_OUTSIDE_ACCOUNTING"
  | "RULE_OVERLAP_SAME_PROJECT"
  | "WEIGHT_EXCEEDS_LIMIT";

export interface PolicyConflict {
  kind: PolicyConflictKind;
  projectPrincipalId: string | null;
  interval: TemporalInterval;
  message: string;
  /** 超限段合计基点与涉事项目（WEIGHT_EXCEEDS_LIMIT）。 */
  totalBps?: number;
  conflictingProjects?: string[];
}

function ruleInterval(rule: PolicyRuleInput): TemporalInterval {
  return { from: rule.validFrom, until: rule.validUntil };
}

/** 发布前整组校验：参与覆盖、核算覆盖、同项目不重叠、任意时刻全项目权重和 ≤10000。 */
export function validatePolicyRules(
  rules: PolicyRuleInput[],
  memberships: MembershipContext[],
  accountingByProject: Map<string, AccountingContext>,
): PolicyConflict[] {
  const conflicts: PolicyConflict[] = [];
  const membershipById = new Map(memberships.map((membership) => [membership.membershipId, membership]));

  for (const rule of rules) {
    const membership = membershipById.get(rule.membershipId);
    if (!membership || membership.projectPrincipalId !== rule.projectPrincipalId) {
      conflicts.push({
        kind: "UNKNOWN_MEMBERSHIP",
        projectPrincipalId: rule.projectPrincipalId,
        interval: ruleInterval(rule),
        message: "规则引用的参与关系不存在、已失效或项目不一致",
      });
      continue;
    }
    if (!intervalContains({ from: membership.joinedAt, until: membership.leftAt }, ruleInterval(rule))) {
      conflicts.push({
        kind: "RULE_OUTSIDE_MEMBERSHIP",
        projectPrincipalId: rule.projectPrincipalId,
        interval: ruleInterval(rule),
        message: "权重区间超出成员参与区间",
      });
    }
    const accounting = accountingByProject.get(rule.projectPrincipalId);
    if (accounting
      && !intervalContains({ from: accounting.startedAt, until: accounting.endedAt }, ruleInterval(rule))) {
      conflicts.push({
        kind: "RULE_OUTSIDE_ACCOUNTING",
        projectPrincipalId: rule.projectPrincipalId,
        interval: ruleInterval(rule),
        message: "权重区间超出项目核算区间",
      });
    }
  }

  for (const project of new Set(rules.map((rule) => rule.projectPrincipalId))) {
    const projectRules = rules.filter((rule) => rule.projectPrincipalId === project);
    for (let i = 0; i < projectRules.length; i += 1) {
      const left = projectRules[i];
      if (!left) continue;
      for (let j = i + 1; j < projectRules.length; j += 1) {
        const right = projectRules[j];
        if (!right) continue;
        if (intervalsOverlap(ruleInterval(left), ruleInterval(right))) {
          conflicts.push({
            kind: "RULE_OVERLAP_SAME_PROJECT",
            projectPrincipalId: project,
            interval: ruleInterval(left),
            message: "同一项目的权重区间重叠",
          });
        }
      }
    }
  }

  conflicts.push(...weightLimitConflicts(rules));
  return conflicts;
}

/**
 * 边界并集逐段扫描：任何时刻 Σweight_bps ≤ 10000；相邻同值超限段合并（含无上界尾段）。
 * 半开区间语义：恰在边界时刻切换不产生误报。
 */
export function weightLimitConflicts(rules: PolicyRuleInput[]): PolicyConflict[] {
  const intervals = rules.map(ruleInterval);
  const boundaries = collectBoundaries(intervals);
  const conflicts: PolicyConflict[] = [];
  const hasOpenEnd = intervals.some((interval) => interval.until === null);
  const segmentCount = Math.max(boundaries.length - 1, hasOpenEnd ? boundaries.length : 0);
  for (let i = 0; i < segmentCount; i += 1) {
    const fromMs = boundaries[i];
    if (fromMs === undefined) continue;
    const nextMs = i + 1 < boundaries.length ? boundaries[i + 1] : undefined;
    const from = new Date(fromMs);
    const until = nextMs === undefined ? null : new Date(nextMs);
    const covering = rules.filter((rule) => intervalCovers(ruleInterval(rule), from));
    if (covering.length === 0) continue;
    const totalBps = covering.reduce((sum, rule) => sum + rule.weightBps, 0);
    if (totalBps > 10000) {
      const projects = [...new Set(covering.map((rule) => rule.projectPrincipalId))].sort();
      const previous = conflicts[conflicts.length - 1];
      if (previous && previous.totalBps === totalBps
        && previous.conflictingProjects?.join(",") === projects.join(",")) {
        previous.interval = { from: previous.interval.from, until };
      } else {
        conflicts.push({
          kind: "WEIGHT_EXCEEDS_LIMIT",
          projectPrincipalId: null,
          interval: { from, until },
          message: "同时段权重合计超过 100%",
          totalBps,
          conflictingProjects: projects,
        });
      }
    }
  }
  return conflicts;
}

/**
 * 预览汇总数字（P2-1 冻结口径，同一员工、同一参考时点）：
 * hidden_weight_bps = 无权查看项目生效权重之和；
 * available_bps = 10000 − hidden_weight_bps（保留隐藏规则后当前项目可占用上限）；
 * remaining_bps = available_bps − 当前项目权重（预览态=意图，查看态=当前生效）。
 * 可见其他项目从 remaining 继续扣减并单列展示；预览数字不替代锁内全时间线校验。
 */
export interface PreviewCapacity {
  hiddenWeightBps: number;
  availableBps: number;
  remainingBps: number;
}

export function previewCapacity(
  hiddenRules: PolicyRuleInput[],
  currentProjectWeightBps: number,
  at: Date,
): PreviewCapacity {
  const hiddenWeightBps = hiddenRules
    .filter((rule) => intervalCovers(ruleInterval(rule), at))
    .reduce((sum, rule) => sum + rule.weightBps, 0);
  const availableBps = 10000 - hiddenWeightBps;
  return { hiddenWeightBps, availableBps, remainingBps: availableBps - currentProjectWeightBps };
}
