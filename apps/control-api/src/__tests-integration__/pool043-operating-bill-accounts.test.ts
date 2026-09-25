import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createKysely,
  migrateToLatest,
  OperatingBillConcurrentModificationError,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { hashPassword } from "../auth/password.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let cookie: string;
let otherCookie: string;

const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const adminId = randomUUID();
const otherAdminId = randomUUID();
const employeeId = randomUUID();
const otherEmployeeId = randomUUID();
const projectId = randomUUID();
const projectOwnerPersonId = randomUUID();
const projectDepartmentId = randomUUID();
const keyId = randomUUID();
const flashId = randomUUID();
const proId = randomUUID();
const password = "Pool043-Admin-Test!";
let historicalRequestId: string;

async function login(username: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function addUsage(input: {
  modelId: string;
  alias: string;
  resourceId: string;
  tokens: [number, number, number];
  cost: string;
  at: Date;
}) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: employeeId,
    principal_key_id: keyId, protocol: "chat", unified_model: input.alias,
    unified_model_id: input.modelId, status: "SUCCEEDED", started_at: input.at,
    finished_at: new Date(input.at.getTime() + 100),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
    provider_resource_id: input.resourceId, upstream_model: "deepseek-upstream",
    finished_at: new Date(input.at.getTime() + 100), http_status: 200, response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: input.resourceId, input_tokens: BigInt(input.tokens[0]),
    output_tokens: BigInt(input.tokens[1]), cache_tokens: BigInt(input.tokens[2]),
    usage_quality: "PROVIDER_REPORTED", dedup_key: `pool043-api-${requestId}`,
    created_at: input.at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: input.resourceId,
    principal_id: employeeId, resource_mode: "API", raw_input_tokens: BigInt(input.tokens[0]),
    raw_output_tokens: BigInt(input.tokens[1]), raw_cache_tokens: BigInt(input.tokens[2]),
    deducted_quota: null, api_cost: input.cost, usage_quality: "PROVIDER_REPORTED",
    created_at: input.at,
  }).execute();
  return requestId;
}

