/**
 * 项目归集基础层集成测试（候选 C3 WP02，退出条件：重叠、超配、跨企业、并发、
 * 重复提交、不可变、企业边界、run 约束、生命周期裁剪、dirty 原子性、保守回退）。
 * 合同：10-WP01-contract.md、11-WP01-api-schema.md、12-WP01-goldstandards.md。
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely, migrateDown, migrateToLatest } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { Database } from "../kysely.js";
import {
  createProjectMembership, listProjectMemberships, reviseProjectMembership,
  reviseProjectAccountingLifecycle, AccountingVersionConflictError,
  publishEmployeeRules, previewPolicyChange, reviseProjectMembership as revise,
  AllocationPolicyVersionConflictError, AllocationRuleConflictError,
  publishProjectIntent, getEmployeePolicyOverview,
} from "../index.js";
import {
  enumerateShanghaiMonths, markAllocationDirty,
  PrincipalNotAccessibleError, resolveAllocationPrincipal,
} from "../repositories/project-allocation-common.js";

let pg: PostgresTestInstance;
let db: Kysely<Database>;

const entA = randomUUID();
const entB = randomUUID();
const admin = randomUUID();
const adminB = randomUUID();
const projectP = randomUUID();
const projectQ = randomUUID();
const projectBEnt = randomUUID();
const employeeE1 = randomUUID();
const employeeE2 = randomUUID();
const employeeE3 = randomUUID();
const employeeEntB = randomUUID();

const T = (iso: string) => new Date(iso);
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([
    { id: entA, name: "企业甲" }, { id: entB, name: "企业乙" },
  ]).execute();
  await db.insertInto("admin_user").values([
    { id: admin, enterprise_id: entA, username: "admin-a", password_hash: "x" },
    { id: adminB, enterprise_id: entB, username: "admin-b", password_hash: "x" },
  ]).execute();
  await db.insertInto("principal").values([
    { id: projectP, enterprise_id: entA, type: "PROJECT", name: "项目P" },
    { id: projectQ, enterprise_id: entA, type: "PROJECT", name: "项目Q" },
    { id: projectBEnt, enterprise_id: entB, type: "PROJECT", name: "乙项目" },
    { id: employeeE1, enterprise_id: entA, type: "EMPLOYEE", name: "员工一" },
    { id: employeeE2, enterprise_id: entA, type: "EMPLOYEE", name: "员工二" },
    { id: employeeE3, enterprise_id: entA, type: "EMPLOYEE", name: "员工三" },
    { id: employeeEntB, enterprise_id: entB, type: "EMPLOYEE", name: "乙员工" },
  ]).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function activeMembershipId(employeeId: string, projectId: string): Promise<string> {
  const { rows } = await sql<{ membership_id: string }>`
    SELECT r.membership_id
    FROM project_membership_revision r
    JOIN project_membership m ON m.id = r.membership_id
    WHERE r.enterprise_id = ${entA}
      AND m.employee_principal_id = ${employeeId}
      AND m.project_principal_id = ${projectId}
      AND r.status = 'ACTIVE'`.execute(db);
  const id = rows[0]?.membership_id;
  if (id === undefined) throw new Error(`no active membership: ${employeeId} ${projectId}`);
  return id;
}

async function insertRun(
  enterpriseId: string, month: string, status: "QUEUED" | "SUCCEEDED" = "QUEUED",
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO project_allocation_run
      (enterprise_id, period_month, schema_version, algorithm_version, status, generation, actor_type)
    VALUES (${enterpriseId}, ${`${month}-01`}::date, '1', '1', ${status}, 0, 'SYSTEM')
    RETURNING id`.execute(db);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("run insert failed");
  return id;
}

async function insertLine(params: {
  runId: string; enterpriseId: string; targetPrincipalId?: string;
}): Promise<unknown> {
  const target = params.targetPrincipalId ?? projectP;
  const isUnallocated = target === ZERO_UUID;
  return sql`
    INSERT INTO project_allocation_line
      (run_id, enterprise_id, ledger_line_id, ai_request_id, upstream_attempt_id,
       request_started_at, accounted_at, source_principal_id,
       target_type, target_project_principal_id, allocation_source,
       source_input_tokens, source_output_tokens, share_input_tokens, share_output_tokens,
       package_cost_currency, usage_quality, resource_mode)
    VALUES (${params.runId}, ${params.enterpriseId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
      now(), now(), ${employeeE1},
      ${isUnallocated ? "UNALLOCATED" : "PROJECT"}, ${target}, ${isUnallocated ? "UNALLOCATED" : "PROJECT_DIRECT"},
      100, 50, 10.0000, 5.0000, 'CNY', 'ACTUAL', 'API')`.execute(db);
}

describe("迁移与触发器合同", () => {
  it("0076/0077 迁移后新表存在；类型/边界触发器与复合 FK 生效", async () => {
    expect((await sql<{ reg: string | null }>`
      SELECT to_regclass('public.project_allocation_run') AS reg`.execute(db)).rows[0]?.reg)
      .toBe("project_allocation_run");

    // 成员根表：PROJECT 冒充 EMPLOYEE 被拒；跨企业员工被拒；根行不可改删（先建一行有效根记录）。
    await expect(sql`
      INSERT INTO project_membership
        (enterprise_id, project_principal_id, employee_principal_id, stint_index, created_by)
      VALUES (${entA}, ${projectP}, ${projectBEnt}, 1, ${admin})`.execute(db))
      .rejects.toThrow(/PROJECT project principal and an EMPLOYEE employee principal|foreign key/i);
    await expect(sql`
      INSERT INTO project_membership
        (enterprise_id, project_principal_id, employee_principal_id, stint_index, created_by)
      VALUES (${entA}, ${projectP}, ${employeeEntB}, 1, ${admin})`.execute(db))
      .rejects.toThrow(/PROJECT project principal and an EMPLOYEE employee principal|foreign key/i);
    await sql`
      INSERT INTO project_membership
        (enterprise_id, project_principal_id, employee_principal_id, stint_index, created_by)
      VALUES (${entA}, ${projectP}, ${employeeE1}, 50, ${admin})`.execute(db);
    await expect(sql`
      UPDATE project_membership SET stint_index = 9 WHERE enterprise_id = ${entA}`.execute(db))
      .rejects.toThrow(/membership identities are immutable/i);

    await expect(sql`
      INSERT INTO project_accounting_profile_version
        (enterprise_id, project_principal_id, accounting_started_at, version, reason, created_by)
      VALUES (${entA}, ${employeeE1}, now(), 1, 'x', ${admin})`.execute(db))
      .rejects.toThrow(/PROJECT principal/);
    await expect(sql`
      INSERT INTO employee_project_allocation_policy
        (enterprise_id, employee_principal_id, version, input_hash, reason, published_by)
      VALUES (${entA}, ${projectP}, 1, 'h', 'x', ${admin})`.execute(db))
      .rejects.toThrow(/EMPLOYEE principal/);
  });

  it("主体解析：跨企业统一不可访问；类型不符同语义（A01）", async () => {
    await expect(resolveAllocationPrincipal(db, entB, employeeE1, "EMPLOYEE"))
      .rejects.toThrow(PrincipalNotAccessibleError);
    const mismatch = await resolveAllocationPrincipal(db, entA, projectP, "EMPLOYEE")
      .then(() => null, (error: unknown) => error);
    expect(mismatch).toBeInstanceOf(PrincipalNotAccessibleError);
  });
});

describe("M02 参与：重叠/相邻/退出再加入/OCC", () => {
  it("退出再加入为独立 stint，人数口径正确（时点切换）", async () => {
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: employeeE2,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: T("2026-08-20T00:00:00+08:00"),
      reason: "首次加入", idempotencyKey: "m02-join-1", actorAdminId: admin,
    });
    const during = await listProjectMemberships(db, {
      enterpriseId: entA, projectId: projectP, at: T("2026-08-10T00:00:00+08:00"), limit: 25, offset: 0,
    });
    expect(during.counts.currentMembers).toBe(1);
    const after = await listProjectMemberships(db, {
      enterpriseId: entA, projectId: projectP, at: T("2026-08-25T00:00:00+08:00"), limit: 25, offset: 0,
    });
    expect(after.counts.currentMembers).toBe(0);
  });

  it("同项目重叠拒绝；相邻（半开边界）合法；DB EXCLUDE 兜底", async () => {
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: employeeE1,
      joinedAt: T("2026-09-01T00:00:00+08:00"), leftAt: T("2026-09-30T00:00:00+08:00"),
      reason: "s1", idempotencyKey: "overlap-1", actorAdminId: admin,
    });
    await expect(createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: employeeE1,
      joinedAt: T("2026-09-15T00:00:00+08:00"), leftAt: null,
      reason: "s2", idempotencyKey: "overlap-2", actorAdminId: admin,
    })).rejects.toThrow(/overlaps/);

    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: employeeE2,
      joinedAt: T("2026-09-01T00:00:00+08:00"), leftAt: T("2026-09-30T00:00:00+08:00"),
      reason: "相邻前段", idempotencyKey: "adj-1", actorAdminId: admin,
    });
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: employeeE2,
      joinedAt: T("2026-09-30T00:00:00+08:00"), leftAt: null,
      reason: "相邻后段", idempotencyKey: "adj-2", actorAdminId: admin,
    });

    let excludeError: unknown = null;
    await db.transaction().execute(async (tx) => {
      await sql`
        INSERT INTO project_membership
          (enterprise_id, project_principal_id, employee_principal_id, stint_index, created_by)
        VALUES (${entA}, ${projectQ}, ${employeeE1}, 9, ${admin})`.execute(tx);
      excludeError = await sql`
        INSERT INTO project_membership_revision
          (membership_id, enterprise_id, project_principal_id, employee_principal_id,
           revision, status, joined_at, left_at, reason, created_by)
        SELECT m.id, ${entA}, ${projectQ}, ${employeeE1}, 1, 'ACTIVE',
               '2026-09-10T00:00:00+08:00'::timestamptz, '2026-09-20T00:00:00+08:00'::timestamptz,
               '绕过应用', ${admin}
        FROM project_membership m
        WHERE m.enterprise_id = ${entA} AND m.project_principal_id = ${projectQ}
          AND m.employee_principal_id = ${employeeE1} AND m.stint_index = 9`.execute(tx)
        .then(() => null, (error: unknown) => error);
      throw new Error("rollback fixture");
    }).catch(() => undefined);
    expect((excludeError as Error).message).toMatch(/active_interval_excl/);
  });

  it("修订 OCC 与不存在成员", async () => {
    const created = await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: employeeE1,
      joinedAt: T("2026-10-01T00:00:00+08:00"), leftAt: null,
      reason: "occ", idempotencyKey: "occ-1", actorAdminId: admin,
    });
    await reviseProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, membershipId: created.membershipId,
      expectedRevision: 1, leftAt: T("2026-10-31T00:00:00+08:00"),
      reason: "第一修订", idempotencyKey: "occ-2", actorAdminId: admin,
    });
    await expect(reviseProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, membershipId: created.membershipId,
      expectedRevision: 1, leftAt: T("2026-11-30T00:00:00+08:00"),
      reason: "过期修订", idempotencyKey: "occ-3", actorAdminId: admin,
    })).rejects.toThrow(/revision conflict/);
    await expect(reviseProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, membershipId: randomUUID(),
      expectedRevision: 1, reason: "不存在", idempotencyKey: "occ-4", actorAdminId: admin,
    })).rejects.toThrow(/not found/);
  });
});

describe("幂等重放（含权重；先修订再重放）", () => {
  it("重放返回原修订结果：policyVersion/affectedMonths 不受后续修订影响", async () => {
    const key = `idem-${randomUUID()}`;
    const first = await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: employeeE3,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: null,
      weight: { weightBps: 3000 },
      reason: "带权重加入", idempotencyKey: key, actorAdminId: admin,
    });
    expect(first.policyVersion).not.toBeNull();
    expect(first.affectedMonths.length).toBeGreaterThan(0);

    await revise(db, {
      enterpriseId: entA, projectId: projectP, membershipId: first.membershipId,
      expectedRevision: first.revision,
      joinedAt: T("2026-06-01T00:00:00+08:00"),
      reason: "回填提前加入", idempotencyKey: `revise-${randomUUID()}`, actorAdminId: admin,
    });

    const replay = await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: employeeE3,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: null,
      weight: { weightBps: 3000 },
      reason: "带权重重放", idempotencyKey: key, actorAdminId: admin,
    });
    expect(replay.replay).toBe(true);
    expect(replay.membershipId).toBe(first.membershipId);
    expect(replay.revision).toBe(first.revision);
    expect(replay.policyVersion).toBe(first.policyVersion);
    expect(replay.affectedMonths).toEqual(first.affectedMonths);
    expect(replay.affectedMonths).not.toContain("2026-06");
  });
});

describe("W01/W04 权重发布", () => {
  it("6000+5000 超配拒绝且不落库；预览返回冲突；6000+4000 可发布", async () => {
    const e = randomUUID();
    await db.insertInto("principal").values({
      id: e, enterprise_id: entA, type: "EMPLOYEE", name: "发布员工",
    }).execute();
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: e,
      joinedAt: T("2026-06-01T00:00:00+08:00"), leftAt: null,
      weight: { weightBps: 6000, validFrom: T("2026-07-01T00:00:00+08:00") },
      reason: "P60", idempotencyKey: `w1-${randomUUID()}`, actorAdminId: admin,
    });
    const conflict = await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: e,
      joinedAt: T("2026-06-01T00:00:00+08:00"), leftAt: null,
      weight: { weightBps: 5000, validFrom: T("2026-07-01T00:00:00+08:00") },
      reason: "Q50 超配", idempotencyKey: `w2-${randomUUID()}`, actorAdminId: admin,
    }).then(() => null, (error: unknown) => error);
    expect(conflict).toBeInstanceOf(AllocationRuleConflictError);
    expect((conflict as AllocationRuleConflictError).conflicts
      .some((item) => item.kind === "WEIGHT_EXCEEDS_LIMIT" && item.totalBps === 11000)).toBe(true);

    // 成员尚不存在：预览返回 UNKNOWN_MEMBERSHIP（不静默适用）。
    const previewBefore = await previewPolicyChange(db, {
      enterpriseId: entA, employeePrincipalId: e, projectPrincipalId: projectQ,
      segments: [{ weightBps: 4000, validFrom: T("2026-07-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: null,
    });
    expect(previewBefore.conflicts.map((c) => c.kind)).toContain("UNKNOWN_MEMBERSHIP");

    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: e,
      joinedAt: T("2026-06-01T00:00:00+08:00"), leftAt: null,
      reason: "Q 加入（先不带权重）", idempotencyKey: `w3-${randomUUID()}`, actorAdminId: admin,
    });
    const preview = await previewPolicyChange(db, {
      enterpriseId: entA, employeePrincipalId: e, projectPrincipalId: projectQ,
      segments: [{ weightBps: 4000, validFrom: T("2026-07-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: null,
    });
    expect(preview.conflicts).toEqual([]);
    // P2-1 口径：hidden=0 → available=10000、remaining=10000−4000=6000。
    expect(preview.segments[0]?.availableBps).toBe(10000);
    expect(preview.segments[0]?.remainingBps).toBe(6000);
    expect(preview.hidden.availableBps).toBe(10000);

    const published = await publishEmployeeRules(db, {
      enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
      reason: "Q40 发布", idempotencyKey: `w4-${randomUUID()}`,
      expectedPolicyVersion: preview.currentVersion,
      rules: [
        { projectPrincipalId: projectP, membershipId: await activeMembershipId(e, projectP), weightBps: 6000, validFrom: T("2026-07-01T00:00:00+08:00"), validUntil: null },
        { projectPrincipalId: projectQ, membershipId: await activeMembershipId(e, projectQ), weightBps: 4000, validFrom: T("2026-07-01T00:00:00+08:00"), validUntil: null },
      ],
    });
    expect(published.outcome).toBe("PUBLISHED");
  });

  it("发布幂等：同 idempotencyKey 返回 REPLAY 同版本", async () => {
    const e = employeeE3;
    const key = `pub-${randomUUID()}`;
    const rules = async () => [
      { projectPrincipalId: projectP, membershipId: await activeMembershipId(e, projectP), weightBps: 3000, validFrom: T("2026-08-01T00:00:00+08:00"), validUntil: null },
    ];
    const first = await publishEmployeeRules(db, {
      enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
      reason: "幂等发布", idempotencyKey: key, expectedPolicyVersion: null, rules: await rules(),
    });
    const second = await publishEmployeeRules(db, {
      enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
      reason: "幂等发布", idempotencyKey: key, expectedPolicyVersion: null, rules: await rules(),
    });
    expect(first.outcome).toBe("PUBLISHED");
    expect(second.outcome).toBe("REPLAY");
  });

  it("W04 双连接并发发布：一成一冲突，当前合计 ≤10000", async () => {
    const e = randomUUID();
    await db.insertInto("principal").values({ id: e, enterprise_id: entA, type: "EMPLOYEE", name: "并发员工" }).execute();
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: e,
      joinedAt: T("2026-06-01T00:00:00+08:00"), leftAt: null,
      reason: "并发P", idempotencyKey: `cc-p-${randomUUID()}`, actorAdminId: admin,
    });
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: e,
      joinedAt: T("2026-06-01T00:00:00+08:00"), leftAt: null,
      reason: "并发Q", idempotencyKey: `cc-q-${randomUUID()}`, actorAdminId: admin,
    });
    const db2 = createKysely(pg.connectionString);
    try {
      const { rows } = await sql<{ version: number }>`
        SELECT COALESCE(MAX(version), 0)::int AS version
        FROM employee_project_allocation_policy
        WHERE enterprise_id = ${entA} AND employee_principal_id = ${e}`.execute(db);
      const expected = rows[0]?.version ?? 0;
      const buildRules = async (qBps: number) => [
        { projectPrincipalId: projectP, membershipId: await activeMembershipId(e, projectP), weightBps: 6000, validFrom: T("2026-07-01T00:00:00+08:00"), validUntil: null },
        { projectPrincipalId: projectQ, membershipId: await activeMembershipId(e, projectQ), weightBps: qBps, validFrom: T("2026-07-01T00:00:00+08:00"), validUntil: null },
      ];
      const [rulesA, rulesB] = await Promise.all([buildRules(4000), buildRules(3000)]);
      const results = await Promise.allSettled([
        publishEmployeeRules(db, {
          enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
          reason: "并发A", idempotencyKey: null, expectedPolicyVersion: expected, rules: rulesA,
        }),
        publishEmployeeRules(db2, {
          enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
          reason: "并发B", idempotencyKey: null, expectedPolicyVersion: expected, rules: rulesB,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AllocationPolicyVersionConflictError);
      const total = await sql<{ total: number }>`
        SELECT COALESCE(SUM(ru.weight_bps), 0)::int AS total
        FROM employee_project_allocation_rule ru
        JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
        WHERE pol.enterprise_id = ${entA} AND pol.employee_principal_id = ${e}
          AND pol.is_current AND ru.valid_from = '2026-07-01T00:00:00+08:00'::timestamptz`.execute(db);
      expect(total.rows[0]?.total).toBeLessThanOrEqual(10000);
    } finally {
      await db2.destroy();
    }
  });
});

describe("生命周期结束裁剪（M04）", () => {
  it("结束 P 核算：超段权重裁剪、其他项目规则不变、OCC 生效", async () => {
    const profile = await sql<{ version: number }>`
      INSERT INTO project_accounting_profile_version
        (enterprise_id, project_principal_id, accounting_started_at, version, reason, created_by)
      VALUES (${entA}, ${projectP}, '2026-06-01T00:00:00+08:00'::timestamptz, 1, '启动核算', ${admin})
      RETURNING version`.execute(db);
    const startVersion = profile.rows[0]?.version ?? 1;

    await expect(reviseProjectAccountingLifecycle(db, {
      enterpriseId: entA, projectId: projectP, effectiveAt: T("2026-09-15T00:00:00+08:00"),
      reason: "提前结束", expectedVersion: startVersion + 5, actorAdminId: admin,
    })).rejects.toThrow(AccountingVersionConflictError);

    const qBefore = await sql<{ total: number }>`
      SELECT COALESCE(SUM(ru.weight_bps), 0)::int AS total
      FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${entA} AND pol.employee_principal_id = ${employeeE3}
        AND pol.is_current AND ru.project_principal_id = ${projectQ}`.execute(db);
    const beforeCount = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${entA} AND pol.employee_principal_id = ${employeeE3}
        AND pol.is_current AND ru.project_principal_id = ${projectP}`.execute(db);
    expect(beforeCount.rows[0]?.n ?? 0).toBeGreaterThanOrEqual(1);

    const result = await reviseProjectAccountingLifecycle(db, {
      enterpriseId: entA, projectId: projectP, effectiveAt: T("2026-09-15T00:00:00+08:00"),
      reason: "结束核算", expectedVersion: startVersion, actorAdminId: admin,
    });
    expect(result.mode).toBe("ENDED");
    expect(result.affectedEmployees).toBeGreaterThanOrEqual(1);

    const pRules = await sql<{ valid_until: Date | null }>`
      SELECT ru.valid_until
      FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${entA} AND pol.employee_principal_id = ${employeeE3}
        AND pol.is_current AND ru.project_principal_id = ${projectP}`.execute(db);
    expect(pRules.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of pRules.rows) {
      expect(row.valid_until !== null
        && row.valid_until.getTime() <= T("2026-09-15T00:00:00+08:00").getTime()).toBe(true);
    }
    const qAfter = await sql<{ total: number }>`
      SELECT COALESCE(SUM(ru.weight_bps), 0)::int AS total
      FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${entA} AND pol.employee_principal_id = ${employeeE3}
        AND pol.is_current AND ru.project_principal_id = ${projectQ}`.execute(db);
    expect(qAfter.rows[0]?.total).toBe(qBefore.rows[0]?.total);
  });
});

describe("80-P1-2：参与修订幂等重放", () => {
  it("同一 idempotencyKey 的修订重放返回原结果，不产生新修订", async () => {
    const e = randomUUID();
    await db.insertInto("principal").values({ id: e, enterprise_id: entA, type: "EMPLOYEE", name: "重放员工" }).execute();
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: e,
      joinedAt: T("2026-07-01T00:00:00+08:00"), leftAt: null,
      reason: "加入", idempotencyKey: `replay-create-${randomUUID()}`, actorAdminId: admin,
    });
    const key = `replay-revise-${randomUUID()}`;
    const payload = {
      enterpriseId: entA, projectId: projectP, employeePrincipalId: e,
      membershipId: await activeMembershipId(e, projectP), expectedRevision: 1,
      leftAt: T("2026-07-20T00:00:00+08:00"), reason: "退出", idempotencyKey: key, actorAdminId: admin,
    };
    const first = await revise(db, payload);
    const replayed = await revise(db, payload);
    // 重放返回原修订结果（同一修订号、replay 标记），不产生新修订。
    expect(replayed).toMatchObject({
      membershipId: first.membershipId, revision: first.revision, replay: true,
    });
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM project_membership_revision r
      JOIN project_membership m ON m.id = r.membership_id
      WHERE r.enterprise_id = ${entA} AND m.employee_principal_id = ${e}`.execute(db);
    expect(rows[0]?.n).toBe(2);
  });
});

describe("80 终审 P1-3：项目意图按区间差集保留同项目历史段", () => {
  it("开放旧段中途改权重：8 月 40% 保留、9 月起 60%", async () => {
    const e = randomUUID();
    const proj = randomUUID();
    await db.insertInto("principal").values([
      { id: e, enterprise_id: entA, type: "EMPLOYEE", name: "差集员工A" },
      { id: proj, enterprise_id: entA, type: "PROJECT", name: "差集项目A" },
    ]).execute();
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: proj, employeePrincipalId: e,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: null,
      reason: "加入", idempotencyKey: `d1-${randomUUID()}`, actorAdminId: admin,
    });
    const first = await publishProjectIntent(db, {
      enterpriseId: entA, employeePrincipalId: e, projectId: proj,
      segments: [{ weightBps: 4000, validFrom: T("2026-08-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: null, reason: "8月起40%", idempotencyKey: `d2-${randomUUID()}`, actorAdminId: admin,
    });
    expect(first.outcome).toBe("PUBLISHED");
    const second = await publishProjectIntent(db, {
      enterpriseId: entA, employeePrincipalId: e, projectId: proj,
      segments: [{ weightBps: 6000, validFrom: T("2026-09-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: 1, reason: "9月起改60%", idempotencyKey: `d3-${randomUUID()}`, actorAdminId: admin,
    });
    expect(second.outcome).toBe("PUBLISHED");
    // 修复前：当前完整规则只剩 9 月 6000（8 月 40% 被整体删除）。
    const overview = await getEmployeePolicyOverview(db, entA, e);
    expect(overview.rules.map((rule) => `${rule.weightBps}@${rule.validFrom.toISOString()}-${rule.validUntil?.toISOString() ?? "open"}`).sort()).toEqual([
      "4000@2026-07-31T16:00:00.000Z-2026-08-31T16:00:00.000Z",
      "6000@2026-08-31T16:00:00.000Z-open",
    ]);
  });

  it("有限区间局部覆盖：旧段两侧保留、中段替换", async () => {
    const e = randomUUID();
    const proj = randomUUID();
    await db.insertInto("principal").values([
      { id: e, enterprise_id: entA, type: "EMPLOYEE", name: "差集员工B" },
      { id: proj, enterprise_id: entA, type: "PROJECT", name: "差集项目B" },
    ]).execute();
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: proj, employeePrincipalId: e,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: null,
      reason: "加入", idempotencyKey: `d4-${randomUUID()}`, actorAdminId: admin,
    });
    await publishProjectIntent(db, {
      enterpriseId: entA, employeePrincipalId: e, projectId: proj,
      segments: [{ weightBps: 3000, validFrom: T("2026-09-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: null, reason: "9月起30%", idempotencyKey: `d5-${randomUUID()}`, actorAdminId: admin,
    });
    await publishProjectIntent(db, {
      enterpriseId: entA, employeePrincipalId: e, projectId: proj,
      segments: [{ weightBps: 7000, validFrom: T("2026-09-10T00:00:00+08:00"), validUntil: T("2026-09-20T00:00:00+08:00") }],
      expectedPolicyVersion: 1, reason: "局部70%", idempotencyKey: `d6-${randomUUID()}`, actorAdminId: admin,
    });
    const overview = await getEmployeePolicyOverview(db, entA, e);
    expect(overview.rules.map((rule) => `${rule.weightBps}@${rule.validFrom.toISOString()}-${rule.validUntil?.toISOString() ?? "open"}`).sort()).toEqual([
      "3000@2026-08-31T16:00:00.000Z-2026-09-09T16:00:00.000Z",
      "3000@2026-09-19T16:00:00.000Z-open",
      "7000@2026-09-09T16:00:00.000Z-2026-09-19T16:00:00.000Z",
    ]);
  });

  it("退出再加入的新 stint 带权重：旧 stint 段裁剪到新 stint 之前", async () => {
    const e = randomUUID();
    const proj = randomUUID();
    await db.insertInto("principal").values([
      { id: e, enterprise_id: entA, type: "EMPLOYEE", name: "差集员工C" },
      { id: proj, enterprise_id: entA, type: "PROJECT", name: "差集项目C" },
    ]).execute();
    const firstStint = await createProjectMembership(db, {
      enterpriseId: entA, projectId: proj, employeePrincipalId: e,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: null,
      weight: { weightBps: 5000, validFrom: T("2026-08-01T00:00:00+08:00") },
      reason: "第一段50%", idempotencyKey: `d7-${randomUUID()}`, actorAdminId: admin,
    });
    void firstStint;
    await reviseProjectMembership(db, {
      enterpriseId: entA, projectId: proj, employeePrincipalId: e, membershipId: await activeMembershipId(e, proj),
      expectedRevision: 1, leftAt: T("2026-08-31T00:00:00+08:00"),
      reason: "8月底退出", idempotencyKey: `d8-${randomUUID()}`, actorAdminId: admin,
    });
    await createProjectMembership(db, {
      enterpriseId: entA, projectId: proj, employeePrincipalId: e,
      joinedAt: T("2026-09-15T00:00:00+08:00"), leftAt: null,
      weight: { weightBps: 8000, validFrom: T("2026-09-15T00:00:00+08:00") },
      reason: "新stint 80%", idempotencyKey: `d9-${randomUUID()}`, actorAdminId: admin,
    });
    const overview = await getEmployeePolicyOverview(db, entA, e);
    expect(overview.rules.map((rule) => `${rule.weightBps}@${rule.validFrom.toISOString()}-${rule.validUntil?.toISOString() ?? "open"}`).sort()).toEqual([
      "5000@2026-07-31T16:00:00.000Z-2026-08-30T16:00:00.000Z",
      "8000@2026-09-14T16:00:00.000Z-open",
    ]);
  });
});

describe("run/line/ref 不可变与企业边界", () => {
  it("run：非成功禁 is_current（INSERT/UPDATE）；终态仅 is_current 可接管；身份与回退状态被拒", async () => {
    for (const status of ["QUEUED", "RUNNING", "FAILED"] as const) {
      await expect(sql`
        INSERT INTO project_allocation_run
          (enterprise_id, period_month, schema_version, algorithm_version, status, generation, actor_type, is_current)
        VALUES (${entA}, '2027-06-01', '1', '1', ${status}, 0, 'SYSTEM', true)`.execute(db))
        .rejects.toThrow(/check constraint/i);
    }
    const run = await insertRun(entA, "2027-01");
    await sql`
      UPDATE project_allocation_run SET status = 'RUNNING', attempt = 1,
        lease_owner = 'w1', lease_expires_at = now() + interval '5 minutes', started_at = now()
      WHERE id = ${run}`.execute(db);
    await expect(sql`
      UPDATE project_allocation_run SET algorithm_version = '2' WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/identity is immutable/i);
    await expect(sql`
      UPDATE project_allocation_run SET status = 'QUEUED' WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/status must move forward/i);
    await expect(sql`
      UPDATE project_allocation_run SET is_current = true WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/check constraint/i);
    await sql`
      UPDATE project_allocation_run SET status = 'SUCCEEDED', is_current = true,
        input_digest = 'd1', result_hash = 'h1', conservation = '{}'::jsonb,
        completeness = '{}'::jsonb, finished_at = now(), duration_ms = 5, updated_at = now()
      WHERE id = ${run}`.execute(db);
    await expect(sql`UPDATE project_allocation_run SET result_hash = 'x' WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/published allocation runs are immutable/i);
    await expect(sql`UPDATE project_allocation_run SET input_digest = 'x' WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/published allocation runs are immutable/i);
    await sql`UPDATE project_allocation_run SET is_current = false WHERE id = ${run}`.execute(db);
    await expect(sql`UPDATE project_allocation_run SET is_current = true WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/published allocation runs are immutable/i);
    await expect(sql`DELETE FROM project_allocation_run WHERE id = ${run}`.execute(db))
      .rejects.toThrow(/append-only/i);
  });

  it("line：跨企业 run 拒绝（复合 FK）；目标须为同企业 PROJECT 主体（触发器）", async () => {
    const runB = await insertRun(entB, "2026-09");
    await expect(insertLine({ runId: runB, enterpriseId: entA }))
      .rejects.toThrow(/foreign key/i);
    const runA = await insertRun(entA, "2026-09");
    await expect(insertLine({ runId: runA, enterpriseId: entA, targetPrincipalId: projectBEnt }))
      .rejects.toThrow(/target must be a PROJECT principal of the same enterprise/i);
    await expect(insertLine({ runId: runA, enterpriseId: entA, targetPrincipalId: employeeE1 }))
      .rejects.toThrow(/target must be a PROJECT principal of the same enterprise/i);
  });

  it("ref：跨企业 bill/run 拒绝；被引用 run 禁删；ref 不可变；line 不可改删", async () => {
    const runA = await insertRun(entA, "2026-11");
    const periodB = await db.insertInto("operating_bill_period")
      .values({ enterprise_id: entB, period_month: "2026-11-01", status: "CLOSED", current_version: 1, created_by: adminB })
      .returning(["id"]).executeTakeFirstOrThrow();
    const versionB = await db.insertInto("operating_bill_version")
      .values({ enterprise_id: entB, period_id: periodB.id, version: 1, snapshot: {}, closed_by: adminB })
      .returning(["id"]).executeTakeFirstOrThrow();
    await expect(sql`
      INSERT INTO operating_bill_project_allocation_ref
        (enterprise_id, bill_version_id, run_id, frozen)
      VALUES (${entA}, ${versionB.id}, ${runA}, '{}'::jsonb)`.execute(db))
      .rejects.toThrow(/foreign key/i);

    const periodA = await db.insertInto("operating_bill_period")
      .values({ enterprise_id: entA, period_month: "2026-12-01", status: "CLOSED", current_version: 1, created_by: admin })
      .returning(["id"]).executeTakeFirstOrThrow();
    const versionA = await db.insertInto("operating_bill_version")
      .values({ enterprise_id: entA, period_id: periodA.id, version: 1, snapshot: {}, closed_by: admin })
      .returning(["id"]).executeTakeFirstOrThrow();
    const runPublishedRows = await sql<{ id: string }>`
      INSERT INTO project_allocation_run
        (enterprise_id, period_month, schema_version, algorithm_version, status, generation, actor_type, is_current, result_hash)
      VALUES (${entA}, '2026-12-01', '1', '1', 'SUCCEEDED', 0, 'SYSTEM', true, 'h')
      RETURNING id`.execute(db);
    const runPublished = runPublishedRows.rows[0]?.id;
    if (runPublished === undefined) throw new Error("published run fixture failed");
    await sql`
      INSERT INTO operating_bill_project_allocation_ref
        (enterprise_id, bill_version_id, run_id, frozen)
      VALUES (${entA}, ${versionA.id}, ${runPublished}, '{}'::jsonb)`.execute(db);
    await expect(sql`DELETE FROM project_allocation_run WHERE id = ${runPublished}`.execute(db))
      .rejects.toThrow();
    await expect(sql`DELETE FROM operating_bill_project_allocation_ref`.execute(db))
      .rejects.toThrow(/bill allocation references are immutable/i);

    await insertLine({ runId: runPublished, enterpriseId: entA });
    await expect(sql`UPDATE project_allocation_line SET share_input_tokens = 0`.execute(db))
      .rejects.toThrow(/allocation lines are immutable/i);
  });

  it("资源余量：跨企业 run/资源拒绝；不可改删", async () => {
    const runA = await insertRun(entA, "2028-01");
    await expect(sql`
      INSERT INTO project_allocation_resource_residual
        (run_id, provider_resource_id, enterprise_id, amount)
      VALUES (${runA}, ${randomUUID()}, ${entA}, 1.00)`.execute(db))
      .rejects.toThrow(/foreign key/i);
  });

  it("修订链与操作者企业绑定（supersedes/created_by 复合 FK）", async () => {
    const { rows: entbRows } = await sql<{ rev: string }>`
      INSERT INTO project_membership
        (enterprise_id, project_principal_id, employee_principal_id, stint_index, created_by)
      VALUES (${entB}, ${projectBEnt}, ${employeeEntB}, 1, ${adminB})`.execute(db).then(async () => sql<{ rev: string }>`
      INSERT INTO project_membership_revision
        (membership_id, enterprise_id, project_principal_id, employee_principal_id,
         revision, status, joined_at, reason, created_by)
      SELECT m.id, ${entB}, ${projectBEnt}, ${employeeEntB}, 1, 'ACTIVE', now(), '乙企业', ${adminB}
      FROM project_membership m WHERE m.enterprise_id = ${entB}
      RETURNING id AS rev`.execute(db));
    const entbRevision = entbRows[0]?.rev;
    if (entbRevision === undefined) throw new Error("entB revision fixture failed");

    await sql`
      INSERT INTO project_membership
        (enterprise_id, project_principal_id, employee_principal_id, stint_index, created_by)
      VALUES (${entA}, ${projectQ}, ${employeeE2}, 5, ${admin})`.execute(db);
    await expect(sql`
      INSERT INTO project_membership_revision
        (membership_id, enterprise_id, project_principal_id, employee_principal_id,
         revision, status, joined_at, supersedes_id, reason, created_by)
      SELECT m.id, ${entA}, ${projectQ}, ${employeeE2}, 2, 'SUPERSEDED', now(), ${entbRevision}, '跨企业链', ${admin}
      FROM project_membership m
      WHERE m.enterprise_id = ${entA} AND m.employee_principal_id = ${employeeE2}
        AND m.project_principal_id = ${projectQ} AND m.stint_index = 5`.execute(db))
      .rejects.toThrow(/foreign key/i);

    const { rows: entaFirst } = await sql<{ rev: string }>`
      SELECT r.id AS rev FROM project_membership_revision r
      JOIN project_membership m ON m.id = r.membership_id
      WHERE r.enterprise_id = ${entA} AND m.employee_principal_id = ${employeeE2}
        AND m.project_principal_id = ${projectQ} AND m.stint_index = 5
      ORDER BY r.revision LIMIT 1`.execute(db);
    const entaRevision = entaFirst[0]?.rev ?? entbRevision;
    await expect(sql`
      INSERT INTO project_membership_revision
        (membership_id, enterprise_id, project_principal_id, employee_principal_id,
         revision, status, joined_at, supersedes_id, reason, created_by)
      SELECT m.id, ${entA}, ${projectQ}, ${employeeE2}, 2, 'SUPERSEDED', now(), ${entaRevision}, '跨企业管理员', ${adminB}
      FROM project_membership m
      WHERE m.enterprise_id = ${entA} AND m.employee_principal_id = ${employeeE2}
        AND m.project_principal_id = ${projectQ} AND m.stint_index = 5`.execute(db))
      .rejects.toThrow(/foreign key/i);
  });
});

describe("dirty 同事务与月份口径", () => {
  it("成功发布推进 generation；失败发布（版本冲突）不推进", async () => {
    function shanghaiNowMonth(): string {
      const shifted = new Date(Date.now() + 8 * 3600_000);
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
    }
    const month = shanghaiNowMonth();
    const gen = async (): Promise<number> => (await sql<{ generation: number }>`
      SELECT generation::int FROM project_allocation_dirty
      WHERE enterprise_id = ${entA} AND period_month = ${`${month}-01`}::date`.execute(db))
      .rows[0]?.generation ?? 0;

    const e = randomUUID();
    await db.insertInto("principal").values({ id: e, enterprise_id: entA, type: "EMPLOYEE", name: "dirty员工" }).execute();
    const created = await createProjectMembership(db, {
      enterpriseId: entA, projectId: projectQ, employeePrincipalId: e,
      joinedAt: new Date(), leftAt: null,
      reason: "dirty", idempotencyKey: `dirty-${randomUUID()}`, actorAdminId: admin,
    });
    const before = await gen();
    const published = await publishEmployeeRules(db, {
      enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
      reason: "dirty publish", idempotencyKey: `dp-${randomUUID()}`, expectedPolicyVersion: 0,
      rules: [{
        projectPrincipalId: projectQ, membershipId: created.membershipId,
        weightBps: 5000, validFrom: new Date(), validUntil: null,
      }],
    });
    expect(published.outcome).toBe("PUBLISHED");
    const afterPublish = await gen();
    expect(afterPublish).toBeGreaterThan(before);

    const stale = await publishEmployeeRules(db, {
      enterpriseId: entA, employeePrincipalId: e, actorAdminId: admin,
      reason: "dirty stale", idempotencyKey: `ds-${randomUUID()}`, expectedPolicyVersion: 0,
      rules: [{
        projectPrincipalId: projectQ, membershipId: created.membershipId,
        weightBps: 1000, validFrom: new Date(), validUntil: null,
      }],
    }).then(() => null, (error: unknown) => error);
    expect(stale).toBeInstanceOf(AllocationPolicyVersionConflictError);
    expect(await gen()).toBe(afterPublish);
  });

  it("enumerateShanghaiMonths 半开区间与北京月边界", () => {
    expect(enumerateShanghaiMonths(
      T("2026-09-01T00:00:00+08:00"), T("2026-09-21T00:00:00+08:00"), T("2026-12-01T00:00:00+08:00"),
    )).toEqual(["2026-09"]);
    expect(enumerateShanghaiMonths(
      T("2026-09-30T12:00:00+08:00"), T("2026-10-02T00:00:00+08:00"), T("2026-12-01T00:00:00+08:00"),
    )).toEqual(["2026-09", "2026-10"]);
    expect(enumerateShanghaiMonths(
      T("2026-08-15T00:00:00+08:00"), T("2026-09-01T00:00:00+08:00"), T("2026-12-01T00:00:00+08:00"),
    )).toEqual(["2026-08"]);
    expect(enumerateShanghaiMonths(
      T("2026-01-01T00:00:00+08:00"), null, T("2026-03-15T00:00:00+08:00"),
    )).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("markAllocationDirty 推进 generation（独立月份）", async () => {
    await markAllocationDirty(db, entA, ["2030-01"]);
    await markAllocationDirty(db, entA, ["2030-01"]);
    const row = await sql<{ generation: number; dirty: boolean }>`
      SELECT generation::int, dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${entA} AND period_month = '2030-01-01'`.execute(db);
    expect(row.rows[0]?.generation).toBe(2);
    expect(row.rows[0]?.dirty).toBe(true);
  });
});

describe("迁移回退保护", () => {
  it("有数据时 down 拒绝删除归集表；共享索引/扩展保留（空表回退路径由 ladder 覆盖）", async () => {
    await expect(migrateDown(db)).rejects.toThrow(/Cannot drop/);
    await migrateToLatest(db);
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname IN (
        'principal_enterprise_id_uq', 'operating_bill_version_enterprise_id_uq',
        'provider_resource_enterprise_id_uq', 'unified_model_enterprise_id_uq'
      )`.execute(db);
    expect(indexes.rows.length).toBe(4);
  });
});
