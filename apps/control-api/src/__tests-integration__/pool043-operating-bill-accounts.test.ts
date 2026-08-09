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
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "POOL-043 API 企业" },
    { id: otherEnterpriseId, name: "POOL-043 隔离企业" },
  ]).execute();
  const passwordHash = await hashPassword(password);
  await db.insertInto("admin_user").values([
    { id: adminId, enterprise_id: enterpriseId, username: "pool043-owner", display_name: "经营管理员", password_hash: passwordHash },
    { id: otherAdminId, enterprise_id: otherEnterpriseId, username: "pool043-other", display_name: "隔离管理员", password_hash: passwordHash },
  ]).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "于滔" },
    { id: otherEmployeeId, enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "隔离员工" },
  ]).execute();
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

  it("项目账独立返回未归属项目，认证、参数和跨企业均 fail-closed", async () => {
    const projects = await app.inject({
      method: "GET", url: "/operating-bills/2026-08/projects", headers: { cookie },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toMatchObject({
      dimension: "PROJECT",
      rows: [expect.objectContaining({ subjectId: null, subjectName: "未归属项目", isUnassigned: true })],
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
    expect(legacy.json()).toMatchObject({ error: "account_evidence_unavailable" });
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
});
