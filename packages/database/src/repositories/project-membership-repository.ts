/**
 * 项目成员仓储（候选 C3 合同 §3；计划 v1.2 §3.2/§3.3）。
 * 参与 = 稳定 stint + 不可变修订链；同项目有效区间不重叠（锁内校验 + DB EXCLUDE 双保险）。
 * 写入在员工级 advisory lock 内串行；幂等重放返回原结果（原修订区间，非最新）；
 * 带权重加入时同一事务发布员工规则集合新版本；dirty 与业务写同一事务。
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import {
  enumerateShanghaiMonths, lockEmployeeAllocationScope, markAllocationDirty,
  resolveAllocationPrincipal,
} from "./project-allocation-common.js";
import {
  publishEmployeeRulesInTx, subtractRuleCuts,
  type DesiredRuleInput, type PublishRulesOutcome,
} from "./employee-allocation-policy-repository.js";
import {
  assertNoActiveOverlap, findIdempotentRevision, replayOutcome,
  type MembershipMutationResult,
} from "./project-membership-revise.js";

export {
  reviseProjectMembership, type ReviseMembershipInput,
  MembershipOverlapConflictError, MembershipRevisionConflictError, MembershipNotFoundError,
  type MembershipMutationResult,
} from "./project-membership-revise.js";
export {
  listProjectMemberships, type ListMembershipsParams, type MembershipListRow, type MembershipListResult,
} from "./project-membership-query.js";


/** 加入项目（可同时设置该项目权重；日期输入已在 API 层按 +08:00 转换为排他边界）。 */
export interface MembershipWeightInput {
  weightBps: number;
  validFrom?: Date;
  validUntil?: Date | null;
}

export interface CreateMembershipInput {
  enterpriseId: string;
  projectId: string;
  employeePrincipalId: string;
  joinedAt: Date;
  leftAt: Date | null;
  weight?: MembershipWeightInput | null;
  expectedPolicyVersion?: number | null;
  reason: string;
  idempotencyKey: string | null;
  actorAdminId: string;
}

