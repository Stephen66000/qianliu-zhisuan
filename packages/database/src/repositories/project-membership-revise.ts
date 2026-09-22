/**
 * 参与修订与共享助手（80 终审 P1-3 拆分）：OCC + 幂等 + 重叠校验，
 * 受影响权重段同事务裁剪；dirty 与业务写同一事务。
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import {
  enumerateShanghaiMonths, listActiveMembershipRevisions,
  lockEmployeeAllocationScope, markAllocationDirty,
  type AllocationDb,
} from "./project-allocation-common.js";
import {
  publishEmployeeRulesInTx, type DesiredRuleInput,
} from "./employee-allocation-policy-repository.js";

export class MembershipOverlapConflictError extends Error {
  constructor(public readonly conflicts: Array<{ joinedAt: Date; leftAt: Date | null }>) {
    super("membership interval overlaps an existing active membership");
    this.name = "MembershipOverlapConflictError";
  }
}

export class MembershipRevisionConflictError extends Error {
  constructor(public readonly latestRevision: number) {
    super(`membership revision conflict (latest ${latestRevision})`);
    this.name = "MembershipRevisionConflictError";
  }
}

export class MembershipNotFoundError extends Error {
  constructor() {
    super("membership not found in this project");
    this.name = "MembershipNotFoundError";
  }
}

export interface MembershipMutationResult {
  membershipId: string;
  revision: number;
  policyVersion: number | null;
  affectedMonths: string[];
  replay: boolean;
}

export interface IdempotentRevisionRow {
  membership_id: string;
  revision: number;
}

export async function findIdempotentRevision(
  db: AllocationDb,
  enterpriseId: string,
  idempotencyKey: string,
): Promise<IdempotentRevisionRow | undefined> {
  return db.selectFrom("project_membership_revision")
    .select(["membership_id", "revision"])
    .where("enterprise_id", "=", enterpriseId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
}

/** 幂等重放的原结果还原：同键发布的权重版本（若有）+ 原修订（非最新）覆盖的北京月份。 */
export async function replayOutcome(
  db: AllocationDb,
  params: {
    enterpriseId: string;
    employeePrincipalId: string;
    idempotencyKey: string;
    membershipId: string;
    revision: number;
  },
): Promise<{ policyVersion: number | null; affectedMonths: string[] }> {
  const policy = await db.selectFrom("employee_project_allocation_policy")
    .select(["version"])
    .where("enterprise_id", "=", params.enterpriseId)
    .where("employee_principal_id", "=", params.employeePrincipalId)
    .where("idempotency_key", "=", params.idempotencyKey)
    .executeTakeFirst();
  const revisionRow = await db.selectFrom("project_membership_revision")
    .select(["joined_at", "left_at"])
    .where("enterprise_id", "=", params.enterpriseId)
    .where("membership_id", "=", params.membershipId)
    .where("revision", "=", params.revision)
    .executeTakeFirst();
  return {
    policyVersion: policy?.version ?? null,
    affectedMonths: revisionRow === undefined
      ? []
      : enumerateShanghaiMonths(revisionRow.joined_at, revisionRow.left_at, new Date()),
  };
}

export async function assertNoActiveOverlap(
  db: AllocationDb,
  enterpriseId: string,
  projectId: string,
  employeeId: string,
  joinedAt: Date,
  leftAt: Date | null,
  excludeMembershipId?: string,
): Promise<void> {
  const { rows } = await sql<{ joined_at: Date; left_at: Date | null }>`
    SELECT r.joined_at, r.left_at
    FROM project_membership_revision r
    JOIN project_membership m ON m.id = r.membership_id
    WHERE r.enterprise_id = ${enterpriseId}
      AND m.project_principal_id = ${projectId}
      AND m.employee_principal_id = ${employeeId}
      AND r.status = 'ACTIVE'
      AND r.joined_at < COALESCE(${leftAt}::timestamptz, 'infinity'::timestamptz)
      AND (r.left_at IS NULL OR r.left_at > ${joinedAt})
      ${excludeMembershipId === undefined
        ? sql``
        : sql`AND m.id <> ${excludeMembershipId}`}
    `.execute(db);
  if (rows.length > 0) {
    throw new MembershipOverlapConflictError(rows.map((row) => ({ joinedAt: row.joined_at, leftAt: row.left_at })));
  }
}

