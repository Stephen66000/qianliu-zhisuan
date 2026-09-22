/**
 * 项目归集 API 集成测试（候选 C3 WP04/WP05：路由、权限、错误映射、幂等、列表增强）。
 * 权限负例含 P2-2：企业级规则入口无 operate → 403；跨企业/类型不符 → 统一 404。
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { FastifyInstance } from "fastify";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let superCookie: string;
let viewerCookie: string;
let viewerId: string;

const ent = randomUUID();
const entOther = randomUUID();
const admin = randomUUID();
const projectP = randomUUID();
const projectQ = randomUUID();
const employee1 = randomUUID();
const employeeOther = randomUUID();
const projectOtherEnt = randomUUID();

async function session(adminId: string): Promise<string> {
  const token = generateSessionToken();
  await app.adminRepo.createSession(adminId, digestSessionToken(token), new Date(Date.now() + 8 * 3600_000));
  return `qianliu_admin_session=${token}`;
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([
    { id: ent, name: "归集API企业" }, { id: entOther, name: "其他企业" },
  ]).execute();
  await db.insertInto("admin_user").values([
    { id: admin, enterprise_id: ent, username: "super", password_hash: "x" },
  ]).execute();
  viewerId = randomUUID();
  await db.insertInto("admin_user").values([
    { id: viewerId, enterprise_id: ent, username: "viewer", role_code: "CUSTOM", password_hash: "x" },
  ]).execute();
  await db.insertInto("admin_role").values([{
    enterprise_id: ent,
    name: "只读",
    permissions: { principals: { view: true, operate: false } },
  }]).execute();
  await db.insertInto("principal").values([
    { id: projectP, enterprise_id: ent, type: "PROJECT", name: "项目P" },
    { id: projectQ, enterprise_id: ent, type: "PROJECT", name: "项目Q" },
    { id: employee1, enterprise_id: ent, type: "EMPLOYEE", name: "员工1" },
    { id: projectOtherEnt, enterprise_id: entOther, type: "PROJECT", name: "他企项目" },
    { id: employeeOther, enterprise_id: entOther, type: "EMPLOYEE", name: "他企员工" },
  ]).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  superCookie = await session(admin);
  viewerCookie = await session(viewerId);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("成员与生命周期 API", () => {
  it("POST members：创建成功（201）+ 审计；重放 200 返回原结果", async () => {
    const key = `api-idem-${randomUUID()}`;
    const create = await app.inject({
      method: "POST", url: `/principals/${projectP}/project-memberships`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1, joinedAt: "2026-09-01", leftAt: null,
        weightBps: 6000, reason: "API 加入", idempotencyKey: key,
      },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.membershipId).toBeTruthy();
    expect(body.policyVersion).not.toBeNull();

    const replay = await app.inject({
      method: "POST", url: `/principals/${projectP}/project-memberships`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1, joinedAt: "2026-09-01", leftAt: null,
        weightBps: 6000, reason: "API 重放", idempotencyKey: key,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replay).toBe(true);
    expect(replay.json().membershipId).toBe(body.membershipId);
    expect(replay.json().policyVersion).toBe(body.policyVersion);

    const audit = await db.selectFrom("operation_log").select(["action"])
      .where("enterprise_id", "=", ent)
      .where("action", "=", "project_allocation.membership.create")
      .execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("日期排他边界（P3-1）：'参与至 9 月 20 日' → leftAt 为 9-21T00:00+08 的 ISO", async () => {
    const create = await app.inject({
      method: "POST", url: `/principals/${projectQ}/project-memberships`,
      headers: { cookie: superCookie },
      payload: { employeePrincipalId: employee1, joinedAt: "2026-10-01", leftAt: "2026-10-20", reason: "日期边界", idempotencyKey: `date-${randomUUID()}` },
    });
    expect(create.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET", url: `/principals/${projectQ}/project-memberships`,
      headers: { cookie: superCookie },
    });
    const row = list.json().rows[0];
    expect(row.leftAt).toBe("2026-10-20T16:00:00.000Z");
  });

  it("GET members：人数口径；修订 OCC 409；跨企业/类型不符统一 404；只读角色写 403", async () => {
    const list = await app.inject({
      method: "GET", url: `/principals/${projectP}/project-memberships`,
      headers: { cookie: superCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().counts.currentMembers).toBe(1);

    const conflict = await app.inject({
      method: "POST", url: `/principals/${projectP}/project-memberships/${list.json().rows[0].membershipId}/revisions`,
      headers: { cookie: superCookie },
      payload: { expectedRevision: 99, leftAt: "2026-10-01", reason: "过期" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("membership_revision_conflict");

    const cross = await app.inject({
      method: "GET", url: `/principals/${projectOtherEnt}/project-memberships`,
      headers: { cookie: superCookie },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error).toBe("not_found");

    const typeMismatch = await app.inject({
      method: "GET", url: `/principals/${employee1}/project-memberships`,
      headers: { cookie: superCookie },
    });
    expect(typeMismatch.statusCode).toBe(404);

    const forbidden = await app.inject({
      method: "POST", url: `/principals/${projectP}/project-memberships`,
      headers: { cookie: viewerCookie },
      payload: { employeePrincipalId: employee1, joinedAt: "2026-11-01", reason: "越权" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("生命周期：409 版本冲突与 201 成功", async () => {
    const conflict = await app.inject({
      method: "POST", url: `/principals/${projectP}/accounting-lifecycle-revisions`,
      headers: { cookie: superCookie },
      payload: { effectiveAt: "2026-08-01", reason: "过期", expectedVersion: 99 },
    });
    expect(conflict.statusCode).toBe(409);
    const ok = await app.inject({
      method: "POST", url: `/principals/${projectP}/accounting-lifecycle-revisions`,
      headers: { cookie: superCookie },
      payload: { effectiveAt: "2026-08-01", reason: "开始核算", expectedVersion: 0 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mode).toBe("STARTED");
  });
});

describe("企业级规则入口（P2-2 负例）", () => {
  it("GET policy：无 operate → 403；跨企业员工 → 404；超管 → 200", async () => {
    const forbidden = await app.inject({
      method: "GET", url: `/principals/${employee1}/project-allocation-policy`,
      headers: { cookie: viewerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe("permission_denied");

    const cross = await app.inject({
      method: "GET", url: `/principals/${employeeOther}/project-allocation-policy`,
      headers: { cookie: superCookie },
    });
    expect(cross.statusCode).toBe(404);

    const ok = await app.inject({
      method: "GET", url: `/principals/${employee1}/project-allocation-policy`,
      headers: { cookie: superCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().currentVersion).toBeGreaterThanOrEqual(1);
  });
});

describe("权重意图（项目页唯一合同）", () => {
  it("preview 返回 P2-1 口径；versions 发布新版本；过期版本 409 retryPreview", async () => {
    const preview = await app.inject({
      method: "POST", url: `/principals/${projectQ}/project-allocation-intents/preview`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1,
        expectedPolicyVersion: null,
        segments: [{ validFrom: "2026-10-05T00:00:00+08:00", validUntil: "2026-10-20T16:00:00.000Z", weightBps: 4000 }],
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().conflicts).toEqual([]);
    expect(preview.json().segments[0].availableBps).toBe(10000);
    expect(preview.json().segments[0].remainingBps).toBe(6000);

    const publish = await app.inject({
      method: "POST", url: `/principals/${projectQ}/project-allocation-intents/versions`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1,
        expectedPolicyVersion: preview.json().currentVersion,
        reason: "Q40", idempotencyKey: `intent-${randomUUID()}`,
        segments: [{ validFrom: "2026-10-05T00:00:00+08:00", validUntil: "2026-10-20T16:00:00.000Z", weightBps: 4000 }],
      },
    });
    expect(publish.statusCode).toBe(201);

    const stale = await app.inject({
      method: "POST", url: `/principals/${projectQ}/project-allocation-intents/versions`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1,
        expectedPolicyVersion: 0,
        reason: "过期", idempotencyKey: `stale-${randomUUID()}`,
        segments: [{ validFrom: "2026-10-05T00:00:00+08:00", validUntil: "2026-10-20T16:00:00.000Z", weightBps: 1000 }],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("allocation_policy_conflict");
    expect(stale.json().retryPreview).toBe(true);
  });

  it("超配意图返回 weight_exceeded 冲突段", async () => {
    const exceeded = await app.inject({
      method: "POST", url: `/principals/${projectQ}/project-allocation-intents/versions`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1,
        expectedPolicyVersion: null,
        reason: "超配", idempotencyKey: `over-${randomUUID()}`,
        segments: [{ validFrom: "2026-10-05T00:00:00+08:00", validUntil: "2026-10-20T16:00:00.000Z", weightBps: 10001 }],
      },
    });
    expect(exceeded.statusCode).toBe(400);
    expect(exceeded.json().error).toBe("weight_exceeded");
    expect(exceeded.json().conflicts[0].totalBps).toBe(16001);
  });
});

describe("项目账归集端点（WP05）", () => {
  it("status 未启用不返回假数据；enablement 创建；GET 纯读不建任务", async () => {
    const before = await app.inject({
      method: "GET", url: "/operating-bills/2026-09/project-allocation-status",
      headers: { cookie: superCookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().enabled).toBe(false);
    expect(before.json().currentRun).toBeNull();

    const enable = await app.inject({
      method: "POST", url: "/operating-bills/2026-09/project-allocation-enablement",
      headers: { cookie: superCookie },
      payload: { startMonth: "2026-09", reason: "启用" },
    });
    expect(enable.statusCode).toBe(201);

    const runsCount = await db.selectFrom("project_allocation_run").select(["id"])
      .where("enterprise_id", "=", ent).execute();
    expect(runsCount.length).toBe(1);

    const statusReads = await app.inject({
      method: "GET", url: "/operating-bills/2026-09/project-allocation-status",
      headers: { cookie: superCookie },
    });
    expect(statusReads.json().enabled).toBe(true);
    const afterReads = await db.selectFrom("project_allocation_run").select(["id"])
      .where("enterprise_id", "=", ent).execute();
    expect(afterReads.length).toBe(1);
  });

  it("增强后的项目列表：旧字段保留 + allocation/allocationStatus/unallocated 附加", async () => {
    const list = await app.inject({
      method: "GET", url: "/operating-bills/2026-09/projects",
      headers: { cookie: superCookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.month).toBe("2026-09");
    expect(body.allocationStatus).toBeTruthy();
    expect(typeof body.total).toBe("number");
    for (const row of body.rows) {
      expect(row.subjectId).toBeTruthy();
      expect(row.allocation !== undefined).toBe(true);
    }
  });

  it("明细与未分配端点：未计算时 runId=null 且不伪造数据", async () => {
    const lines = await app.inject({
      method: "GET", url: `/operating-bills/2026-09/projects/${projectP}/allocation-lines`,
      headers: { cookie: superCookie },
    });
    expect(lines.statusCode).toBe(200);
    expect(lines.json().runId).toBeNull();
    expect(lines.json().lines).toEqual([]);

    const unallocated = await app.inject({
      method: "GET", url: "/operating-bills/2026-09/project-unallocated",
      headers: { cookie: superCookie },
    });
    expect(unallocated.statusCode).toBe(200);
    expect(unallocated.json().runId).toBeNull();
  });

  it("只读角色：经营账归集 GET 允许（billing view 缺省拒绝）——principals 模块内只读入口 200", async () => {
    // viewer 只有 principals.view：/principals 列表读取应通过。
    const list = await app.inject({
      method: "GET", url: `/principals/${projectP}/project-memberships`,
      headers: { cookie: viewerCookie },
    });
    expect(list.statusCode).toBe(200);
  });

  it("80-P1-2：跨账期 run_id 统一 404；同月历史批次 200 且汇总明细同源", async () => {
    const sepRun = randomUUID();
    const augRun = randomUUID();
    await db.insertInto("project_allocation_run").values([
      { id: sepRun, enterprise_id: ent, period_month: "2026-09-01", schema_version: "1",
        algorithm_version: "1", status: "SUCCEEDED", generation: 1, actor_type: "SYSTEM",
        is_current: true, input_digest: "d-sep" },
      { id: augRun, enterprise_id: ent, period_month: "2026-08-01", schema_version: "1",
        algorithm_version: "1", status: "SUCCEEDED", generation: 1, actor_type: "SYSTEM",
        is_current: true, input_digest: "d-aug" },
    ]).execute();

    // 旧实现：HTTP 200，顶层来自 9 月、detail 来自 8 月（混用两个账期）。
    const crossMonth = await app.inject({
      method: "GET", url: `/operating-bills/2026-09/project-unallocated?run_id=${augRun}`,
      headers: { cookie: superCookie },
    });
    expect(crossMonth.statusCode).toBe(404);
    expect(crossMonth.json().error).toBe("not_found");

    // R06 P2-1：非法批次标识（含字面 null/空串形态）不得透传到 PG（500），统一 400。
    for (const bad of ["not-a-uuid", "null", ""]) {
      const badDetail = await app.inject({
        method: "GET", url: `/operating-bills/2026-09/project-unallocated?run_id=${encodeURIComponent(bad)}`,
        headers: { cookie: superCookie },
      });
      expect(badDetail.statusCode, `unallocated run_id=${bad}`).toBe(400);
      const badLines = await app.inject({
        method: "GET", url: `/operating-bills/2026-09/projects/${projectP}/allocation-lines?run_id=${encodeURIComponent(bad)}`,
        headers: { cookie: superCookie },
      });
      expect(badLines.statusCode, `allocation-lines run_id=${bad}`).toBe(400);
      expect(badLines.json().error).toBe("invalid_request");
    }

    const linesCross = await app.inject({
      method: "GET", url: `/operating-bills/2026-09/projects/${projectP}/allocation-lines?run_id=${augRun}`,
      headers: { cookie: superCookie },
    });
    expect(linesCross.statusCode).toBe(404);
    expect(linesCross.json().error).toBe("not_found");

    // 同月历史批次（9 月的 current 之外再造一个非 current 成功批次）：可读且同源。
    const sepHistorical = randomUUID();
    await db.insertInto("project_allocation_run").values({
      id: sepHistorical, enterprise_id: ent, period_month: "2026-09-01", schema_version: "1",
      algorithm_version: "1", status: "SUCCEEDED", generation: 1, actor_type: "SYSTEM",
      is_current: false, input_digest: "d-sep-hist",
    }).execute();
    const sameMonth = await app.inject({
      method: "GET", url: `/operating-bills/2026-09/project-unallocated?run_id=${sepHistorical}`,
      headers: { cookie: superCookie },
    });
    expect(sameMonth.statusCode).toBe(200);
    const body = sameMonth.json();
    expect(body.runId).toBe(sepHistorical);
    expect(body.detail.runId).toBe(sepHistorical);
  });

  it("80-P1-1：意图段真实校验——空对象/缺字段/超范围一律 400，不再静默补默认值", async () => {
    const badBodies = [
      { employeePrincipalId: employee1, segments: [{}] },
      { employeePrincipalId: employee1, segments: [{ validFrom: "2026-09-01T00:00:00+08:00" }] },
      { employeePrincipalId: employee1, segments: [{ weightBps: 1.5, validFrom: "2026-09-01T00:00:00+08:00" }] },
      { employeePrincipalId: employee1, segments: [{ weightBps: -1, validFrom: "2026-09-01T00:00:00+08:00" }] },
      { employeePrincipalId: employee1, segments: [{ weightBps: 4000 }] },
      { employeePrincipalId: employee1, segments: [{ weightBps: 4000, validFrom: "not-a-date" }] },
      { employeePrincipalId: employee1,
        segments: [{ weightBps: 4000, validFrom: "2026-09-01T00:00:00+08:00", validUntil: "not-a-date" }] },
      { employeePrincipalId: employee1,
        segments: [{ weightBps: 4000, validFrom: "2026-09-10T00:00:00+08:00", validUntil: "2026-09-01T00:00:00+08:00" }] },
      { employeePrincipalId: employee1, segments: "not-an-array" },
      { employeePrincipalId: employee1, segments: [null] },
    ];
    for (const [i, payload] of badBodies.entries()) {
      const preview = await app.inject({
        method: "POST", url: `/principals/${projectP}/project-allocation-intents/preview`,
        headers: { cookie: superCookie }, payload,
      });
      expect(preview.statusCode, `preview case ${i}`).toBe(400);
      const publish = await app.inject({
        method: "POST", url: `/principals/${projectP}/project-allocation-intents/versions`,
        headers: { cookie: superCookie },
        payload: { ...payload, expectedPolicyVersion: 0, reason: "80-P1-1 负例" },
      });
      expect(publish.statusCode, `publish case ${i}`).toBe(400);
      expect(publish.json().error).toBe("invalid_request");
    }

    // 合法段（有生效成员关系的员工 + 真实区间）照常通过：校验不误伤。
    const ok = await app.inject({
      method: "POST", url: `/principals/${projectP}/project-allocation-intents/preview`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1,
        segments: [{ weightBps: 4000, validFrom: "2026-09-01T00:00:00+08:00", validUntil: null }],
      },
    });
    expect(ok.statusCode).toBe(200);

    // 单段 >10000 不在路由层拦截：保留域级 weight_exceeded 结构化冲突（既有合同）。
    const overBps = await app.inject({
      method: "POST", url: `/principals/${projectP}/project-allocation-intents/versions`,
      headers: { cookie: superCookie },
      payload: {
        employeePrincipalId: employee1, expectedPolicyVersion: null, reason: "超上界",
        segments: [{ weightBps: 10001, validFrom: "2026-10-05T00:00:00+08:00" }],
      },
    });
    expect(overBps.statusCode).toBe(400);
    expect(overBps.json().error).toBe("weight_exceeded");
  });

  it("F-2：项目明细主体类型合同——不存在/跨企业/类型不符统一 404，不返回 200 空集", async () => {
    const cases: Array<[string, string]> = [
      ["不存在的项目", randomUUID()],
      ["跨企业项目", projectOtherEnt],
      ["员工 ID 冒充项目", employee1],
    ];
    for (const [label, id] of cases) {
      const response = await app.inject({
        method: "GET", url: `/operating-bills/2026-09/projects/${id}/allocation-lines`,
        headers: { cookie: superCookie },
      });
      expect(response.statusCode, label).toBe(404);
      expect(response.json().error, label).toBe("not_found");
    }
  });

  it("F-3：未分配端点返回汇总及明细；跨企业员工筛选 404、非法标识 400", async () => {
    const ok = await app.inject({
      method: "GET", url: "/operating-bills/2026-09/project-unallocated?reason=NO_MEMBERSHIP&limit=5",
      headers: { cookie: superCookie },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.detail).toBeTruthy();
    expect(Array.isArray(body.detail.lines)).toBe(true);
    expect(typeof body.detail.total).toBe("number");
    expect(body.detail.limit).toBe(5);

    const crossEnterprise = await app.inject({
      method: "GET", url: `/operating-bills/2026-09/project-unallocated?employee_id=${employeeOther}`,
      headers: { cookie: superCookie },
    });
    expect(crossEnterprise.statusCode).toBe(404);

    const malformed = await app.inject({
      method: "GET", url: "/operating-bills/2026-09/project-unallocated?resource_id=not-a-uuid",
      headers: { cookie: superCookie },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("invalid_request");
  });
});
