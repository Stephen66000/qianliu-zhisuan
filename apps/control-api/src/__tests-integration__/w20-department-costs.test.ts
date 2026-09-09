import { randomUUID } from "node:crypto";
import cookiePlugin from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  AdminRepository,
  AlertEventRepository,
  createKysely,
  DEFAULT_THRESHOLDS,
  GatewayLedgerRepository,
  migrateToLatest,
  OperatingBillRepository,
  PrincipalRepository,
} from "@qianliu/database";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { registerDepartmentCostRoutes } from "../department-costs/routes.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import { registerPrincipalRoutes } from "../principals/routes.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let authCookie: string;
let otherCookie: string;

const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const adminId = randomUUID();
const otherAdminId = randomUUID();
const employeeId = randomUUID();
const projectId = randomUUID();
const keyId = randomUUID();
const departmentA = randomUUID();
const departmentB = randomUUID();
const otherDepartment = randomUUID();
let apiResourceId: string;
let planResourceId: string;
let firstPurchaseId: string;

interface FrozenDepartmentSnapshotRow {
  version: number;
  snapshot: {
    sourceFacts: {
      departmentAttributionFacts: Array<Record<string, unknown>>;
      departmentBudgetFacts: Array<Record<string, unknown>>;
      resourcePurchaseFacts: Array<Record<string, unknown>>;
    };
  };
}

async function sessionCookie(repository: AdminRepository, adminUserId: string): Promise<string> {
  const token = generateSessionToken();
  await repository.createSession(adminUserId, digestSessionToken(token), new Date(Date.now() + 60_000));
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function addApiUsage(input: {
  cost: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: Date;
}): Promise<string> {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: employeeId,
    principal_key_id: keyId, protocol: "chat", unified_model: "ql-test",
    status: "SUCCEEDED", started_at: input.startedAt,
    finished_at: new Date(input.startedAt.getTime() + 100),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
    provider_resource_id: apiResourceId, upstream_model: "test-upstream",
    finished_at: new Date(input.startedAt.getTime() + 100), http_status: 200,
    response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: apiResourceId, input_tokens: BigInt(input.inputTokens),
    output_tokens: BigInt(input.outputTokens), cache_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: `w20-dept-${requestId}`,
    created_at: input.startedAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: apiResourceId,
    principal_id: employeeId, resource_mode: "API",
    raw_input_tokens: BigInt(input.inputTokens), raw_output_tokens: BigInt(input.outputTokens),
    raw_cache_tokens: 0n, deducted_quota: null, api_cost: input.cost,
    usage_quality: "PROVIDER_REPORTED", created_at: input.startedAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, principal_id: employeeId,
    total_input_tokens: BigInt(input.inputTokens),
    total_output_tokens: BigInt(input.outputTokens), total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: input.cost,
    usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED",
    created_at: input.startedAt,
  }).execute();
  return requestId;
}

async function settleApiUsage(input: {
  principalId: string;
  principalKeyId: string;
  cost: string;
  tokens: number;
  startedAt: Date;
  resourceId?: string;
  resourceMode?: "API" | "CODING_PLAN";
  deductedQuota?: number | null;
  beforeFinalize?: (requestId: string) => Promise<void>;
}): Promise<string> {
  const requestId = randomUUID();
  const resourceId = input.resourceId ?? apiResourceId;
  const resourceMode = input.resourceMode ?? "API";
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: input.principalId,
    principal_key_id: input.principalKeyId, protocol: "chat", unified_model: "ql-attribution",
    status: "IN_PROGRESS", started_at: input.startedAt,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
    provider_resource_id: resourceId, upstream_model: "attribution-upstream",
    finished_at: new Date(input.startedAt.getTime() + 100), http_status: 200,
    response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId, input_tokens: BigInt(input.tokens), output_tokens: 0n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: `w20-attribution-${requestId}`, created_at: input.startedAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
    principal_id: input.principalId, resource_mode: resourceMode,
    raw_input_tokens: BigInt(input.tokens), raw_output_tokens: 0n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    deducted_quota: input.deductedQuota === null || input.deductedQuota === undefined
      ? null : BigInt(input.deductedQuota),
    api_cost: input.cost, usage_quality: "PROVIDER_REPORTED", created_at: input.startedAt,
  }).execute();
  await input.beforeFinalize?.(requestId);
  await new GatewayLedgerRepository(db).finalizeLedgerSettlementIfAbsent({
    ai_request_id: requestId, enterprise_id: enterpriseId, principal_id: input.principalId,
    total_input_tokens: BigInt(input.tokens), total_output_tokens: 0n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: BigInt(input.deductedQuota ?? 0),
    total_api_cost: input.cost,
    usage_quality: "PROVIDER_REPORTED", attempt_count: 1, request_status: "SUCCEEDED",
  });
  return requestId;
}

