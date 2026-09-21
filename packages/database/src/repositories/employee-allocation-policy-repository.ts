/**
 * 员工归集规则集合仓储（候选 C3 合同 §3；计划 v1.2 §7.2 权重编辑唯一合同）。
 * 单项目页面只提交当前项目意图；服务端在员工级 advisory lock 内读取完整规则、
 * 替换当前项目段、全时间线校验后原子发布；dirty 标记与发布同一事务。
 * 版本只追加，is_current 单向关闭；幂等键重放返回原版本。
 */
import { type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  Database, EmployeeProjectAllocationPolicyTable, EmployeeProjectAllocationRuleTable,
} from "../kysely.js";
import {
  validatePolicyRules, previewCapacity,
  type AccountingContext, type MembershipContext, type PolicyConflict, type PolicyRuleInput,
} from "@qianliu/domain";
import {
  allocationInputHash, enumerateShanghaiMonths, listActiveMembershipRevisions,
  lockEmployeeAllocationScope, markAllocationDirty, resolveAllocationPrincipal,
} from "./project-allocation-common.js";
import type { AllocationDb } from "./project-allocation-common.js";

export type AllocationRuleRow = Selectable<EmployeeProjectAllocationRuleTable>;
type PolicyRow = Selectable<EmployeeProjectAllocationPolicyTable>;

export class AllocationPolicyVersionConflictError extends Error {
  constructor(public readonly latestVersion: number) {
    super(`allocation policy version conflict (latest ${latestVersion})`);
    this.name = "AllocationPolicyVersionConflictError";
  }
}

export class AllocationRuleConflictError extends Error {
  constructor(public readonly conflicts: PolicyConflict[]) {
    super(`allocation rule conflicts: ${conflicts.map((conflict) => conflict.kind).join(",")}`);
    this.name = "AllocationRuleConflictError";
  }
}

/** 期望发布的规则段（当前项目修改意图；其他项目由服务端原样保留）。 */
export interface DesiredRuleInput {
  projectPrincipalId: string;
  membershipId: string;
  weightBps: number;
  validFrom: Date;
  validUntil: Date | null;
}

export interface PublishRulesInput {
  enterpriseId: string;
  employeePrincipalId: string;
  actorAdminId: string;
  reason: string;
  idempotencyKey: string | null;
  expectedPolicyVersion: number | null;
  rules: DesiredRuleInput[];
}

export type PublishRulesOutcome =
  | { outcome: "PUBLISHED"; policyId: string; version: number; affectedMonths: string[] }
  | { outcome: "REPLAY"; policyId: string; version: number };

async function currentPolicy(
  db: AllocationDb, enterpriseId: string, employeeId: string,
): Promise<PolicyRow | undefined> {
  return db.selectFrom("employee_project_allocation_policy")
    .selectAll()
    .where("enterprise_id", "=", enterpriseId)
    .where("employee_principal_id", "=", employeeId)
    .where("is_current", "=", true)
    .executeTakeFirst();
}

async function rulesOfPolicies(db: AllocationDb, policyIds: string[]): Promise<AllocationRuleRow[]> {
  if (policyIds.length === 0) return [];
  return db.selectFrom("employee_project_allocation_rule")
    .selectAll()
    .where("policy_id", "in", policyIds)
    .orderBy("valid_from")
    .execute();
}

async function accountingByProject(
  db: AllocationDb,
  enterpriseId: string,
  projectIds: string[],
): Promise<Map<string, AccountingContext>> {
  const map = new Map<string, AccountingContext>();
  if (projectIds.length === 0) return map;
  const rows = await db.selectFrom("project_accounting_profile_version")
    .select(["project_principal_id", "accounting_started_at", "accounting_ended_at"])
    .where("enterprise_id", "=", enterpriseId)
    .where("project_principal_id", "in", projectIds)
    .where("is_current", "=", true)
    .execute();
  for (const row of rows) {
    map.set(row.project_principal_id, {
      projectPrincipalId: row.project_principal_id,
      startedAt: row.accounting_started_at,
      endedAt: row.accounting_ended_at,
    });
  }
  return map;
}

function toDomainRule(rule: DesiredRuleInput): PolicyRuleInput {
  return {
    projectPrincipalId: rule.projectPrincipalId,
    membershipId: rule.membershipId,
    weightBps: rule.weightBps,
    validFrom: rule.validFrom,
    validUntil: rule.validUntil,
  };
}

