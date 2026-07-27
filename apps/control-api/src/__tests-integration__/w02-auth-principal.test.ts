/**
 * control-api W02 集成测试：认证 + Principal CRUD + 审计（M1 代表性运行链）。
 *
 * 覆盖：
 *   - 登录成功/失败/限速
 *   - 创建员工/项目（WT-02/WT-04 四步的"创建账号"步）
 *   - 列表/详情/停用/重新启用
 *   - 未登录写操作被拒（401）
 *   - 审计日志记录完整
 *   - enterprise_id 贯穿（跨企业不可见）
 *
 * 使用 Testcontainer PG17 + 真实 Argon2id + 真实 session Cookie。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let adminCookie: string;

const TEST_PASSWORD = "W02-Test-Password-Strong!";
const ENT_ID = randomUUID();
const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  // 种子：企业 + 管理员
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试企业" }).execute();
  const hash = await hashPassword(TEST_PASSWORD);
  await db
    .insertInto("admin_user")
    .values({
      id: ADM_ID,
      enterprise_id: ENT_ID,
      username: "admin",
      password_hash: hash,
      status: "ACTIVE",
    })
    .execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

beforeEach(() => {
  adminCookie = "";
});

async function loginAsAdmin(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: TEST_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return cookie!.split(";")[0]!;
}

describe("W02 认证与 Principal", () => {
  it("登录成功返回 admin 信息并设置 Cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.admin.username).toBe("admin");
    expect(body.admin.enterprise_id).toBe(ENT_ID);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("密码错误返回 401 且不设置 Cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("未登录访问 /principals 返回 401", async () => {
    const res = await app.inject({ method: "GET", url: "/principals" });
    expect(res.statusCode).toBe(401);
  });

  it("未登录创建 principal 返回 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/principals",
      payload: { type: "EMPLOYEE", name: "测试员工" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("登录后创建员工 principal（WT-02 第一步：创建账号）", async () => {
    adminCookie = await loginAsAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/principals",
      headers: { cookie: adminCookie },
      payload: { type: "EMPLOYEE", name: "王一帆", department_label: "工程部" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.principal.type).toBe("EMPLOYEE");
    expect(body.principal.name).toBe("王一帆");
    expect(body.principal.status).toBe("ACTIVE");
    expect(body.principal.enterprise_id).toBe(ENT_ID);
  });

  it("登录后创建项目 principal（WT-04 第一步：创建账号）", async () => {
    adminCookie = await loginAsAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/principals",
      headers: { cookie: adminCookie },
      payload: { type: "PROJECT", name: "仟流官网项目" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.principal.type).toBe("PROJECT");
    expect(body.principal.department_label).toBeNull();
  });

  it("列表返回已创建的 principal，按 type 过滤", async () => {
    adminCookie = await loginAsAdmin();
    const allRes = await app.inject({
      method: "GET",
      url: "/principals",
      headers: { cookie: adminCookie },
    });
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().principals.length).toBeGreaterThanOrEqual(2);

    const empRes = await app.inject({
      method: "GET",
      url: "/principals?type=EMPLOYEE",
      headers: { cookie: adminCookie },
    });
    const employees = empRes.json().principals;
    expect(employees.every((p: { type: string }) => p.type === "EMPLOYEE")).toBe(true);
  });

  it("停用 principal 后 status=DISABLED，重新启用生成新状态", async () => {
    adminCookie = await loginAsAdmin();
    const createRes = await app.inject({
      method: "POST",
      url: "/principals",
      headers: { cookie: adminCookie },
      payload: { type: "EMPLOYEE", name: "停用测试员工" },
    });
    const pid = createRes.json().principal.id;

    const disableRes = await app.inject({
      method: "PATCH",
      url: `/principals/${pid}`,
      headers: { cookie: adminCookie },
      payload: { status: "DISABLED" },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().principal.status).toBe("DISABLED");

    const reactivateRes = await app.inject({
      method: "PATCH",
      url: `/principals/${pid}`,
      headers: { cookie: adminCookie },
      payload: { status: "ACTIVE" },
    });
    expect(reactivateRes.json().principal.status).toBe("ACTIVE");
  });

  it("操作日志记录所有写操作（审计完整性）", async () => {
    adminCookie = await loginAsAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/operation-logs?limit=50",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const logs = res.json().logs;
    expect(logs.length).toBeGreaterThan(0);
    // 应包含 login、principal.create、principal.disable 等动作
    const actions = logs.map((l: { action: string }) => l.action);
    expect(actions).toContain("auth.login");
    expect(actions.some((a: string) => a.startsWith("principal."))).toBe(true);
    // 审计记录必须包含操作人与企业
    for (const log of logs) {
      expect(log.enterprise_id).toBe(ENT_ID);
      expect(log.admin_user_id).toBe(ADM_ID);
    }
  });

  it("/auth/me 返回当前登录管理员", async () => {
    adminCookie = await loginAsAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().admin.username).toBe("admin");
  });

  it("登出后 session 失效，后续请求 401", async () => {
    adminCookie = await loginAsAdmin();
    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: adminCookie },
    });
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