export interface ReviseMembershipInput {
  enterpriseId: string;
  projectId: string;
  membershipId: string;
  expectedRevision: number;
  joinedAt?: Date;
  leftAt?: Date | null;
  reason: string;
  idempotencyKey: string | null;
  actorAdminId: string;
}

/** 修订参与区间（退出/回填/更正）：OCC + 幂等；受影响权重段同事务裁剪。 */
export async function reviseProjectMembership(
  db: Kysely<Database>,
  input: ReviseMembershipInput,
): Promise<MembershipMutationResult> {
  return db.transaction().execute(async (tx) => {
    const membership = await tx.selectFrom("project_membership")
      .select(["id", "employee_principal_id"])
      .where("id", "=", input.membershipId)
      .where("enterprise_id", "=", input.enterpriseId)
      .where("project_principal_id", "=", input.projectId)
      .executeTakeFirst();
    if (!membership) throw new MembershipNotFoundError();
    await lockEmployeeAllocationScope(tx, input.enterpriseId, membership.employee_principal_id);
    if (input.idempotencyKey !== null) {
      const replayed = await findIdempotentRevision(tx, input.enterpriseId, input.idempotencyKey);
      if (replayed && replayed.membership_id === input.membershipId) {
        const { affectedMonths } = await replayOutcome(tx, {
          enterpriseId: input.enterpriseId,
          employeePrincipalId: membership.employee_principal_id,
          idempotencyKey: input.idempotencyKey,
          membershipId: replayed.membership_id,
          revision: replayed.revision,
        });
        return {
          membershipId: replayed.membership_id,
          revision: replayed.revision,
          policyVersion: null,
          affectedMonths,
          replay: true,
        };
      }
    }
    const active = (await listActiveMembershipRevisions(tx, input.enterpriseId, membership.employee_principal_id))
      .find((revision) => revision.membership_id === input.membershipId);
    if (!active) throw new MembershipNotFoundError();
    if (active.revision !== input.expectedRevision) {
      throw new MembershipRevisionConflictError(active.revision);
    }

    const joinedAt = input.joinedAt ?? active.joined_at;
    const leftAt = input.leftAt === undefined ? active.left_at : input.leftAt;
    if (leftAt !== null && leftAt.getTime() <= joinedAt.getTime()) {
      throw new MembershipOverlapConflictError([{ joinedAt, leftAt }]);
    }
    await assertNoActiveOverlap(
      tx, input.enterpriseId, input.projectId, membership.employee_principal_id,
      joinedAt, leftAt, input.membershipId,
    );

    await tx.updateTable("project_membership_revision")
      .set({ status: "SUPERSEDED" })
      .where("id", "=", active.id)
      .execute();
    const nextRevision = await tx.insertInto("project_membership_revision")
      .values({
        membership_id: input.membershipId,
        enterprise_id: input.enterpriseId,
        project_principal_id: input.projectId,
        employee_principal_id: membership.employee_principal_id,
        revision: active.revision + 1,
        status: "ACTIVE",
        joined_at: joinedAt,
        left_at: leftAt,
        idempotency_key: input.idempotencyKey,
        reason: input.reason,
        supersedes_id: active.id,
        created_by: input.actorAdminId,
      })
      .returning(["revision"])
      .executeTakeFirstOrThrow();

    const { policyVersion, policyMonths } = await clipRulesToMembership(tx, {
      enterpriseId: input.enterpriseId,
      employeePrincipalId: membership.employee_principal_id,
      projectId: input.projectId,
      membershipId: input.membershipId,
      joinedAt,
      leftAt,
      reason: input.reason,
      actorAdminId: input.actorAdminId,
    });

    const affectedMonths = [
      ...enumerateShanghaiMonths(active.joined_at, active.left_at, new Date()),
      ...enumerateShanghaiMonths(joinedAt, leftAt, new Date()),
      ...policyMonths,
    ];
    await markAllocationDirty(tx, input.enterpriseId, affectedMonths);
    return {
      membershipId: input.membershipId,
      revision: nextRevision.revision,
      policyVersion,
      affectedMonths,
      replay: false,
    };
  });
}