/**
 * 发布核心（调用方事务内）：锁内读当前版本 → 幂等/乐观锁 → 合并校验 →
 * 先关旧版本再插新版本（is_current 部分唯一要求）→ 写规则段。
 * 不推进 dirty：由调用方在同一事务内统一标记。
 */
export async function publishEmployeeRulesInTx(
  tx: Transaction<Database>,
  input: PublishRulesInput,
): Promise<PublishRulesOutcome> {
  await lockEmployeeAllocationScope(tx, input.enterpriseId, input.employeePrincipalId);

  if (input.idempotencyKey !== null) {
    const replayed = await tx.selectFrom("employee_project_allocation_policy")
      .select(["id", "version"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("employee_principal_id", "=", input.employeePrincipalId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (replayed) return { outcome: "REPLAY", policyId: replayed.id, version: replayed.version };
  }

  const previous = await currentPolicy(tx, input.enterpriseId, input.employeePrincipalId);
  const previousVersion = previous?.version ?? 0;
  if (input.expectedPolicyVersion !== null && input.expectedPolicyVersion !== previousVersion) {
    throw new AllocationPolicyVersionConflictError(previousVersion);
  }

  const revisions = await listActiveMembershipRevisions(tx, input.enterpriseId, input.employeePrincipalId);
  const revisionByMembership = new Map(revisions.map((revision) => [revision.membership_id, revision]));
  const memberships: MembershipContext[] = revisions.map((revision) => ({
    membershipId: revision.membership_id,
    projectPrincipalId: revision.project_principal_id,
    joinedAt: revision.joined_at,
    leftAt: revision.left_at,
  }));
  const projectIds = [...new Set(input.rules.map((rule) => rule.projectPrincipalId))];
  const accounting = await accountingByProject(tx, input.enterpriseId, projectIds);

  const conflicts = validatePolicyRules(input.rules.map(toDomainRule), memberships, accounting);
  if (conflicts.length > 0) throw new AllocationRuleConflictError(conflicts);

  const previousRules = previous ? await rulesOfPolicies(tx, [previous.id]) : [];
  const starts = [
    ...input.rules.map((rule) => rule.validFrom.getTime()),
    ...previousRules.map((rule) => rule.valid_from.getTime()),
  ];
  const affectedMonths = starts.length === 0 ? [] : enumerateShanghaiMonths(
    new Date(Math.min(...starts)), null, new Date(),
  );

  if (previous) {
    await tx.updateTable("employee_project_allocation_policy")
      .set({ is_current: false })
      .where("id", "=", previous.id)
      .execute();
  }
  const inserted = await tx.insertInto("employee_project_allocation_policy")
    .values({
      enterprise_id: input.enterpriseId,
      employee_principal_id: input.employeePrincipalId,
      version: previousVersion + 1,
      is_current: true,
      input_hash: allocationInputHash(input.rules),
      idempotency_key: input.idempotencyKey,
      reason: input.reason,
      published_by: input.actorAdminId,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  for (const rule of input.rules) {
    const revision = revisionByMembership.get(rule.membershipId);
    if (!revision) throw new AllocationRuleConflictError([{
      kind: "UNKNOWN_MEMBERSHIP",
      projectPrincipalId: rule.projectPrincipalId,
      interval: { from: rule.validFrom, until: rule.validUntil },
      message: "规则引用的参与关系不存在或已失效",
    }]);
    await tx.insertInto("employee_project_allocation_rule")
      .values({
        policy_id: inserted.id,
        enterprise_id: input.enterpriseId,
        employee_principal_id: input.employeePrincipalId,
        project_principal_id: rule.projectPrincipalId,
        membership_id: rule.membershipId,
        membership_revision_id: revision.id,
        weight_bps: rule.weightBps,
        valid_from: rule.validFrom,
        valid_until: rule.validUntil,
      })
      .execute();
  }
  return { outcome: "PUBLISHED", policyId: inserted.id, version: previousVersion + 1, affectedMonths };
}

/** 独立发布入口（企业级完整规则集合管理用）。dirty 标记与发布同一事务。 */
export async function publishEmployeeRules(
  db: Kysely<Database>,
  input: PublishRulesInput,
): Promise<PublishRulesOutcome> {
  await resolveAllocationPrincipal(db, input.enterpriseId, input.employeePrincipalId, "EMPLOYEE");
  return db.transaction().execute(async (tx) => {
    const outcome = await publishEmployeeRulesInTx(tx, input);
    if (outcome.outcome === "PUBLISHED") {
      await markAllocationDirty(tx, input.enterpriseId, outcome.affectedMonths);
    }
    return outcome;
  });
}

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
