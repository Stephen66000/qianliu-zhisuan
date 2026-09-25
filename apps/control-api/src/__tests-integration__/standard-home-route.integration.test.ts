import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

/**
 * R01 证据边界补充：/dashboard/home 的权限边界回归。
 * 1) 未登录 401；2) 会话只命中本企业数据（跨租户隔离）。
 */
let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookieA: string;
const password = "Standard-Home-Route-1!";
const enterpriseA = randomUUID();
const enterpriseB = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer("standard_home_route_c2");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const passwordHash = await hashPassword(password);
  await db.insertInto("enterprise").values([
    // 登录路由取 created_at 最小的企业；迁移默认值是**常量**，同语句插入会并列，
    // 显式时间戳消除排序不确定性（同类收口见 pool027）。
    { id: enterpriseA, name: "standard-home-a", created_at: new Date("2020-01-01T00:00:00.000Z") },
    { id: enterpriseB, name: "standard-home-b", created_at: new Date("2020-01-02T00:00:00.000Z") },
  ]).execute();
  await db.insertInto("admin_user").values([
    {
      enterprise_id: enterpriseA, username: "home-a", display_name: "home-a",
      password_hash: passwordHash, status: "ACTIVE",
    },
  ]).execute();
  // 企业 B 独有厂商：A 会话不得看到。
  const providerB = await db.insertInto("provider").values({
    enterprise_id: enterpriseB, code: "b-only", name: "B 独有厂商", adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseB, provider_id: providerB.id, name: "B 独有资源",
    mode: "API", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/auth/login", payload: { username: "home-a", password },
  });
  const header = login.headers["set-cookie"];
  cookieA = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("标准版首页 /dashboard/home 权限边界", () => {
  it("未登录请求返回 401", async () => {
    const response = await app.inject({ method: "GET", url: "/dashboard/home" });
    expect(response.statusCode).toBe(401);
  });

  it("会话只返回本企业聚合（跨企业厂商不可见）", async () => {
    const response = await app.inject({
      method: "GET", url: "/dashboard/home", headers: { cookie: cookieA },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.resources.providerCount).toBe(0);
    expect(body.resources.resourceCount).toBe(0);
    expect(JSON.stringify(body)).not.toContain("B 独有厂商");
    expect(body.tokenUsage.current.totalTokens).toBe("0");
  });
});