beforeAll(async () => {
  pg = process.env.W20_DEPARTMENT_DATABASE_URL
    ? { connectionString: process.env.W20_DEPARTMENT_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer("w20_department_costs");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "W20 部门账企业" },
    { id: otherEnterpriseId, name: "W20 隔离企业" },
  ]).execute();
  await db.insertInto("admin_user").values([
    {
      id: adminId, enterprise_id: enterpriseId, username: "w20-dept-admin",
      display_name: "经营管理员", password_hash: "not-used-in-session-test",
    },
    {
      id: otherAdminId, enterprise_id: otherEnterpriseId, username: "w20-dept-other",
      display_name: "隔离管理员", password_hash: "not-used-in-session-test",
    },
  ]).execute();
  await sql`
    INSERT INTO organization_unit (id, enterprise_id, name, external_unit_id)
    VALUES (${departmentA}::uuid, ${enterpriseId}::uuid, '研发部', 'dept-a'),
           (${departmentB}::uuid, ${enterpriseId}::uuid, '产品部', 'dept-b'),
           (${otherDepartment}::uuid, ${otherEnterpriseId}::uuid, '隔离部门', 'dept-other')
  `.execute(db);
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "测试员工", department_label: "不得读取的旧标签" },
    { id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "测试项目" },
  ]).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: employeeId,
    key_prefix: "ql_w20_dept", key_digest: randomUUID(),
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "w20-provider", name: "W20 Provider", adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "API 账户",
    mode: "API", credential_type: "API_KEY",
  }).returning(["id", "provider_id"]).executeTakeFirstOrThrow();
  apiResourceId = resource.id;

  const attributedRequest = await addApiUsage({
    cost: "2.50000000", inputTokens: 100, outputTokens: 20,
    startedAt: new Date("2026-08-08T01:00:00Z"),
  });
  await addApiUsage({
    cost: "1.50000000", inputTokens: 50, outputTokens: 10,
    startedAt: new Date("2026-08-08T02:00:00Z"),
  });
  const firstAttribution = await sql<{ id: string }>`
    INSERT INTO request_attribution_snapshot
      (enterprise_id, ai_request_id, source_principal_id, organization_unit_id,
       cost_category, attribution_source, request_occurred_at, version, snapshot_origin)
    VALUES (${enterpriseId}::uuid, ${attributedRequest}::uuid, ${employeeId}::uuid,
            ${departmentA}::uuid, 'EMPLOYEE_DIRECT', 'EMPLOYEE_MEMBERSHIP',
            '2026-08-08T01:00:00Z'::timestamptz, 1, 'RUNTIME')
    RETURNING id
  `.execute(db);
  await sql`
    INSERT INTO request_attribution_snapshot
      (enterprise_id, ai_request_id, source_principal_id, project_principal_id,
       organization_unit_id, cost_category, attribution_source, request_occurred_at,
       version, supersedes_id, snapshot_origin)
    VALUES (${enterpriseId}::uuid, ${attributedRequest}::uuid, ${employeeId}::uuid,
            ${projectId}::uuid, ${departmentB}::uuid, 'PROJECT', 'EMPLOYEE_PROJECT',
            '2026-08-08T01:00:00Z'::timestamptz, 2,
            ${firstAttribution.rows[0]!.id}::uuid, 'CORRECTION')
  `.execute(db);

  app = Fastify({ logger: false });
  app.decorate("db", db);
  const adminRepository = new AdminRepository(db);
  app.decorate("adminRepo", adminRepository);
  app.decorate("principalRepo", new PrincipalRepository(db));
  await app.register(cookiePlugin, { secret: "w20-department-test-cookie-secret" });
  registerDepartmentCostRoutes(app);
  registerPrincipalRoutes(app);
  await app.ready();
  authCookie = await sessionCookie(adminRepository, adminId);
  otherCookie = await sessionCookie(adminRepository, otherAdminId);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("W20-06/07 部门预算、唯一归属与采购记录", () => {
  it("仅读取归属快照最高版本，待归属与 API 成本/Token 严格守恒", async () => {
    const response = await app.inject({
      method: "GET", url: "/operating-bills/2026-08/departments", headers: { cookie: authCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      month: "2026-08", timezone: "Asia/Shanghai",
      totals: { inputTokens: "150", outputTokens: "30", actualTokens: "180", apiCost: "4.00000000" },
      conservation: {
        status: "BALANCED", tokenDifference: "0", apiCostDifference: "0.00000000",
      },
    });
    expect(body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        departmentId: departmentA, departmentName: "研发部", totalCost: "0.00000000",
      }),
      expect.objectContaining({
        departmentId: departmentB, departmentName: "产品部", projectCost: "2.50000000",
        employeeDirectCost: "0.00000000", actualTokens: "120", totalCost: "2.50000000",
      }),
      expect.objectContaining({
        departmentId: null, departmentName: "待归属", totalCost: "1.50000000",
        actualTokens: "60", attributionSnapshotMissingCount: 1,
      }),
    ]));
    expect(JSON.stringify(body)).not.toContain("不得读取的旧标签");

    const periodsBefore = await db.selectFrom("operating_bill_period").select("id").execute();
    const checked = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/check", headers: { cookie: authCookie },
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      ok: false, conservation: { status: "BALANCED" },
      gaps: expect.arrayContaining([{ code: "ATTRIBUTION_SNAPSHOT_MISSING", severity: "WARNING" }]),
    });
    expect(await db.selectFrom("operating_bill_period").select("id").execute()).toEqual(periodsBefore);
  });

  it("项目部门显式归属使用乐观锁，历史只关闭不覆盖且审计不重放", async () => {
    const created = await app.inject({
      method: "PUT", url: `/principals/${projectId}/department-assignment`,
      headers: { cookie: authCookie },
      payload: { organization_unit_id: departmentA, expected_version: 0, reason: "首次明确归属" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      assignment: {
        project_principal_id: projectId, organization_unit_id: departmentA,
        department_name: "研发部", source: "EXPLICIT", version: 1,
      },
      replayed: false,
    });

    const replay = await app.inject({
      method: "PUT", url: `/principals/${projectId}/department-assignment`,
      headers: { cookie: authCookie },
      payload: { organization_unit_id: departmentA, expected_version: 1, reason: "重放不产生新版本" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ assignment: { version: 1 }, replayed: true });

    const stale = await app.inject({
      method: "PUT", url: `/principals/${projectId}/department-assignment`,
      headers: { cookie: authCookie },
      payload: { organization_unit_id: departmentB, expected_version: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "conflict" });

    const changed = await app.inject({
      method: "PUT", url: `/principals/${projectId}/department-assignment`,
      headers: { cookie: authCookie },
      payload: { organization_unit_id: departmentB, expected_version: 1, reason: "从下一请求起使用新部门" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      assignment: { organization_unit_id: departmentB, department_name: "产品部", version: 2 },
      replayed: false,
    });
    const current = await app.inject({
      method: "GET", url: `/principals/${projectId}/department-assignment`,
      headers: { cookie: authCookie },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      assignment: { organization_unit_id: departmentB, version: 2 },
    });
    expect((await app.inject({
      method: "GET", url: `/principals/${projectId}/department-assignment`,
      headers: { cookie: otherCookie },
    })).statusCode).toBe(404);

    const history = await db.selectFrom("project_department_assignment")
      .select(["organization_unit_id", "version", "valid_from", "valid_until"])
      .where("enterprise_id", "=", enterpriseId)
      .where("project_principal_id", "=", projectId)
      .orderBy("version").execute();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ organization_unit_id: departmentA, version: 1 });
    expect(history[0]!.valid_until).toEqual(history[1]!.valid_from);
    expect(history[1]).toMatchObject({
      organization_unit_id: departmentB, version: 2, valid_until: null,
    });
    const audit = await db.selectFrom("operation_log")
      .select(["change_summary", "target_id"])
      .where("enterprise_id", "=", enterpriseId)
      .where("action", "=", "project.department_assignment.update")
      .where("target_id", "=", projectId)
      .orderBy("created_at").execute();
    expect(audit).toHaveLength(2);
    expect(audit[0]!.change_summary).toMatchObject({
      previous_department_id: null, organization_unit_id: departmentA, assignment_version: 1,
    });
    expect(audit[1]!.change_summary).toMatchObject({
      previous_department_id: departmentA, organization_unit_id: departmentB, assignment_version: 2,
    });
  });

  it("员工直接、员工归项目、项目直发和待归属只计一次，调岗不改历史", async () => {
    const personId = randomUUID();
    const nextOwnerPersonId = randomUUID();
    const directEmployeeId = randomUUID();
    const directEmployeeKeyId = randomUUID();
    const unassignedEmployeeId = randomUUID();
    const unassignedEmployeeKeyId = randomUUID();
    const attributionProjectId = randomUUID();
    const attributionProjectKeyId = randomUUID();
    await db.insertInto("person").values([
      {
        id: personId, enterprise_id: enterpriseId, name: "跨期员工",
        department_label: "不作历史依据",
      },
      {
        id: nextOwnerPersonId, enterprise_id: enterpriseId, name: "新项目负责人",
        department_label: "不反推项目历史部门",
      },
    ]).execute();
    await db.insertInto("principal").values([
      {
        id: directEmployeeId, enterprise_id: enterpriseId, type: "EMPLOYEE",
        name: "跨期员工", person_id: personId, department_label: "不作历史依据",
      },
      {
        id: unassignedEmployeeId, enterprise_id: enterpriseId, type: "EMPLOYEE",
        name: "无人事关系员工", department_label: "猜测部门",
      },
      {
        id: attributionProjectId, enterprise_id: enterpriseId, type: "PROJECT",
        name: "唯一归属项目", department_label: "当前标签不是依据",
        owner_person_id: personId,
      },
    ]).execute();
    await db.insertInto("principal_key").values([
      {
        id: directEmployeeKeyId, enterprise_id: enterpriseId, principal_id: directEmployeeId,
        key_prefix: "ql_w20_direct", key_digest: randomUUID(),
      },
      {
        id: unassignedEmployeeKeyId, enterprise_id: enterpriseId, principal_id: unassignedEmployeeId,
        key_prefix: "ql_w20_unassigned", key_digest: randomUUID(),
      },
      {
        id: attributionProjectKeyId, enterprise_id: enterpriseId, principal_id: attributionProjectId,
        key_prefix: "ql_w20_project", key_digest: randomUUID(),
      },
    ]).execute();
    await sql`
      INSERT INTO organization_membership
        (enterprise_id, person_id, organization_unit_id, is_primary,
         valid_from, valid_until, source, version)
      VALUES (${enterpriseId}::uuid, ${personId}::uuid, ${departmentA}::uuid, true,
              '2026-01-01T00:00:00Z'::timestamptz, '2026-11-15T00:00:00Z'::timestamptz,
              'EXCEL', 1),
             (${enterpriseId}::uuid, ${personId}::uuid, ${departmentB}::uuid, true,
              '2026-11-15T00:00:00Z'::timestamptz, NULL, 'EXCEL', 2)
    `.execute(db);
    await db.insertInto("project_department_assignment").values({
      enterprise_id: enterpriseId, project_principal_id: attributionProjectId,
      organization_unit_id: departmentA, valid_from: new Date("2026-01-01T00:00:00Z"),
      valid_until: null, source: "EXPLICIT", owner_person_id_at_assignment: personId,
      version: 1, created_by: adminId, reason: "项目明确归属研发部",
    }).execute();

    const directBeforeMove = await settleApiUsage({
      principalId: directEmployeeId, principalKeyId: directEmployeeKeyId,
      cost: "1.00000000", tokens: 10, startedAt: new Date("2026-11-10T02:00:00Z"),
    });
    const directAfterMove = await settleApiUsage({
      principalId: directEmployeeId, principalKeyId: directEmployeeKeyId,
      cost: "2.00000000", tokens: 20, startedAt: new Date("2026-11-20T02:00:00Z"),
    });
    const employeeProject = await settleApiUsage({
      principalId: directEmployeeId, principalKeyId: directEmployeeKeyId,
      cost: "3.00000000", tokens: 30, startedAt: new Date("2026-11-21T02:00:00Z"),
      beforeFinalize: async (requestId) => {
        await db.insertInto("operating_bill_request_project_assignment").values({
          enterprise_id: enterpriseId, ai_request_id: requestId,
          project_principal_id: attributionProjectId, assigned_by: adminId,
          reason: "显式归入项目",
        }).execute();
      },
    });
    const projectDirect = await settleApiUsage({
      principalId: attributionProjectId, principalKeyId: attributionProjectKeyId,
      cost: "4.00000000", tokens: 40, startedAt: new Date("2026-11-22T02:00:00Z"),
    });
    const unassigned = await settleApiUsage({
      principalId: unassignedEmployeeId, principalKeyId: unassignedEmployeeKeyId,
      cost: "5.00000000", tokens: 50, startedAt: new Date("2026-11-23T02:00:00Z"),
    });

    const requestIds = [directBeforeMove, directAfterMove, employeeProject, projectDirect, unassigned];
    const snapshots = await db.selectFrom("request_attribution_snapshot")
      .selectAll().where("enterprise_id", "=", enterpriseId)
      .where("ai_request_id", "in", requestIds).execute();
    expect(snapshots).toHaveLength(5);
    const byRequest = new Map(snapshots.map((snapshot) => [snapshot.ai_request_id, snapshot]));
    expect(byRequest.get(directBeforeMove)).toMatchObject({
      organization_unit_id: departmentA, cost_category: "EMPLOYEE_DIRECT",
      attribution_source: "EMPLOYEE_MEMBERSHIP", version: 1,
    });
    expect(byRequest.get(directAfterMove)).toMatchObject({
      organization_unit_id: departmentB, cost_category: "EMPLOYEE_DIRECT",
      attribution_source: "EMPLOYEE_MEMBERSHIP", version: 1,
    });
    expect(byRequest.get(employeeProject)).toMatchObject({
      organization_unit_id: departmentA, project_principal_id: attributionProjectId,
      cost_category: "PROJECT", attribution_source: "EMPLOYEE_PROJECT", version: 1,
    });
    expect(byRequest.get(projectDirect)).toMatchObject({
      organization_unit_id: departmentA, project_principal_id: attributionProjectId,
      cost_category: "PROJECT", attribution_source: "PROJECT_DIRECT", version: 1,
    });
    expect(byRequest.get(unassigned)).toMatchObject({
      organization_unit_id: null, cost_category: "UNASSIGNED",
      attribution_source: "UNASSIGNED", reason_code: "PERSON_MISSING", version: 1,
    });
    await expect(db.updateTable("request_attribution_snapshot")
      .set({ organization_unit_id: departmentB })
      .where("enterprise_id", "=", enterpriseId)
      .where("ai_request_id", "=", directBeforeMove).execute())
      .rejects.toMatchObject({ code: "55000" });

    await db.updateTable("principal").set({ owner_person_id: nextOwnerPersonId })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", attributionProjectId)
      .execute();
    expect(await db.selectFrom("project_department_assignment")
      .select(["organization_unit_id", "owner_person_id_at_assignment"])
      .where("enterprise_id", "=", enterpriseId)
      .where("project_principal_id", "=", attributionProjectId)
      .where("valid_until", "is", null).executeTakeFirstOrThrow()).toEqual({
      organization_unit_id: departmentA, owner_person_id_at_assignment: personId,
    });
    expect((await db.selectFrom("request_attribution_snapshot")
      .select("organization_unit_id").where("enterprise_id", "=", enterpriseId)
      .where("ai_request_id", "in", [employeeProject, projectDirect]).execute())
      .map((row) => row.organization_unit_id)).toEqual([departmentA, departmentA]);

    // 后续再次调岗只增加新 Membership，已结算请求快照不回写。
    await db.updateTable("organization_membership").set({
      valid_until: new Date("2026-12-01T00:00:00Z"), updated_at: new Date(),
    }).where("enterprise_id", "=", enterpriseId).where("person_id", "=", personId)
      .where("valid_until", "is", null).execute();
    await db.insertInto("organization_membership").values({
      enterprise_id: enterpriseId, person_id: personId, organization_unit_id: departmentA,
      is_primary: true, valid_from: new Date("2026-12-01T00:00:00Z"),
      valid_until: null, source: "EXCEL", version: 3,
    }).execute();
    const historyAfterMove = await db.selectFrom("request_attribution_snapshot")
      .select(["ai_request_id", "organization_unit_id", "version"])
      .where("enterprise_id", "=", enterpriseId)
      .where("ai_request_id", "in", [directBeforeMove, directAfterMove]).execute();
    expect(historyAfterMove).toEqual(expect.arrayContaining([
      { ai_request_id: directBeforeMove, organization_unit_id: departmentA, version: 1 },
      { ai_request_id: directAfterMove, organization_unit_id: departmentB, version: 1 },
    ]));

    const bill = await app.inject({
      method: "GET", url: "/operating-bills/2026-11/departments",
      headers: { cookie: authCookie },
    });
    expect(bill.statusCode).toBe(200);
    expect(bill.json()).toMatchObject({
      totals: { actualTokens: "150", apiCost: "15.00000000", totalCost: "15.00000000" },
      conservation: {
        status: "BALANCED", tokenDifference: "0", apiCostDifference: "0.00000000",
        totalCostDifference: "0.00000000",
      },
      rows: expect.arrayContaining([
        expect.objectContaining({
          departmentId: departmentA, employeeDirectCost: "1.00000000",
          projectCost: "7.00000000", totalCost: "8.00000000", actualTokens: "80",
        }),
        expect.objectContaining({
          departmentId: departmentB, employeeDirectCost: "2.00000000",
          projectCost: "0.00000000", totalCost: "2.00000000", actualTokens: "20",
        }),
        expect.objectContaining({
          departmentId: null, totalCost: "5.00000000", actualTokens: "50",
          attributionSnapshotMissingCount: 0,
        }),
      ]),
    });
  });

  it("补录项目归属按企业时区判定账期，并追加而不覆盖 Attribution", async () => {
    await db.updateTable("enterprise").set({ timezone: "UTC" })
      .where("id", "=", enterpriseId).execute();
    try {
      // UTC 仍属 12 月，Asia/Shanghai 已是次年 1 月；这个边界可防止回落硬编码时区。
      const requestId = await settleApiUsage({
        principalId: employeeId, principalKeyId: keyId, cost: "0.75000000", tokens: 7,
        startedAt: new Date("2026-12-31T16:30:00Z"),
      });
      await new OperatingBillRepository(db).assignRequestToProject({
        enterpriseId, adminId, month: "2026-12", requestId,
        projectPrincipalId: projectId, reason: "按企业时区补录项目",
      });
      const snapshots = await db.selectFrom("request_attribution_snapshot").selectAll()
        .where("enterprise_id", "=", enterpriseId).where("ai_request_id", "=", requestId)
        .orderBy("version").execute();
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toMatchObject({
        cost_category: "UNASSIGNED", attribution_source: "UNASSIGNED", version: 1,
      });
      expect(snapshots[1]).toMatchObject({
        project_principal_id: projectId, organization_unit_id: departmentB,
        cost_category: "PROJECT", attribution_source: "EMPLOYEE_PROJECT",
        snapshot_origin: "CORRECTION", supersedes_id: snapshots[0]!.id, version: 2,
      });
    } finally {
      await db.updateTable("enterprise").set({ timezone: "Asia/Shanghai" })
        .where("id", "=", enterpriseId).execute();
    }
  });

  it("结算生产路径冻结时点归属，关账/重开后各版本稳定", async () => {
    const personId = randomUUID();
    const principalId = randomUUID();
    const principalKeyId = randomUUID();
    const requestId = randomUUID();
    const usedAt = new Date("2026-10-12T03:00:00Z");
    await db.insertInto("person").values({
      id: personId, enterprise_id: enterpriseId, name: "归属快照员工",
      department_label: "错误旧标签",
    }).execute();
    await sql`
      INSERT INTO organization_membership
        (enterprise_id, person_id, organization_unit_id, is_primary, valid_from, source)
      VALUES (${enterpriseId}::uuid, ${personId}::uuid, ${departmentA}::uuid,
              true, '2026-01-01T00:00:00Z'::timestamptz, 'EXCEL')
    `.execute(db);
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE",
      name: "归属快照员工", person_id: personId, department_label: "错误旧标签",
    }).execute();
    await db.insertInto("principal_key").values({
      id: principalKeyId, enterprise_id: enterpriseId, principal_id: principalId,
      key_prefix: "ql_w20_freeze", key_digest: randomUUID(),
    }).execute();
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: principalKeyId, protocol: "chat", unified_model: "ql-freeze",
      status: "IN_PROGRESS", started_at: usedAt,
    }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
      provider_resource_id: apiResourceId, upstream_model: "freeze-upstream",
      finished_at: new Date(usedAt.getTime() + 100), http_status: 200,
      response_committed: true,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: apiResourceId, input_tokens: 80n, output_tokens: 20n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `w20-freeze-${requestId}`, created_at: usedAt,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
      upstream_attempt_id: attempt.id, provider_resource_id: apiResourceId,
      principal_id: principalId, resource_mode: "API", raw_input_tokens: 80n,
      raw_output_tokens: 20n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      deducted_quota: null, api_cost: "3.25000000", usage_quality: "PROVIDER_REPORTED",
      created_at: usedAt,
    }).execute();
    const finalization = {
      ai_request_id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
      total_input_tokens: 80n, total_output_tokens: 20n, total_cache_tokens: 0n,
      total_reasoning_tokens: 0n, total_deducted_quota: 0n,
      total_api_cost: "3.25000000", usage_quality: "PROVIDER_REPORTED",
      attempt_count: 1, request_status: "SUCCEEDED",
    } as const;
    const ledgerRepo = new GatewayLedgerRepository(db);
    await ledgerRepo.finalizeLedgerSettlementIfAbsent(finalization);
    await ledgerRepo.finalizeLedgerSettlementIfAbsent(finalization);
    const runtimeSnapshots = await db.selectFrom("request_attribution_snapshot")
      .selectAll().where("enterprise_id", "=", enterpriseId)
      .where("ai_request_id", "=", requestId).orderBy("version").execute();
    expect(runtimeSnapshots).toHaveLength(1);
    expect(runtimeSnapshots[0]).toMatchObject({
      organization_unit_id: departmentA,
      cost_category: "EMPLOYEE_DIRECT",
      attribution_source: "EMPLOYEE_MEMBERSHIP",
      snapshot_origin: "RUNTIME",
    });

    await sql`
      INSERT INTO department_budget
        (enterprise_id, organization_unit_id, month, currency, amount,
         warning_threshold, updated_by)
      VALUES (${enterpriseId}::uuid, ${departmentA}::uuid, '2026-10-01'::date,
              'CNY', 10, 0.8, ${adminId}::uuid)
    `.execute(db);
    const purchaseOne = randomUUID();
    await sql`
      INSERT INTO resource_purchase_record
        (id, enterprise_id, provider_resource_id, purchase_type, amount, currency,
         purchased_at, source, created_by)
      VALUES (${purchaseOne}::uuid, ${enterpriseId}::uuid, ${apiResourceId}::uuid,
              'API_RECHARGE', 100, 'CNY', '2026-10-05T08:00:00+08:00'::timestamptz,
              'ADMIN', ${adminId}::uuid)
    `.execute(db);

    const billRepo = new OperatingBillRepository(db);
    await billRepo.closeMonth({
      enterpriseId, adminId, month: "2026-10", allowIncomplete: true,
      note: "测试部门证据冻结",
    });
    const closedResponse = await app.inject({
      method: "GET", url: "/operating-bills/2026-10/departments",
      headers: { cookie: authCookie },
    });
    expect(closedResponse.statusCode).toBe(200);
    expect(closedResponse.json()).toMatchObject({
      status: "CLOSED", version: 1,
      rows: expect.arrayContaining([expect.objectContaining({
        departmentId: departmentA, totalCost: "3.25000000",
        budget: expect.objectContaining({ amount: "10.00000000" }),
      })]),
    });

    const firstSnapshotId = runtimeSnapshots[0]!.id;
    await sql`
      INSERT INTO request_attribution_snapshot
        (enterprise_id, ai_request_id, source_principal_id, employee_person_id,
         organization_unit_id, cost_category, attribution_source, request_occurred_at,
         version, supersedes_id, snapshot_origin, created_by)
      VALUES (${enterpriseId}::uuid, ${requestId}::uuid, ${principalId}::uuid,
              ${personId}::uuid, ${departmentB}::uuid, 'EMPLOYEE_DIRECT',
              'EMPLOYEE_MEMBERSHIP', ${usedAt}, 2, ${firstSnapshotId}::uuid,
              'CORRECTION', ${adminId}::uuid)
    `.execute(db);
    await sql`
      UPDATE department_budget SET amount = 1, version = version + 1, updated_at = now()
       WHERE enterprise_id = ${enterpriseId}::uuid
         AND organization_unit_id = ${departmentA}::uuid AND month = '2026-10-01'::date
    `.execute(db);
    const purchaseTwo = randomUUID();
    await sql`
      INSERT INTO resource_purchase_record
        (id, enterprise_id, provider_resource_id, purchase_type, amount, currency,
         purchased_at, source, created_by)
      VALUES (${purchaseTwo}::uuid, ${enterpriseId}::uuid, ${apiResourceId}::uuid,
              'API_RECHARGE', 200, 'CNY', '2026-10-06T08:00:00+08:00'::timestamptz,
              'ADMIN', ${adminId}::uuid)
    `.execute(db);
    const stillFrozen = await app.inject({
      method: "GET", url: "/operating-bills/2026-10/departments",
      headers: { cookie: authCookie },
    });
    expect(stillFrozen.json()).toEqual(closedResponse.json());

    await billRepo.reopenMonth({
      enterpriseId, adminId, month: "2026-10", reason: "验证重开后使用新事实",
    });
    const reopened = await app.inject({
      method: "GET", url: "/operating-bills/2026-10/departments",
      headers: { cookie: authCookie },
    });
    expect(reopened.json()).toMatchObject({
      status: "DRAFT", version: 1,
      rows: expect.arrayContaining([expect.objectContaining({
        departmentId: departmentB, totalCost: "3.25000000",
      })]),
    });
    await billRepo.closeMonth({
      enterpriseId, adminId, month: "2026-10", allowIncomplete: true,
      note: "第二次冻结",
    });

    const versions = await sql<FrozenDepartmentSnapshotRow>`
      SELECT version, snapshot FROM operating_bill_version v
      JOIN operating_bill_period p ON p.id = v.period_id AND p.enterprise_id = v.enterprise_id
     WHERE v.enterprise_id = ${enterpriseId}::uuid AND p.period_month = '2026-10-01'::date
     ORDER BY version
    `.execute(db);
    expect(versions.rows).toHaveLength(2);
    const firstFacts = versions.rows[0]!.snapshot.sourceFacts;
    const secondFacts = versions.rows[1]!.snapshot.sourceFacts;
    expect(firstFacts.departmentAttributionFacts).toEqual([
      expect.objectContaining({ snapshotVersion: 1, organizationUnitId: departmentA }),
    ]);
    expect(firstFacts.departmentBudgetFacts).toEqual([
      expect.objectContaining({ amount: "10.00000000", version: 1 }),
    ]);
    expect(firstFacts.resourcePurchaseFacts).toEqual([
      expect.objectContaining({ id: purchaseOne, amount: "100.00000000" }),
    ]);
    expect(secondFacts.departmentAttributionFacts).toEqual([
      expect.objectContaining({ snapshotVersion: 2, organizationUnitId: departmentB }),
    ]);
    expect(secondFacts.departmentBudgetFacts).toEqual([
      expect.objectContaining({ amount: "1.00000000", version: 2 }),
    ]);
    expect(secondFacts.resourcePurchaseFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: purchaseOne }), expect.objectContaining({ id: purchaseTwo }),
    ]));
  });

  it("预算达到警戒线，乐观锁、幂等、跨企业、关账和审计均 fail-closed", async () => {
    const payload = {
      amount: "5", currency: "CNY", warning_threshold: "0.5",
      expected_version: 0, idempotency_key: "w20-budget-create-001",
    };
    const created = await app.inject({
      method: "PUT", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: authCookie }, payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ budget: { amount: "5.00000000", version: 1 }, replayed: false });
    const replay = await app.inject({
      method: "PUT", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: authCookie }, payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ budget: { id: created.json().budget.id }, replayed: true });
    const reusedWithDifferentBody = await app.inject({
      method: "PUT", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: authCookie }, payload: { ...payload, amount: "6" },
    });
    expect(reusedWithDifferentBody.statusCode).toBe(409);
    expect(reusedWithDifferentBody.json()).toMatchObject({ error: "idempotency_conflict" });

    const read = await app.inject({
      method: "GET", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: authCookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      budget: { amount: "5.00000000", warningThreshold: "0.50000000" },
      current: { collectedCost: "2.50000000", budgetUsageRate: "0.50000000", status: "WARNING" },
    });
    const stale = await app.inject({
      method: "PUT", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: authCookie },
      payload: { ...payload, expected_version: 0, idempotency_key: "w20-budget-stale-002" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "conflict" });
    const nextMonthBeforeWrite = await app.inject({
      method: "GET", url: `/department-budgets/${departmentB}/2026-09`,
      headers: { cookie: authCookie },
    });
    expect(nextMonthBeforeWrite.json()).toMatchObject({
      budget: null, current: { collectedCost: "0.00000000", status: "NOT_SET" },
    });
    const concurrent = await Promise.all([
      app.inject({
        method: "PUT", url: `/department-budgets/${departmentB}/2026-09`,
        headers: { cookie: authCookie },
        payload: { ...payload, expected_version: 0, idempotency_key: "w20-budget-race-006" },
      }),
      app.inject({
        method: "PUT", url: `/department-budgets/${departmentB}/2026-09`,
        headers: { cookie: authCookie },
        payload: { ...payload, expected_version: 0, idempotency_key: "w20-budget-race-007" },
      }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await app.inject({
      method: "PUT", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: otherCookie }, payload: { ...payload, idempotency_key: "w20-budget-cross-003" },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PUT", url: `/department-budgets/${otherDepartment}/2026-08`,
      headers: { cookie: authCookie }, payload: { ...payload, idempotency_key: "w20-budget-cross-004" },
    })).statusCode).toBe(404);

    await db.insertInto("operating_bill_period").values({
      enterprise_id: enterpriseId, period_month: "2026-08-01", status: "CLOSED",
      current_version: 1, created_by: adminId,
    }).execute();
    const closed = await app.inject({
      method: "PUT", url: `/department-budgets/${departmentB}/2026-08`,
      headers: { cookie: authCookie },
      payload: { ...payload, expected_version: 1, idempotency_key: "w20-budget-closed-005" },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ error: "bill_closed" });
    const audit = await db.selectFrom("operation_log").select(["action", "target_id"])
      .where("enterprise_id", "=", enterpriseId)
      .where("action", "=", "department_budget.upsert")
      .where("target_id", "=", created.json().budget.id).execute();
    expect(audit).toEqual([{ action: "department_budget.upsert", target_id: created.json().budget.id }]);
  });

  it("套餐成本按已知扣减稳定分摊，八位尾差后部门与企业仍守恒", async () => {
    const provider = await db.selectFrom("provider_resource").select("provider_id")
      .where("id", "=", apiResourceId).executeTakeFirstOrThrow();
    const roundingResourceId = (await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.provider_id,
      name: "尾差守恒 Coding Plan", mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
    }).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId, provider_resource_id: roundingResourceId, version: 1,
      source: "ADMIN", collected_at: new Date("2027-03-01T00:00:00Z"),
      currency: "CNY", package_cost: "10.00000000", total_quota: "3",
      used_quota: "3", remaining_quota: "0", quota_unit: "POINT",
      effective_from: new Date("2027-03-01T00:00:00+08:00"),
      effective_until: new Date("2027-04-01T00:00:00+08:00"),
    }).execute();
    const projectAId = randomUUID();
    const projectAKeyId = randomUUID();
    const projectBKeyId = randomUUID();
    await db.insertInto("principal").values({
      id: projectAId, enterprise_id: enterpriseId, type: "PROJECT", name: "研发尾差项目",
    }).execute();
    await db.insertInto("principal_key").values([
      {
        id: projectAKeyId, enterprise_id: enterpriseId, principal_id: projectAId,
        key_prefix: "ql_w20_round_a", key_digest: randomUUID(),
      },
      {
        id: projectBKeyId, enterprise_id: enterpriseId, principal_id: projectId,
        key_prefix: "ql_w20_round_b", key_digest: randomUUID(),
      },
    ]).execute();
    await db.insertInto("project_department_assignment").values({
      enterprise_id: enterpriseId, project_principal_id: projectAId,
      organization_unit_id: departmentA, valid_from: new Date("2027-01-01T00:00:00Z"),
      valid_until: null, source: "EXPLICIT", owner_person_id_at_assignment: null,
      version: 1, created_by: adminId, reason: "尾差守恒样本",
    }).execute();
    await settleApiUsage({
      principalId: projectAId, principalKeyId: projectAKeyId, cost: "0.00000000",
      tokens: 10, startedAt: new Date("2027-03-10T02:00:00Z"),
      resourceId: roundingResourceId, resourceMode: "CODING_PLAN", deductedQuota: 1,
    });
    await settleApiUsage({
      principalId: projectId, principalKeyId: projectBKeyId, cost: "0.00000000",
      tokens: 20, startedAt: new Date("2027-03-11T02:00:00Z"),
      resourceId: roundingResourceId, resourceMode: "CODING_PLAN", deductedQuota: 2,
    });

    const response = await app.inject({
      method: "GET", url: "/operating-bills/2027-03/departments",
      headers: { cookie: authCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totals: {
        actualTokens: "30", apiCost: "0.00000000",
        packageCost: "10.00000000", totalCost: "10.00000000",
      },
      conservation: {
        status: "BALANCED", tokenDifference: "0", apiCostDifference: "0.00000000",
        packageCostDifference: "0.00000000", totalCostDifference: "0.00000000",
      },
      rows: expect.arrayContaining([
        expect.objectContaining({
          departmentId: departmentA, projectCost: "3.33333333",
          packageAllocatedCost: "3.33333333", totalCost: "3.33333333",
        }),
        expect.objectContaining({
          departmentId: departmentB, projectCost: "6.66666667",
          packageAllocatedCost: "6.66666667", totalCost: "6.66666667",
        }),
      ]),
    });
  });

  it("采购记录 append-only，幂等重放不重复现金支出", async () => {
    const apiResource = await db.selectFrom("provider_resource").select("provider_id")
      .where("id", "=", apiResourceId).executeTakeFirstOrThrow();
    planResourceId = (await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: apiResource.provider_id, name: "Coding Plan",
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returning("id").executeTakeFirstOrThrow()).id;
    const payload = {
      purchase_type: "API_RECHARGE", description: "8 月 API 充值", amount: "1000",
      currency: "CNY", purchased_at: "2026-09-01T00:00:00+08:00",
      idempotency_key: "w20-purchase-create-001",
    };
    const created = await app.inject({
      method: "POST", url: `/provider-resources/${apiResourceId}/purchases`,
      headers: { cookie: authCookie }, payload,
    });
    expect(created.statusCode).toBe(201);
    firstPurchaseId = created.json().purchase.id;
    expect(created.json()).toMatchObject({ purchase: { amount: "1000.00000000" }, replayed: false });
    const replay = await app.inject({
      method: "POST", url: `/provider-resources/${apiResourceId}/purchases`,
      headers: { cookie: authCookie }, payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ purchase: { id: firstPurchaseId }, replayed: true });
    expect((await app.inject({
      method: "POST", url: `/provider-resources/${apiResourceId}/purchases`,
      headers: { cookie: authCookie }, payload: { ...payload, amount: "1001" },
    })).json()).toMatchObject({ error: "idempotency_conflict" });
    const modeMismatch = await app.inject({
      method: "POST", url: `/provider-resources/${planResourceId}/purchases`,
      headers: { cookie: authCookie },
      payload: { ...payload, idempotency_key: "w20-purchase-mode-002" },
    });
    expect(modeMismatch.statusCode).toBe(409);
    expect(modeMismatch.json()).toMatchObject({ error: "purchase_type_mismatch" });
    expect((await app.inject({
      method: "GET", url: `/provider-resources/${apiResourceId}/purchases?month=2026-09`,
      headers: { cookie: otherCookie },
    })).statusCode).toBe(404);
    const list = await app.inject({
      method: "GET", url: `/provider-resources/${apiResourceId}/purchases?month=2026-09`,
      headers: { cookie: authCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      total: 1, cashTotals: [{ currency: "CNY", amount: "1000.00000000" }],
      items: [{ id: firstPurchaseId }],
    });
    const purchaseAudit = await db.selectFrom("operation_log").select("id")
      .where("action", "=", "resource_purchase.create").execute();
    expect(purchaseAudit).toHaveLength(1);
    await expect(sql`
      UPDATE resource_purchase_record SET amount = 1 WHERE id = ${firstPurchaseId}::uuid
    `.execute(db)).rejects.toMatchObject({ code: "55000" });
    expect((await app.inject({
      method: "GET", url: `/provider-resources/${apiResourceId}/purchases`,
    })).statusCode).toBe(401);
  });

  it("部门预算仍可计算，但警戒线预警不再进入异常中心", async () => {
    const monthParts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
    }).formatToParts(new Date());
    const month = `${monthParts.find((part) => part.type === "year")!.value}-${monthParts.find((part) => part.type === "month")!.value}`;
    const alertDepartmentId = randomUUID();
    await db.insertInto("organization_unit").values({
      id: alertDepartmentId,
      enterprise_id: enterpriseId,
      name: "预算告警测试部",
      external_unit_id: `budget-alert-${alertDepartmentId}`,
    }).execute();
    const requestId = await addApiUsage({
      cost: "2.50000000", inputTokens: 10, outputTokens: 0, startedAt: new Date(),
    });
    await db.insertInto("request_attribution_snapshot").values({
      enterprise_id: enterpriseId,
      ai_request_id: requestId,
      source_principal_id: employeeId,
      organization_unit_id: alertDepartmentId,
      cost_category: "EMPLOYEE_DIRECT",
      attribution_source: "EMPLOYEE_MEMBERSHIP",
      request_occurred_at: new Date(),
      version: 1,
      snapshot_origin: "RUNTIME",
    }).execute();
    const budget = await db.insertInto("department_budget").values({
      enterprise_id: enterpriseId,
      organization_unit_id: alertDepartmentId,
      month: `${month}-01`,
      currency: "CNY",
      amount: "5.00000000",
      warning_threshold: "0.50000000",
      version: 1,
      updated_by: adminId,
    }).returning("id").executeTakeFirstOrThrow();

    const alertRepository = new AlertEventRepository(db, DEFAULT_THRESHOLDS, true);
    const alertKey = `USAGE_SPIKE:department-budget:${month}:${alertDepartmentId}`;
    const first = await alertRepository.evaluate(enterpriseId);
    expect(first).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        alertKey,
        signal: "department_budget_warning",
        severity: "MEDIUM",
        title: "部门预算已预警：预算告警测试部",
      }),
    ]));
    await alertRepository.evaluate(enterpriseId);
    expect(await db.selectFrom("alert_event").select("status")
      .where("enterprise_id", "=", enterpriseId).where("alert_key", "=", alertKey).execute())
      .toEqual([]);

    await db.updateTable("department_budget").set({ amount: "10.00000000", version: 2 })
      .where("id", "=", budget.id).execute();
    expect(await alertRepository.evaluate(enterpriseId))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ alertKey })]));
    expect(await db.selectFrom("alert_event").select("status")
      .where("enterprise_id", "=", enterpriseId).where("alert_key", "=", alertKey).execute())
      .toEqual([]);
  });
});
