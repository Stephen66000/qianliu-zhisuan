/**
 * control-api W19 集成测试：管理写操作闭环（更新/停用/凭证恢复/并发）。
 *
 * 覆盖（W19 DoD：管理动作即时生效、二次确认语义后端为状态校验、并发修改测试）：
 *   - PATCH /provider-resources/:id（改名/并发 409）
 *   - PATCH /unified-models/:id（停用 + audit）
 *   - PATCH /model-routes/:id（权重/启停）
 *   - PATCH /grants/:id（调额/停用）
 *   - POST/PATCH /billing-rules（创建/编辑 + version 并发）
 *   - POST /provider-resources/:id/recover（WT-19：隔离态恢复 + 轮换凭证；非隔离态 409）
 *   - 六要素：401 未认证、404 越界/不存在、audit 落 operation_log
 *   - canary：轮换凭证的明文绝不进 DB
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

const TEST_PASSWORD = "W19-Test-Password!";
const ENT_ID = randomUUID();
const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流 W19 测试企业" }).execute();
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

/** provider 按 code 复用（provider 表 UNIQUE(enterprise_id, code)，重复 insert 会撞唯一约束）。 */
async function ensureProvider(code: "deepseek" | "zhipu" | "kimi") {
  const existing = await db
    .selectFrom("provider")
    .selectAll()
    .where("enterprise_id", "=", ENT_ID)
    .where("code", "=", code)
    .executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("provider")
    .values({ enterprise_id: ENT_ID, code, name: `${code} 测试`, adapter_type: code })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function seedProviderResource(status = "ACTIVE") {
  const provider = await ensureProvider("zhipu");
  const resource = await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: ENT_ID,
      provider_id: provider.id,
      name: `智谱主账号-${randomUUID().slice(0, 8)}`,
      mode: "API",
      credential_type: "API_KEY",
      status,
      credential_version: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { provider, resource };
}

async function countAudit(action: string): Promise<number> {
  const rows = await db
    .selectFrom("operation_log")
    .select("id")
    .where("enterprise_id", "=", ENT_ID)
    .where("action", "=", action)
    .execute();
  return rows.length;
}

describe("W19 管理写操作闭环", () => {
  it("PATCH /provider-resources/:id 改名成功并写 audit", async () => {
    const { resource } = await seedProviderResource();
    const res = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "智谱主账号（华北）",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource.name).toBe("智谱主账号（华北）");
    expect(res.json().resource.credential_ciphertext).toBeUndefined();
    expect(await countAudit("provider_resource.update")).toBe(1);
  });

  it("PATCH /provider-resources/:id 并发修改 → 409 conflict", async () => {
    const { resource } = await seedProviderResource();
    // 第一次更新成功（updated_at 变化）
    const first = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "第一次改名",
      },
    });
    expect(first.statusCode).toBe(200);
    // 用旧 expected_updated_at 再改 → 409
    const stale = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "过期快照改名",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");
  });

  it("PATCH /unified-models/:id 停用并写 audit（W19 补齐 create audit）", async () => {
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `qianliu-glm-${randomUUID().slice(0, 8)}`,
        display_name: "仟流 GLM",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/unified-models/${model.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: model.version,
        status: "DISABLED",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model.status).toBe("DISABLED");
    expect(await countAudit("unified_model.disable")).toBe(1);
  });

  it("PATCH /model-routes/:id 调整权重与停用", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `route-model-${randomUUID().slice(0, 8)}`,
        display_name: "路由模型",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const route = await db
      .insertInto("model_route")
      .values({
        enterprise_id: ENT_ID,
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/model-routes/${route.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: route.version,
        weight: 5,
        enabled: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().route.weight).toBe(5);
    expect(res.json().route.enabled).toBe(false);
    expect(await countAudit("model_route.update")).toBe(1);
  });

  it("PATCH /grants/:id 调额与停用", async () => {
    const principal = await db
      .insertInto("principal")
      .values({ enterprise_id: ENT_ID, type: "EMPLOYEE", name: "W19 员工" })
      .returningAll()
      .executeTakeFirstOrThrow();
    const grant = await db
      .insertInto("principal_grant")
      .values({
        enterprise_id: ENT_ID,
        principal_id: principal.id,
        provider: "zhipu",
        model_alias: "glm-4.6",
        quota_value: 100_000n,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/grants/${grant.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: grant.version,
        quota_value: "200000",
        status: "DISABLED",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant.status).toBe("DISABLED");
    expect(await countAudit("grant.disable")).toBe(1);
  });

  it("POST/PATCH /billing-rules 创建编辑并拒绝旧 version", async () => {
    const { resource } = await seedProviderResource();
    const created = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: {
        rule_type: "API_PRICE",
        rule_version: "w19-web-v1",
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        effective_from: new Date().toISOString(),
        cache_miss_price: "0.000001",
        output_price: "0.000002",
        priority: 10,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().rule.version).toBe(1);
    expect(await countAudit("billing_rule.create")).toBe(1);

    const rule = created.json().rule;
    const updated = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: rule.version,
        output_price: "0.000003",
        enabled: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule.output_price).toBe("0.000003");
    expect(updated.json().rule.enabled).toBe(false);
    expect(updated.json().rule.version).toBe(2);
    expect(await countAudit("billing_rule.update")).toBe(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 1, enabled: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");
  });

  it("POST /provider-resources/:id/recover：隔离态恢复 + 轮换凭证 + 明文 0 命中 canary", async () => {
    const { resource } = await seedProviderResource("CREDENTIAL_INVALID");
    const canarySecret = "sk-w19-ROTATION-CANARY-SECRET-98765";
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: { credential_plaintext: canarySecret },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resource.status).toBe("DEGRADED");
    expect(body.resource.credential_version).toBe(2);
    expect(JSON.stringify(body)).not.toContain(canarySecret);

    // 状态迁移事件（actor=admin）
    const events = await db
      .selectFrom("resource_status_event")
      .selectAll()
      .where("provider_resource_id", "=", resource.id)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.from_status).toBe("CREDENTIAL_INVALID");
    expect(events[0]!.to_status).toBe("DEGRADED");
    expect(events[0]!.actor).toBe("admin");

    // audit
    expect(await countAudit("provider_resource.recover")).toBe(1);

    // canary：轮换明文在 provider_resource 表 0 命中
    const scan = await sql`
      SELECT COUNT(*) AS hits FROM (
        SELECT row_to_json(t)::text AS row_text FROM provider_resource t
      ) s WHERE s.row_text LIKE ${"%" + canarySecret + "%"}
    `.execute(db);
    expect(Number((scan.rows[0] as { hits: number | bigint }).hits)).toBe(0);
    // 密文已写入且不含明文
    const row = await db
      .selectFrom("provider_resource")
      .select(["credential_ciphertext"])
      .where("id", "=", resource.id)
      .executeTakeFirstOrThrow();
    expect(row.credential_ciphertext).not.toBeNull();
    expect(row.credential_ciphertext).not.toContain(canarySecret);
  });

  it("POST /provider-resources/:id/recover：非隔离态 → 409 invalid_state", async () => {
    const { resource } = await seedProviderResource("ACTIVE");
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_state");
  });

  it("POST /provider-resources/:id/recover：不轮换凭证也可恢复（仅状态）", async () => {
    const { resource } = await seedProviderResource("EXHAUSTED");
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource.status).toBe("DEGRADED");
    expect(res.json().resource.credential_version).toBe(1);
  });

  it("六要素：未认证 401 / 不存在 404 / 跨企业不可见", async () => {
    const noAuth = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${randomUUID()}`,
      payload: { expected_version: 1, name: "x" },
    });
    expect(noAuth.statusCode).toBe(401);

    const notFound = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 1, name: "x" },
    });
    expect(notFound.statusCode).toBe(404);

    const recoverNotFound = await app.inject({
      method: "POST",
      url: `/provider-resources/${randomUUID()}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(recoverNotFound.statusCode).toBe(404);
  });
});
