/**
 * control-api W03 集成测试：下游 Key 生命周期 + Grant（M1 代表性运行链 + canary）。
 *
 * 覆盖：
 *   - WT-02/WT-04 第二步：生成 Key，响应体含明文（一次展示）
 *   - WT-09：重置 Key，旧 Key 撤销，新 Key 不同
 *   - 停用主体同步撤销全部 Key
 *   - WT-02/WT-04 第三步：分配 grant
 *   - **canary**：Key 明文绝不进 DB（扫描 principal_key 表，明文 0 命中）
 *
 * canary 是 M1 DoD 硬门禁（TRD §16 L878、PRD §15 L583）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let adminCookie: string;
let testPrincipalId: string;

const TEST_PASSWORD = "W03-Test-Password!";
const ENT_ID = randomUUID();
const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试企业" }).execute();
  const hash = await hashPassword(TEST_PASSWORD);
  await db
    .insertInto("admin_user")
    .values({ id: ADM_ID, enterprise_id: ENT_ID, username: "admin", password_hash: hash, status: "ACTIVE" })
    .execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: TEST_PASSWORD },
  });
  const setCookie = loginRes.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function createPrincipal(type: "EMPLOYEE" | "PROJECT", name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/principals",
    headers: { cookie: adminCookie },
    payload: { type, name },
  });
  return res.json().principal.id;
}

describe("W03 下游 Key 与 Grant", () => {
  it("生成 Key：响应含明文 + 提示一次展示（WT-02 第二步）", async () => {
    testPrincipalId = await createPrincipal("EMPLOYEE", "Key 测试员工");
    const res = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^sk-qianliu-/);
    expect(body.key_prefix).toMatch(/^sk-qianliu-/);
    expect(body.warning).toContain("一次");
    expect(body.metadata.id).toBeDefined();
  });

  it("重复生成 Key 被拒（每主体默认一把主 Key）", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("重置 Key：旧 Key 撤销、新 Key 不同（WT-09）", async () => {
    const beforeKeys = await app.inject({
      method: "GET",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
    });
    const oldActive = beforeKeys.json().keys.find((k: { status: string }) => k.status === "ACTIVE");
    expect(oldActive).toBeDefined();

    const resetRes = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key/reset`,
      headers: { cookie: adminCookie },
    });
    expect(resetRes.statusCode).toBe(200);
    const newKey = resetRes.json().key;
    expect(newKey).toMatch(/^sk-qianliu-/);

    // 旧 Key 应已 REVOKED
    const afterKeys = await app.inject({
      method: "GET",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
    });
    const oldKeyAfter = afterKeys.json().keys.find(
      (k: { id: string }) => k.id === oldActive.id,
    );
    expect(oldKeyAfter.status).toBe("REVOKED");
    // 新 Key 应 ACTIVE
    const newActive = afterKeys.json().keys.find((k: { status: string }) => k.status === "ACTIVE");
    expect(newActive).toBeDefined();
    expect(newActive.id).not.toBe(oldActive.id);
  });

  it("分配 grant（WT-02 第三步：分配模型与额度）", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/grants`,
      headers: { cookie: adminCookie },
      payload: {
        provider: "deepseek",
        model_alias: "qianliu-deepseek",
        quota_value: "1000000",
        allow_overage: false,
      },
    });
    expect(res.statusCode).toBe(201);
    const grant = res.json().grant;
    expect(grant.provider).toBe("deepseek");
    expect(grant.model_alias).toBe("qianliu-deepseek");
    expect(grant.quota_value).toBe("1000000");
    expect(grant.quota_unit).toBe("TOKEN");
  });

  it("停用主体同步撤销全部 Key（TRD §5.3 L219）", async () => {
    const pid = await createPrincipal("PROJECT", "停用测试项目");
    await app.inject({
      method: "POST",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
    });
    // 停用
    await app.inject({
      method: "PATCH",
      url: `/principals/${pid}`,
      headers: { cookie: adminCookie },
      payload: { status: "DISABLED" },
    });
    // 全部 Key 应 REVOKED
    const keysRes = await app.inject({
      method: "GET",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
    });
    const keys = keysRes.json().keys;
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k: { status: string }) => k.status === "REVOKED")).toBe(true);
  });

  // ===== M1 DoD canary：Key 明文绝不进 DB =====
  it("canary：下游 Key 明文在 principal_key 表 0 命中（M1 DoD 硬门禁）", async () => {
    // 收集本次测试中所有生成/重置的 Key 明文
    // 这里重新走一遍完整流程，捕获明文
    const pid = await createPrincipal("EMPLOYEE", "canary 员工");
    const createRes = await app.inject({
      method: "POST",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
    });
    const canaryKey = createRes.json().key as string;
    expect(canaryKey).toMatch(/^sk-qianliu-/);

    // 扫描 DB：principal_key 表所有行的所有文本字段，canaryKey 明文应 0 命中
    const result = await sql`
      SELECT COUNT(*) AS hits FROM (
        SELECT row_to_json(t)::text AS row_text FROM principal_key t
      ) s WHERE s.row_text LIKE ${"%" + canaryKey + "%"}
    `.execute(db);
    const hits = Number((result.rows[0] as { hits: number | bigint }).hits);
    expect(hits, "Key 明文绝不进 DB（TRD §16 L878）").toBe(0);

    // 同时验证 digest 存在（说明 Key 确实持久化了，只是只存 digest）
    const digestRows = await db.selectFrom("principal_key").select("key_digest").execute();
    expect(digestRows.length).toBeGreaterThan(0);
    // digest 不应等于明文
    for (const row of digestRows) {
      expect(row.key_digest).not.toBe(canaryKey);
      expect(row.key_digest.length).toBe(64); // HMAC-SHA256 hex
    }
  });
});
