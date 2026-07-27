/**
 * control-api W04 集成测试：Provider/Resource/Model/Route（M1 代表性运行链 + canary）。
 *
 * 覆盖：
 *   - WT-01：登记资源账号（凭证加密存储，列表只返回指纹）
 *   - WT-10：统一模型路由详情（候选、优先级、权重）
 *   - **canary**：上游凭证明文绝不进 DB（0 命中）
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

const TEST_PASSWORD = "W04-Test-Password!";
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

async function createProvider(code: "deepseek" | "zhipu" | "kimi"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/providers",
    headers: { cookie: adminCookie },
    payload: { code, name: `${code} 测试`, adapter_type: code },
  });
  return res.json().provider.id;
}

describe("W04 Provider/Resource/Model/Route", () => {
  let providerId: string;
  let resourceId: string;
  let modelId: string;

  it("创建 provider", async () => {
    providerId = await createProvider("deepseek");
    expect(providerId).toBeDefined();
    const list = await app.inject({
      method: "GET",
      url: "/providers",
      headers: { cookie: adminCookie },
    });
    expect(list.json().providers.length).toBeGreaterThanOrEqual(1);
  });

  it("WT-01：登记资源账号，凭证加密存储，列表只返回指纹", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/provider-resources",
      headers: { cookie: adminCookie },
      payload: {
        provider_id: providerId,
        name: "DeepSeek 主账号",
        mode: "API",
        credential_type: "API_KEY",
        credential_plaintext: "sk-deepseek-test-secret-XXXX",
        upstream_models: ["deepseek-chat", "deepseek-reasoner"],
        concurrency_limit: 100,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    resourceId = body.resource.id;
    expect(body.resource.credential_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // 响应不含明文
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("sk-deepseek-test-secret-XXXX");

    // 列表也不含明文/密文
    const listRes = await app.inject({
      method: "GET",
      url: "/provider-resources",
      headers: { cookie: adminCookie },
    });
    const listText = JSON.stringify(listRes.json());
    expect(listText).not.toContain("sk-deepseek-test-secret-XXXX");
    // 列表含指纹（可展示）
    expect(listText).toContain(body.resource.credential_fingerprint);
  });

  it("创建 unified_model", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/unified-models",
      headers: { cookie: adminCookie },
      payload: { alias: "qianliu-deepseek", display_name: "仟流 DeepSeek" },
    });
    expect(res.statusCode).toBe(201);
    modelId = res.json().model.id;
  });

  it("创建 model_route（优先级/权重）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/model-routes",
      headers: { cookie: adminCookie },
      payload: {
        unified_model_id: modelId,
        provider_resource_id: resourceId,
        upstream_model: "deepseek-chat",
        priority: 100,
        weight: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().route.priority).toBe(100);
    expect(res.json().route.weight).toBe(1);
  });

  it("WT-10：路由详情列出候选、优先级、权重、资源名", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/unified-models/${modelId}/routes`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const routes = res.json().routes;
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].resource_name).toBe("DeepSeek 主账号");
    expect(routes[0].priority).toBe(100);
    expect(routes[0].weight).toBe(1);
    expect(routes[0].upstream_model).toBe("deepseek-chat");
  });

  // ===== M1 DoD canary：上游凭证明文绝不进 DB =====
  it("canary：上游凭证明文在 provider_resource 表 0 命中（M1 DoD 硬门禁）", async () => {
    const canarySecret = "sk-deepseek-CANARY-SECRET-FOR-SCAN-12345";
    // 登记一个带 canary 的资源
    await app.inject({
      method: "POST",
      url: "/provider-resources",
      headers: { cookie: adminCookie },
      payload: {
        provider_id: providerId,
        name: "canary 资源",
        mode: "API",
        credential_type: "API_KEY",
        credential_plaintext: canarySecret,
      },
    });

    // 扫描 DB：provider_resource 表所有行的所有文本字段，明文应 0 命中
    const result = await sql`
      SELECT COUNT(*) AS hits FROM (
        SELECT row_to_json(t)::text AS row_text FROM provider_resource t
      ) s WHERE s.row_text LIKE ${"%" + canarySecret + "%"}
    `.execute(db);
    const hits = Number((result.rows[0] as { hits: number | bigint }).hits);
    expect(hits, "上游凭证明文绝不进 DB（TRD §16 L878）").toBe(0);

    // 验证密文确实存在（说明加密生效）
    const rows = await db
      .selectFrom("provider_resource")
      .select(["credential_ciphertext", "credential_fingerprint"])
      .execute();
    expect(rows.some((r) => r.credential_ciphertext !== null)).toBe(true);
    // 密文不含明文
    for (const row of rows) {
      expect(row.credential_ciphertext).not.toContain(canarySecret);
      expect(row.credential_ciphertext).not.toContain("sk-deepseek-test-secret");
    }
  });
});
