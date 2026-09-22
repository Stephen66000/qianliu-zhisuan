/** 项目成员列表读模型（80 终审 P1-3 拆分）：at/区间过滤、人数口径、分页。 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { resolveAllocationPrincipal } from "./project-allocation-common.js";

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