export async function createProjectMembership(
  db: Kysely<Database>,
  input: CreateMembershipInput,
): Promise<MembershipMutationResult> {
  await resolveAllocationPrincipal(db, input.enterpriseId, input.projectId, "PROJECT");
  await resolveAllocationPrincipal(db, input.enterpriseId, input.employeePrincipalId, "EMPLOYEE");

  return db.transaction().execute(async (tx) => {
    await lockEmployeeAllocationScope(tx, input.enterpriseId, input.employeePrincipalId);
    if (input.idempotencyKey !== null) {
      const replayed = await findIdempotentRevision(tx, input.enterpriseId, input.idempotencyKey);
      if (replayed) {
        const { policyVersion, affectedMonths } = await replayOutcome(tx, {
          enterpriseId: input.enterpriseId,
          employeePrincipalId: input.employeePrincipalId,
          idempotencyKey: input.idempotencyKey,
          membershipId: replayed.membership_id,
          revision: replayed.revision,
        });
        return {
          membershipId: replayed.membership_id,
          revision: replayed.revision,
          policyVersion,
          affectedMonths,
          replay: true,
        };
      }
    }

    await assertNoActiveOverlap(
      tx, input.enterpriseId, input.projectId, input.employeePrincipalId, input.joinedAt, input.leftAt,
    );

    const { rows: stintRows } = await sql<{ max_stint: number }>`
      SELECT COALESCE(MAX(stint_index), 0)::int AS max_stint
      FROM project_membership
      WHERE enterprise_id = ${input.enterpriseId}
        AND project_principal_id = ${input.projectId}
        AND employee_principal_id = ${input.employeePrincipalId}`.execute(tx);
    const stintIndex = (stintRows[0]?.max_stint ?? 0) + 1;

    const membership = await tx.insertInto("project_membership")
      .values({
        enterprise_id: input.enterpriseId,
        project_principal_id: input.projectId,
        employee_principal_id: input.employeePrincipalId,
        stint_index: stintIndex,
        created_by: input.actorAdminId,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const revision = await tx.insertInto("project_membership_revision")
      .values({
        membership_id: membership.id,
        enterprise_id: input.enterpriseId,
        project_principal_id: input.projectId,
        employee_principal_id: input.employeePrincipalId,
        revision: 1,
        status: "ACTIVE",
        joined_at: input.joinedAt,
        left_at: input.leftAt,
        idempotency_key: input.idempotencyKey,
        reason: input.reason,
        created_by: input.actorAdminId,
      })
      .returning(["revision"])
      .executeTakeFirstOrThrow();

    let policyVersion: number | null = null;
    let policyMonths: string[] = [];
    if (input.weight) {
      const outcome = await publishWeightForMembership(tx, {
        enterpriseId: input.enterpriseId,
        employeePrincipalId: input.employeePrincipalId,
        projectId: input.projectId,
        membershipId: membership.id,
        weight: input.weight,
        weightDefaultFrom: input.joinedAt,
        weightDefaultUntil: input.leftAt,
        expectedPolicyVersion: input.expectedPolicyVersion ?? null,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        actorAdminId: input.actorAdminId,
      });
      if (outcome.outcome === "PUBLISHED") {
        policyVersion = outcome.version;
        policyMonths = outcome.affectedMonths;
      }
    }

    const affectedMonths = enumerateShanghaiMonths(input.joinedAt, input.leftAt, new Date());
    await markAllocationDirty(tx, input.enterpriseId, [...affectedMonths, ...policyMonths]);
    return { membershipId: membership.id, revision: revision.revision, policyVersion, affectedMonths, replay: false };
  });
}

async function publishWeightForMembership(
  tx: Transaction<Database>,
  params: {
    enterpriseId: string;
    employeePrincipalId: string;
    projectId: string;
    membershipId: string;
    weight: MembershipWeightInput;
    weightDefaultFrom: Date;
    weightDefaultUntil: Date | null;
    expectedPolicyVersion: number | null;
    reason: string;
    idempotencyKey: string | null;
    actorAdminId: string;
  },
): Promise<PublishRulesOutcome> {
  const kept: Array<{
    project_principal_id: string; membership_id: string; weight_bps: number;
    valid_from: Date; valid_until: Date | null;
  }> = [];
  const { rows } = await sql<{ policy_id: string }>`
    SELECT id AS policy_id FROM employee_project_allocation_policy
    WHERE enterprise_id = ${params.enterpriseId}
      AND employee_principal_id = ${params.employeePrincipalId}
      AND is_current`.execute(tx);
  const currentPolicyId = rows[0]?.policy_id;
  // 新 stint 的权重区间（未显式给出时默认整个参与区间）。
  const newSegment = {
    from: params.weight.validFrom ?? params.weightDefaultFrom,
    until: params.weight.validUntil === undefined ? params.weightDefaultUntil : params.weight.validUntil,
  };
  if (currentPolicyId !== undefined) {
    const { rows: currentRows } = await sql<{
      project_principal_id: string; membership_id: string; weight_bps: number;
      valid_from: Date; valid_until: Date | null;
    }>`
      SELECT project_principal_id, membership_id, weight_bps, valid_from, valid_until
      FROM employee_project_allocation_rule
      WHERE policy_id = ${currentPolicyId}`.execute(tx);
    // 其他项目原样保留；当前项目旧段按新段区间做差集（80 终审 P1-3）：
    // 新 stint 的权重覆盖与之相交的部分，之前的历史段必须留下。
    const sameProject = currentRows
      .filter((row) => row.project_principal_id === params.projectId)
      .map((row) => ({
        membershipId: row.membership_id, weightBps: row.weight_bps,
        validFrom: row.valid_from, validUntil: row.valid_until,
      }));
    const remainder = subtractRuleCuts(sameProject, [newSegment]);
    kept.push(
      ...currentRows
        .filter((row) => row.project_principal_id !== params.projectId)
        .map((row) => ({
          project_principal_id: row.project_principal_id, membership_id: row.membership_id,
          weight_bps: row.weight_bps, valid_from: row.valid_from, valid_until: row.valid_until,
        })),
      ...remainder.map((segment) => ({
        project_principal_id: params.projectId, membership_id: segment.membershipId,
        weight_bps: segment.weightBps, valid_from: segment.validFrom, valid_until: segment.validUntil,
      })),
    );
  }

  const rules: DesiredRuleInput[] = [
    ...kept.map((row) => ({
      projectPrincipalId: row.project_principal_id,
      membershipId: row.membership_id,
      weightBps: row.weight_bps,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
    })),
    {
      projectPrincipalId: params.projectId,
      membershipId: params.membershipId,
      weightBps: params.weight.weightBps,
      validFrom: newSegment.from,
      validUntil: newSegment.until,
    },
  ];
  return publishEmployeeRulesInTx(tx, {
    enterpriseId: params.enterpriseId,
    employeePrincipalId: params.employeePrincipalId,
    actorAdminId: params.actorAdminId,
    reason: params.reason,
    idempotencyKey: params.idempotencyKey,
    expectedPolicyVersion: params.expectedPolicyVersion,
    rules,
  });
}