beforeAll(async () => {
  pg = process.env.POOL043_CONTROL_DATABASE_URL
    ? { connectionString: process.env.POOL043_CONTROL_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer("pool043_control_api");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  // 登录路由是一期单企业口径（取 `created_at` 最早、同值时按 `id` 排序的第一条企业）。
  // 两条企业若在同一语句插入会得到完全相同的 `created_at`，此时谁被选中只取决于随机 UUID
  // 的字典序 —— 夹具会约 50% 概率把会话落到隔离企业上，导致登录取不到 `pool043-owner`。
  // 因此显式把被测企业锚定为更早创建，消除这条与被测语义无关的随机性。
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "POOL-043 API 企业", created_at: new Date("2020-01-01T00:00:00.000Z") },
    { id: otherEnterpriseId, name: "POOL-043 隔离企业", created_at: new Date("2020-01-02T00:00:00.000Z") },
  ]).execute();
  const passwordHash = await hashPassword(password);
  await db.insertInto("admin_user").values([
    { id: adminId, enterprise_id: enterpriseId, username: "pool043-owner", display_name: "经营管理员", password_hash: passwordHash },
    { id: otherAdminId, enterprise_id: otherEnterpriseId, username: "pool043-other", display_name: "隔离管理员", password_hash: passwordHash },
  ]).execute();
  await db.insertInto("person").values({
    id: projectOwnerPersonId, enterprise_id: enterpriseId, name: "项目负责人",
  }).execute();
  await db.insertInto("organization_unit").values({
    id: projectDepartmentId, enterprise_id: enterpriseId, parent_id: null,
    name: "研发中心", external_source_id: null, external_unit_id: "研发中心",
  }).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "于滔" },
    { id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "智算项目",
      owner_person_id: projectOwnerPersonId },
    { id: otherEmployeeId, enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "隔离员工" },
  ]).execute();
  await db.insertInto("project_department_assignment").values({
    enterprise_id: enterpriseId, project_principal_id: projectId,
    organization_unit_id: projectDepartmentId, valid_from: new Date("2026-07-01T00:00:00Z"),
    valid_until: null, source: "EXPLICIT", owner_person_id_at_assignment: projectOwnerPersonId,
    created_by: adminId, reason: "项目账 API 合同测试",
  }).execute();
  await db.insertInto("unified_model").values([
    { id: flashId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-flash", display_name: "DeepSeek V4 Flash" },
    { id: proId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
  ]).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: employeeId,
    key_prefix: "ql_pool043", key_digest: randomUUID(),
    allowed_model_ids: JSON.stringify([flashId, proId]) as unknown as string[],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "DeepSeek API",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  historicalRequestId = await addUsage({
    modelId: flashId, alias: "qianliu-deepseek-deepseek-v4-flash", resourceId: resource.id,
    tokens: [100, 20, 30], cost: "1.25", at: new Date("2026-08-08T01:00:00Z"),
  });
  await db.insertInto("operating_bill_request_project_assignment").values({
    enterprise_id: enterpriseId, ai_request_id: historicalRequestId,
    project_principal_id: projectId, assigned_by: adminId, reason: "项目账 API 合同测试",
  }).execute();
  await db.insertInto("request_attribution_snapshot").values({
    enterprise_id: enterpriseId, ai_request_id: historicalRequestId,
    source_principal_id: employeeId, employee_person_id: null,
    project_principal_id: projectId, organization_unit_id: projectDepartmentId,
    cost_category: "PROJECT", attribution_source: "EMPLOYEE_PROJECT",
    request_occurred_at: new Date("2026-08-08T01:00:00Z"), version: 1,
    supersedes_id: null, snapshot_origin: "RUNTIME",
  }).execute();
  await addUsage({
    modelId: proId, alias: "ql-deepseek-v4-pro", resourceId: resource.id,
    tokens: [200, 40, 50], cost: "2.75", at: new Date("2026-08-08T02:00:00Z"),
  });
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  cookie = await login("pool043-owner");
  const otherToken = generateSessionToken();
  await app.adminRepo.createSession(
    otherAdminId,
    digestSessionToken(otherToken),
    new Date(Date.now() + 60_000),
  );
  otherCookie = `${SESSION_COOKIE_NAME}=${otherToken}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("POOL-043 Control API 员工账／项目账", () => {
  it("通过独立端点完成员工→厂商→模型→请求证据链", async () => {
    const employees = await app.inject({
      method: "GET", url: "/operating-bills/2026-08/employees?provider_code=deepseek&search=%E4%BA%8E%E6%BB%94",
      headers: { cookie },
    });
    expect(employees.statusCode).toBe(200);
    expect(employees.json()).toMatchObject({
      month: "2026-08", dimension: "EMPLOYEE",
      totals: { inputTokens: "300", outputTokens: "60", cacheTokens: "80",
        totalTokens: "360", apiCost: "4.00000000", requestCount: 2 },
      rows: [{ subjectId: employeeId, subjectName: "于滔" }],
    });

    const detail = await app.inject({
      method: "GET", url: `/operating-bills/2026-08/employees/${employeeId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().providers).toEqual([
      expect.objectContaining({
        providerCode: "deepseek", providerName: "DeepSeek",
        models: expect.arrayContaining([
          expect.objectContaining({ unifiedModelId: flashId, currentAlias: "ql-deepseek-v4-flash" }),
          expect.objectContaining({ unifiedModelId: proId, currentAlias: "ql-deepseek-v4-pro" }),
        ]),
      }),
    ]);

    const requests = await app.inject({
      method: "GET",
      url: `/operating-bills/2026-08/employees/${employeeId}/models/${flashId}/requests?provider_code=deepseek`,
      headers: { cookie },
    });
    expect(requests.statusCode).toBe(200);
    expect(requests.json()).toMatchObject({
      total: 1,
      items: [{
        requestId: historicalRequestId,
        modelAliasAtRequest: "qianliu-deepseek-deepseek-v4-flash",
        currentAlias: "ql-deepseek-v4-flash", status: "SUCCEEDED",
      }],
    });
  });

  it("项目账不重复收录员工请求，认证、参数和跨企业均 fail-closed", async () => {
    const projects = await app.inject({
      method: "GET", url: "/operating-bills/2026-08/projects", headers: { cookie },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toMatchObject({
      dimension: "PROJECT",
      rows: [],
      totals: { totalTokens: "0", requestCount: 0 },
    });
    expect((await app.inject({ method: "GET", url: "/operating-bills/2026-08/employees" })).statusCode)
      .toBe(401);
    expect((await app.inject({ method: "GET", url: "/operating-bills/bad/employees", headers: { cookie } })).statusCode)
      .toBe(400);
    expect((await app.inject({
      method: "GET", url: `/operating-bills/2026-08/employees/${employeeId}`,
      headers: { cookie: otherCookie },
    })).statusCode).toBe(404);

    const legacyPeriod = await db.insertInto("operating_bill_period").values({
      enterprise_id: enterpriseId, period_month: "2026-07-01",
      status: "CLOSED", current_version: 1, created_by: adminId,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("operating_bill_version").values({
      enterprise_id: enterpriseId, period_id: legacyPeriod.id, version: 1,
      snapshot: { sourceFacts: { accountFacts: null } }, close_note: "历史版本", closed_by: adminId,
    }).execute();
    const legacy = await app.inject({
      method: "GET", url: "/operating-bills/2026-07/projects", headers: { cookie },
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({
      error: "account_evidence_unavailable",
    });
    expect((await app.inject({
      method: "GET", url: "/operating-bills/2026-07/employees", headers: { cookie },
    })).statusCode).toBe(409);
    const legacyDetail = await app.inject({
      method: "GET", url: `/operating-bills/2026-07/employees/${employeeId}`, headers: { cookie },
    });
    expect(legacyDetail.statusCode).toBe(409);
    expect(legacyDetail.json()).toMatchObject({ error: "account_evidence_unavailable" });
    expect((await app.inject({
      method: "GET",
      url: `/operating-bills/2026-07/employees/${employeeId}/models/${flashId}/requests`,
      headers: { cookie },
    })).statusCode).toBe(409);
  });

  it("HTTP 参数边界、恶意 UUID 和请求下钻跨企业均 fail-closed", async () => {
    const get = (url: string, authCookie = cookie) => app.inject({
      method: "GET", url, headers: { cookie: authCookie },
    });
    const tooLongProvider = encodeURIComponent("p".repeat(65));
    const maxProvider = encodeURIComponent("p".repeat(64));
    const tooLongSearch = encodeURIComponent("搜".repeat(256));
    const maxSearch = encodeURIComponent("搜".repeat(255));
    const requestPath = `/operating-bills/2026-08/employees/${employeeId}/models/${flashId}/requests`;

    expect((await get("/operating-bills/9999-12/employees")).statusCode).toBe(400);
    expect((await get(`/operating-bills/2026-08/employees?provider_code=${tooLongProvider}`)).statusCode)
      .toBe(400);
    expect((await get(`/operating-bills/2026-08/employees?search=${tooLongSearch}`)).statusCode)
      .toBe(400);
    expect((await get(`/operating-bills/2026-08/employees?provider_code=${maxProvider}&search=${maxSearch}`)).statusCode)
      .toBe(200);
    expect((await get("/operating-bills/2026-08/projects?provider_code=%20%20")).statusCode)
      .toBe(400);
    expect((await get("/operating-bills/2026-08/employees/not-a-uuid")).statusCode).toBe(400);
    expect((await get(
      `/operating-bills/2026-08/employees/${employeeId}?provider_code=${tooLongProvider}`,
    )).statusCode).toBe(400);
    expect((await get(
      `/operating-bills/2026-08/employees/${employeeId}/models/not-a-uuid/requests`,
    )).statusCode).toBe(400);
    for (const query of [
      `provider_code=${tooLongProvider}`, "limit=0", "limit=101", "offset=-1", "offset=100001",
    ]) {
      expect((await get(`${requestPath}?${query}`)).statusCode).toBe(400);
    }
    expect((await get(`${requestPath}?limit=1&offset=0`)).statusCode).toBe(200);
    expect((await get(`${requestPath}?limit=100&offset=0`)).statusCode).toBe(200);
    expect((await get(`${requestPath}?limit=1&offset=100000`)).statusCode).toBe(200);
    expect((await get(requestPath, otherCookie)).statusCode).toBe(404);
  });

  it("结账并发重试耗尽时返回可重试 409，不伪装为已结账", async () => {
    const original = app.operatingBillRepo.closeMonth;
    app.operatingBillRepo.closeMonth = async () => {
      throw new OperatingBillConcurrentModificationError();
    };
    try {
      const response = await app.inject({
        method: "POST", url: "/operating-bills/2026-09/close", headers: { cookie },
        payload: { allow_incomplete: true, note: "并发测试" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "bill_concurrent_modification", retryable: true,
      });
    } finally {
      app.operatingBillRepo.closeMonth = original;
    }
  });
  it("分析与部门新接口按会话隔离，主体创建与归属原子保存", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/operating-bills/2026-08/analysis",
        })
      ).statusCode,
    ).toBe(401);
    const report = await app.inject({
      method: "GET",
      url: "/operating-bills/2026-08/analysis",
      headers: { cookie },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().summary.companyTokens).toBe("360");
    const other = await app.inject({
      method: "GET",
      url: "/operating-bills/2026-08/analysis",
      headers: { cookie: otherCookie },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().summary.companyTokens).toBe("0");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/operating-bills/9999-08/analysis",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
    const invalid = await app.inject({
      method: "POST",
      url: "/principals",
      headers: { cookie },
      payload: { type: "EMPLOYEE", name: "缺部门", accounting_required: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      await db
        .selectFrom("principal")
        .select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("name", "=", "缺部门")
        .execute(),
    ).toEqual([]);
    const created = await app.inject({
      method: "POST",
      url: "/principals",
      headers: { cookie },
      payload: {
        type: "EMPLOYEE",
        name: "新员工",
        department_label: "验收部门",
        accounting_required: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const owner = created.json().principal.id;
    const project = await app.inject({
      method: "POST",
      url: "/principals",
      headers: { cookie },
      payload: {
        type: "PROJECT",
        name: "负责人项目",
        owner_principal_id: owner,
        accounting_required: true,
      },
    });
    expect(project.statusCode).toBe(201);
    const profile = await app.inject({
      method: "GET",
      url: `/principals/${project.json().principal.id}/accounting-profile`,
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().assignment.ownerPrincipalId).toBe(owner);
    const historyUrl=`/principals/${project.json().principal.id}/attribution-backfill`;
    const historyPayload={from:"2026-09-01",to:"2026-09-06",department_id:profile.json().suggestedDepartmentId,reason:"确认历史项目部门"};
    expect((await app.inject({method:"POST",url:`${historyUrl}/preview`,payload:historyPayload})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:`${historyUrl}/preview`,headers:{cookie:otherCookie},payload:historyPayload})).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:`${historyUrl}/preview`,headers:{cookie},payload:{...historyPayload,from:"2026-02-30"}})).statusCode).toBe(400);
    const historyPreview=await app.inject({method:"POST",url:`${historyUrl}/preview`,headers:{cookie},payload:historyPayload});
    expect(historyPreview.statusCode).toBe(200);
    expect(historyPreview.json()).toMatchObject({requestCount:0,departmentName:"验收部门"});
    expect((await app.inject({method:"POST",url:historyUrl,headers:{cookie},payload:historyPayload})).statusCode).toBe(400);
    const historyConfirmed=await app.inject({method:"POST",url:historyUrl,headers:{cookie},payload:{...historyPayload,fingerprint:historyPreview.json().fingerprint}});
    expect(historyConfirmed.statusCode).toBe(200);
    expect(historyConfirmed.json()).toEqual({confirmedCount:0});
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/principals/${owner}/accounting-profile`,
          headers: { cookie: otherCookie },
        })
      ).statusCode,
    ).toBe(404);
    const preview = await app.principalRepo.cleanupPreview(enterpriseId, owner);
    expect(preview?.canDelete).toBe(false);
  });
});