/** 参与区间变化后，把该成员关系的现有权重段裁剪/终止到新区间内（同一事务）。 */
async function clipRulesToMembership(
  tx: Transaction<Database>,
  params: {
    enterpriseId: string;
    employeePrincipalId: string;
    projectId: string;
    membershipId: string;
    joinedAt: Date;
    leftAt: Date | null;
    reason: string;
    actorAdminId: string;
  },
): Promise<{ policyVersion: number | null; policyMonths: string[] }> {
  const { rows } = await sql<{
    weight_bps: number; valid_from: Date; valid_until: Date | null;
  }>`
    SELECT ru.weight_bps, ru.valid_from, ru.valid_until
    FROM employee_project_allocation_rule ru
    JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
    WHERE pol.enterprise_id = ${params.enterpriseId}
      AND pol.employee_principal_id = ${params.employeePrincipalId}
      AND pol.is_current
      AND ru.project_principal_id = ${params.projectId}
      AND ru.membership_id = ${params.membershipId}
    ORDER BY ru.valid_from`.execute(tx);
  if (rows.length === 0) return { policyVersion: null, policyMonths: [] };

  const clipped: DesiredRuleInput[] = [];
  for (const row of rows) {
    const from = row.valid_from.getTime() < params.joinedAt.getTime() ? params.joinedAt : row.valid_from;
    const untilMs = row.valid_until === null
      ? params.leftAt?.getTime() ?? null
      : params.leftAt !== null && params.leftAt.getTime() < row.valid_until.getTime()
        ? params.leftAt.getTime()
        : row.valid_until.getTime();
    if (untilMs !== null && untilMs <= from.getTime()) continue;
    clipped.push({
      projectPrincipalId: params.projectId,
      membershipId: params.membershipId,
      weightBps: row.weight_bps,
      validFrom: from,
      validUntil: untilMs === null ? null : new Date(untilMs),
    });
  }
  const { rows: kept } = await sql<{
    project_principal_id: string; membership_id: string; weight_bps: number;
    valid_from: Date; valid_until: Date | null;
  }>`
    SELECT ru.project_principal_id, ru.membership_id, ru.weight_bps, ru.valid_from, ru.valid_until
    FROM employee_project_allocation_rule ru
    JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
    WHERE pol.enterprise_id = ${params.enterpriseId}
      AND pol.employee_principal_id = ${params.employeePrincipalId}
      AND pol.is_current
      AND ru.membership_id <> ${params.membershipId}`.execute(tx);

  const outcome = await publishEmployeeRulesInTx(tx, {
    enterpriseId: params.enterpriseId,
    employeePrincipalId: params.employeePrincipalId,
    actorAdminId: params.actorAdminId,
    reason: params.reason,
    idempotencyKey: null,
    expectedPolicyVersion: null,
    rules: [
      ...kept.map((row) => ({
        projectPrincipalId: row.project_principal_id,
        membershipId: row.membership_id,
        weightBps: row.weight_bps,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
      })),
      ...clipped,
    ],
  });
  return outcome.outcome === "PUBLISHED"
    ? { policyVersion: outcome.version, policyMonths: outcome.affectedMonths }
    : { policyVersion: null, policyMonths: [] };
}
