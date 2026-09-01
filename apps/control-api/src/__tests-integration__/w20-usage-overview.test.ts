import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { FastifyInstance } from "fastify";

import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let adminCookie: string;

const enterpriseId = randomUUID();
const employeeId = randomUUID();
const employeeTwoId = randomUUID();
const projectId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_usage_overview_api_test");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({
    id: enterpriseId, name: "周期用量 API 企业", timezone: "Asia/Shanghai",
  }).execute();
  await db.insertInto("admin_user").values({
    enterprise_id: enterpriseId,
    username: "overview-admin",
    password_hash: await hashPassword("Usage-Overview-Test-Password!"),
    status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "API 员工" },
    { id: employeeTwoId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "API 员工二" },
    { id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "API 项目" },
  ]).execute();
  const key = await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId,
    principal_id: employeeId,
    key_prefix: "overview-key",
    key_digest: randomUUID(),
    allowed_model_ids: [],
    status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow();
  const requestId = randomUUID();
  const at = new Date("2026-08-11T02:00:00.000Z");
  await db.insertInto("ai_request").values({
    id: requestId,
    enterprise_id: enterpriseId,
    principal_id: employeeId,
    principal_key_id: key.id,
    protocol: "openai",
    unified_model: "ql-test",
    status: "SUCCEEDED",
    started_at: at,
    finished_at: new Date(at.getTime() + 500),
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId,
    enterprise_id: enterpriseId,
    principal_id: employeeId,
    total_input_tokens: 80n,
    total_output_tokens: 20n,
    total_cache_tokens: 60n,
    total_reasoning_tokens: 5n,
    total_deducted_quota: 100n,
    total_api_cost: "0.50000000",
    usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1,
    status: "SETTLED",
    created_at: at,
  }).execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "overview-admin", password: "Usage-Overview-Test-Password!" },
  });
  const setCookie = login.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W20-04 /usage/overview", () => {
  it("返回企业时区、周一至周日趋势和账本守恒指标", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/usage/overview?subject_type=employee&period=week&anchor=2026-08-12T04%3A00%3A00.000Z",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      subjectType: "EMPLOYEE",
      subjectId: null,
      period: "WEEK",
      timezone: "Asia/Shanghai",
      range: { from: "2026-08-09T16:00:00.000Z", to: "2026-08-16T16:00:00.000Z" },
      metrics: {
        activeSubjects: 1,
        requestCount: "1",
        inputTokens: "80",
        outputTokens: "20",
        cacheTokens: "60",
        realTokens: "100",
        apiCost: "0.50000000",
        deductedQuota: "100",
      },
      source: "LIVE_LEDGER",
      stale: false,
      detailQuery: { subjectType: "EMPLOYEE", settledOnly: true },
    });
    expect(response.json().trend).toHaveLength(7);
  });

  it("主体列表支持服务端搜索与分页，且保留旧响应字段", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/principals?type=EMPLOYEE&search=API%20%E5%91%98%E5%B7%A5&limit=1&offset=0",
      headers: { cookie: adminCookie },
    });
    const second = await app.inject({
      method: "GET",
      url: "/principals?type=EMPLOYEE&search=API%20%E5%91%98%E5%B7%A5&limit=1&offset=1",
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(first.json().principals).toHaveLength(1);
    expect(second.json()).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(second.json().principals).toHaveLength(1);
    expect(second.json().principals[0].id).not.toBe(first.json().principals[0].id);
  });

  it("精确匹配在企业全量范围判定唯一，不受 20 条分页限制", async () => {
    const unique = await app.inject({
      method: "GET",
      url: "/principals/resolve-exact?type=EMPLOYEE&name=API%20%E5%91%98%E5%B7%A5%E4%BA%8C",
      headers: { cookie: adminCookie },
    });
    expect(unique.statusCode).toBe(200);
    expect(unique.json()).toMatchObject({ principal: { id: employeeTwoId }, match_count: 1 });

    await db.insertInto("principal").values(Array.from({ length: 21 }, (_, index) => ({
      enterprise_id: enterpriseId,
      type: "PROJECT" as const,
      name: "分页重名项目",
      department_label: `部门-${index}`,
    }))).execute();
    const duplicate = await app.inject({
      method: "GET",
      url: "/principals/resolve-exact?type=PROJECT&name=%E5%88%86%E9%A1%B5%E9%87%8D%E5%90%8D%E9%A1%B9%E7%9B%AE",
      headers: { cookie: adminCookie },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ principal: null, match_count: 2 });
  });

  it("主体类型不匹配返回 404，非法 anchor 返回 400", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/usage/overview?subject_type=employee&subject_id=${projectId}&period=month`,
      headers: { cookie: adminCookie },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "GET",
      url: "/usage/overview?anchor=not-a-date",
      headers: { cookie: adminCookie },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("/dashboard 保留 1.0 字段并向后兼容增加员工周期用量", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      resourceAccountCount: 0,
      employeeUsageOverview: {
        subjectType: "EMPLOYEE",
        period: "TODAY",
        source: "LIVE_LEDGER",
      },
    });
    expect(body).toHaveProperty("monthlyTokenUsage");
  });
});
