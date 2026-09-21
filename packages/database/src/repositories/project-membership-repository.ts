/**
 * 项目成员仓储（候选 C3 合同 §3；计划 v1.2 §3.2/§3.3）。
 * 参与 = 稳定 stint + 不可变修订链；同项目有效区间不重叠（锁内校验 + DB EXCLUDE 双保险）。
 * 写入在员工级 advisory lock 内串行；幂等重放返回原结果（原修订区间，非最新）；
 * 带权重加入时同一事务发布员工规则集合新版本；dirty 与业务写同一事务。
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import {
  enumerateShanghaiMonths, listActiveMembershipRevisions,
  lockEmployeeAllocationScope, markAllocationDirty, resolveAllocationPrincipal,
} from "./project-allocation-common.js";
import type { AllocationDb } from "./project-allocation-common.js";
import {
  publishEmployeeRulesInTx, type DesiredRuleInput, type PublishRulesOutcome,
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

export interface MembershipMutationResult {
  membershipId: string;
  revision: number;
  policyVersion: number | null;
  affectedMonths: string[];
  replay: boolean;
}

interface IdempotentRevisionRow {
  membership_id: string;
  revision: number;
}

async function findIdempotentRevision(
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
async function replayOutcome(
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

async function assertNoActiveOverlap(
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

/** 加入项目（可同时设置该项目权重；日期输入已在 API 层按 +08:00 转换为排他边界）。 */
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
  if (currentPolicyId !== undefined) {
    const { rows: keptRows } = await sql<{
      project_principal_id: string; membership_id: string; weight_bps: number;
      valid_from: Date; valid_until: Date | null;
    }>`
      SELECT project_principal_id, membership_id, weight_bps, valid_from, valid_until
      FROM employee_project_allocation_rule
      WHERE policy_id = ${currentPolicyId}
        AND project_principal_id <> ${params.projectId}`.execute(tx);
    kept.push(...keptRows);
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
      // 未显式给出权重区间时默认整个参与区间。
      validFrom: params.weight.validFrom ?? params.weightDefaultFrom,
      validUntil: params.weight.validUntil === undefined ? params.weightDefaultUntil : params.weight.validUntil,
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

export interface ListMembershipsParams {
  enterpriseId: string;
  projectId: string;
  at?: Date;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface MembershipListRow {
  membershipId: string;
  employeePrincipalId: string;
  employeeName: string;
  stintIndex: number;
  revision: number;
  revisionId: string;
  status: "ACTIVE" | "FUTURE" | "ENDED";
  joinedAt: Date;
  leftAt: Date | null;
  currentWeightBps: number | null;
  weightInterval: { from: Date; until: Date | null } | null;
  otherProjectsCount: number;
  otherProjectsWeightBps: number;
}

export interface MembershipListResult {
  rows: MembershipListRow[];
  counts: { currentMembers: number; atMembers: number | null; periodMembers: number | null };
  total: number;
  limit: number;
  offset: number;
}

type MembershipListRowSql = {
  membership_id: string; stint_index: number; employee_principal_id: string; employee_name: string;
  revision_id: string; revision: number; joined_at: Date; left_at: Date | null;
  current_weight_bps: number | null; weight_from: Date | null; weight_until: Date | null;
  other_projects_count: number; other_projects_weight_bps: number;
};

/**
 * 成员与参与历史列表：人数口径分开（当前/时点/账期按员工去重，互不替代）；
 * 当前权重与其他项目占比按参考时点 LATERAL 聚合；稳定排序分页。
 */
export async function listProjectMemberships(
  db: Kysely<Database>,
  params: ListMembershipsParams,
): Promise<MembershipListResult> {
  await resolveAllocationPrincipal(db, params.enterpriseId, params.projectId, "PROJECT");
  const at = params.at ?? new Date();
  const periodFrom = params.from ?? at;
  const periodTo = params.to ?? at;

  const { rows: counted } = await sql<{ total: number; current_members: number; period_members: number }>`
    SELECT
      (SELECT COUNT(*)::int
        FROM project_membership_revision r
        JOIN project_membership m ON m.id = r.membership_id
        WHERE r.enterprise_id = ${params.enterpriseId}
          AND m.project_principal_id = ${params.projectId}
          AND r.status = 'ACTIVE') AS total,
      (SELECT COUNT(DISTINCT m.employee_principal_id)::int
        FROM project_membership_revision r
        JOIN project_membership m ON m.id = r.membership_id
        WHERE r.enterprise_id = ${params.enterpriseId}
          AND m.project_principal_id = ${params.projectId}
          AND r.status = 'ACTIVE'
          AND r.joined_at <= ${at} AND (r.left_at IS NULL OR r.left_at > ${at})) AS current_members,
      (SELECT COUNT(DISTINCT m.employee_principal_id)::int
        FROM project_membership_revision r
        JOIN project_membership m ON m.id = r.membership_id
        WHERE r.enterprise_id = ${params.enterpriseId}
          AND m.project_principal_id = ${params.projectId}
          AND r.status = 'ACTIVE'
          AND r.joined_at < ${periodTo} AND (r.left_at IS NULL OR r.left_at > ${periodFrom})) AS period_members`.execute(db);
  const counts = counted[0];

  const { rows } = await sql<MembershipListRowSql>`
    WITH scoped AS (
      SELECT m.id AS membership_id, m.stint_index, m.employee_principal_id,
             r.id AS revision_id, r.revision, r.joined_at, r.left_at,
             p.name AS employee_name
      FROM project_membership m
      JOIN project_membership_revision r ON r.membership_id = m.id AND r.status = 'ACTIVE'
      JOIN principal p ON p.enterprise_id = m.enterprise_id AND p.id = m.employee_principal_id
      WHERE m.enterprise_id = ${params.enterpriseId}
        AND m.project_principal_id = ${params.projectId}
    )
    SELECT s.membership_id, s.stint_index, s.employee_principal_id, s.employee_name,
           s.revision_id, s.revision, s.joined_at, s.left_at,
           w.weight_bps AS current_weight_bps, w.valid_from AS weight_from, w.valid_until AS weight_until,
           o.cnt AS other_projects_count, o.total AS other_projects_weight_bps
    FROM scoped s
    LEFT JOIN LATERAL (
      SELECT ru.weight_bps, ru.valid_from, ru.valid_until
      FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${params.enterpriseId}
        AND pol.employee_principal_id = s.employee_principal_id AND pol.is_current
        AND ru.project_principal_id = ${params.projectId}
        AND ru.valid_from <= ${at} AND (ru.valid_until IS NULL OR ru.valid_until > ${at})
      ORDER BY ru.valid_from DESC
      LIMIT 1
    ) w ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt, COALESCE(SUM(ru2.weight_bps), 0)::int AS total
      FROM employee_project_allocation_rule ru2
      JOIN employee_project_allocation_policy pol2 ON pol2.id = ru2.policy_id
      WHERE pol2.enterprise_id = ${params.enterpriseId}
        AND pol2.employee_principal_id = s.employee_principal_id AND pol2.is_current
        AND ru2.project_principal_id <> ${params.projectId}
        AND ru2.valid_from <= ${at} AND (ru2.valid_until IS NULL OR ru2.valid_until > ${at})
    ) o ON TRUE
    ORDER BY s.joined_at DESC, s.employee_principal_id
    LIMIT ${params.limit} OFFSET ${params.offset}`.execute(db);

  return {
    rows: rows.map((row) => ({
      membershipId: row.membership_id,
      employeePrincipalId: row.employee_principal_id,
      employeeName: row.employee_name,
      stintIndex: row.stint_index,
      revision: row.revision,
      revisionId: row.revision_id,
      status: row.joined_at.getTime() > at.getTime()
        ? "FUTURE"
        : row.left_at !== null && row.left_at.getTime() <= at.getTime() ? "ENDED" : "ACTIVE",
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      currentWeightBps: row.current_weight_bps,
      weightInterval: row.current_weight_bps === null || row.weight_from === null
        ? null
        : { from: row.weight_from, until: row.weight_until },
      otherProjectsCount: row.other_projects_count,
      otherProjectsWeightBps: row.other_projects_weight_bps,
    })),
    counts: {
      currentMembers: counts?.current_members ?? 0,
      atMembers: params.at === undefined ? null : counts?.current_members ?? 0,
      periodMembers: params.from !== undefined || params.to !== undefined ? counts?.period_members ?? 0 : null,
    },
    total: counts?.total ?? 0,
    limit: params.limit,
    offset: params.offset,
  };
}
