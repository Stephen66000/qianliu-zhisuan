/**
 * 员工规则预览与总览（80 终审 P1-3 拆分，只读）：按调用者权限脱敏的预览口径
 * 与企业级完整规则总览。发布路径在 employee-allocation-policy-repository.ts。
 */
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../kysely.js";
import {
  previewCapacity, validatePolicyRules, type MembershipContext, type PolicyConflict,
} from "@qianliu/domain";
import {
  enumerateShanghaiMonths, listActiveMembershipRevisions, resolveAllocationPrincipal,
} from "./project-allocation-common.js";
import {
  AllocationPolicyVersionConflictError, type DesiredRuleInput,
  accountingByProject, currentPolicy, rulesOfPolicies, toDomainRule,
} from "./employee-allocation-policy-repository.js";

export interface EmployeePolicyOverview {
  employeePrincipalId: string;
  currentVersion: number;
  rules: Array<{
    ruleId: string;
    policyId: string;
    projectPrincipalId: string;
    membershipId: string;
    membershipRevisionId: string;
    weightBps: number;
    validFrom: Date;
    validUntil: Date | null;
  }>;
}

/** 企业级完整权重时间线（仅管理入口；读取需 principals operate，权限在 API 层执行）。 */
export async function getEmployeePolicyOverview(
  db: Kysely<Database> | Transaction<Database>,
  enterpriseId: string,
  employeePrincipalId: string,
): Promise<EmployeePolicyOverview> {
  if ("transaction" in db && typeof (db as Kysely<Database>).transaction === "function") {
    await resolveAllocationPrincipal(db as Kysely<Database>, enterpriseId, employeePrincipalId, "EMPLOYEE");
  }
  const current = await currentPolicy(db, enterpriseId, employeePrincipalId);
  if (!current) return { employeePrincipalId, currentVersion: 0, rules: [] };
  const rules = await rulesOfPolicies(db, [current.id]);
  return {
    employeePrincipalId,
    currentVersion: current.version,
    rules: rules.map((rule) => ({
      ruleId: rule.id,
      policyId: rule.policy_id,
      projectPrincipalId: rule.project_principal_id,
      membershipId: rule.membership_id,
      membershipRevisionId: rule.membership_revision_id,
      weightBps: rule.weight_bps,
      validFrom: rule.valid_from,
      validUntil: rule.valid_until,
    })),
  };
}

export interface PolicyPreviewSegment {
  weightBps: number;
  validFrom: Date;
  validUntil: Date | null;
}

export interface PolicyPreviewResult {
  currentVersion: number;
  conflicts: PolicyConflict[];
  visibleRules: Array<{
    projectPrincipalId: string;
    weightBps: number;
    validFrom: Date;
    validUntil: Date | null;
  }>;
  hidden: { hiddenProjectCount: number; hiddenWeightBps: number; availableBps: number; remainingBps: number };
  segments: Array<{
    weightBps: number;
    validFrom: Date;
    validUntil: Date | null;
    availableBps: number;
    remainingBps: number;
  }>;
  affectedMonths: string[];
}

/**
 * 项目页权重预览（合同 11 §3；P2-1 口径）：合并完整规则后校验，只读不加锁。
 * 当前权限模型为模块级（无按项目可见性），hidden 集合为空——字段按合同保留。
 */
export async function previewPolicyChange(
  db: Kysely<Database>,
  params: {
    enterpriseId: string;
    employeePrincipalId: string;
    projectPrincipalId: string;
    segments: PolicyPreviewSegment[];
    expectedPolicyVersion: number | null;
  },
): Promise<PolicyPreviewResult> {
  const current = await currentPolicy(db, params.enterpriseId, params.employeePrincipalId);
  const currentVersion = current?.version ?? 0;
  if (params.expectedPolicyVersion !== null && params.expectedPolicyVersion !== currentVersion) {
    throw new AllocationPolicyVersionConflictError(currentVersion);
  }
  const currentRules = current ? await rulesOfPolicies(db, [current.id]) : [];
  const otherRules = currentRules.filter((rule) => rule.project_principal_id !== params.projectPrincipalId);
  const revisions = await listActiveMembershipRevisions(db, params.enterpriseId, params.employeePrincipalId);
  const memberships: MembershipContext[] = revisions.map((revision) => ({
    membershipId: revision.membership_id,
    projectPrincipalId: revision.project_principal_id,
    joinedAt: revision.joined_at,
    leftAt: revision.left_at,
  }));

  const merged: DesiredRuleInput[] = [
    ...otherRules.map((rule) => ({
      projectPrincipalId: rule.project_principal_id,
      membershipId: rule.membership_id,
      weightBps: rule.weight_bps,
      validFrom: rule.valid_from,
      validUntil: rule.valid_until,
    })),
    ...params.segments.map((segment) => ({
      projectPrincipalId: params.projectPrincipalId,
      membershipId: revisions.find((revision) =>
        revision.project_principal_id === params.projectPrincipalId
        && revision.joined_at.getTime() <= segment.validFrom.getTime()
        && (revision.left_at === null || segment.validFrom.getTime() < revision.left_at.getTime())
      )?.membership_id ?? `missing:${params.projectPrincipalId}`,
      weightBps: segment.weightBps,
      validFrom: segment.validFrom,
      validUntil: segment.validUntil,
    })),
  ];
  const accounting = await accountingByProject(
    db, params.enterpriseId, [...new Set(merged.map((rule) => rule.projectPrincipalId))],
  );

  // P2-1：available = 10000 − hidden；remaining = available − 当前项目权重。
  // 模块级权限下 hidden 集为空；可见其他项目从 remaining 继续扣减并单列展示。
  const previewSegments = params.segments.map((segment) => {
    const capacity = previewCapacity([], segment.weightBps, segment.validFrom);
    return {
      weightBps: segment.weightBps,
      validFrom: segment.validFrom,
      validUntil: segment.validUntil,
      availableBps: capacity.availableBps,
      remainingBps: capacity.remainingBps,
    };
  });
  // 顶层 hidden 块取查看态：当前项目此刻生效权重（无则 0）。
  const now = new Date();
  const currentProjectWeightNow = currentRules
    .filter((rule) => rule.project_principal_id === params.projectPrincipalId)
    .filter((rule) => rule.valid_from.getTime() <= now.getTime()
      && (rule.valid_until === null || now.getTime() < rule.valid_until.getTime()))
    .reduce((sum, rule) => sum + rule.weight_bps, 0);
  const hiddenCapacity = previewCapacity([], currentProjectWeightNow, now);

  return {
    currentVersion,
    conflicts: validatePolicyRules(merged.map(toDomainRule), memberships, accounting),
    visibleRules: otherRules.map((rule) => ({
      projectPrincipalId: rule.project_principal_id,
      weightBps: rule.weight_bps,
      validFrom: rule.valid_from,
      validUntil: rule.valid_until,
    })),
    hidden: {
      hiddenProjectCount: 0,
      hiddenWeightBps: hiddenCapacity.hiddenWeightBps,
      availableBps: hiddenCapacity.availableBps,
      remainingBps: hiddenCapacity.remainingBps,
    },
    segments: previewSegments,
    affectedMonths: params.segments.length === 0 ? [] : enumerateShanghaiMonths(
      new Date(Math.min(...params.segments.map((segment) => segment.validFrom.getTime()))),
      null,
      new Date(),
    ),
  };
}
