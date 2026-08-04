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
const FOREIGN_ENT_ID = randomUUID();
const ADM_ID = randomUUID();
const ACTIVE_MODEL_ID = randomUUID();
const SECOND_ACTIVE_MODEL_ID = randomUUID();
const INACTIVE_MODEL_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db
    .insertInto("enterprise")
    .values([
      { id: ENT_ID, name: "仟流测试企业" },
      { id: FOREIGN_ENT_ID, name: "其他测试企业" },
    ])
    .execute();
  await db
    .insertInto("unified_model")
    .values([
      {
        id: ACTIVE_MODEL_ID,
        enterprise_id: ENT_ID,
        alias: "qianliu-deepseek",
        display_name: "仟流 DeepSeek",
      },
      {
        id: SECOND_ACTIVE_MODEL_ID,
        enterprise_id: ENT_ID,
        alias: "qianliu-glm",
        display_name: "仟流 GLM",
      },
      {
        id: INACTIVE_MODEL_ID,
        enterprise_id: ENT_ID,
        alias: "inactive-model",
        display_name: "已停用模型",
        status: "DISABLED",
      },
      {
        enterprise_id: FOREIGN_ENT_ID,
        alias: "foreign-model",
        display_name: "其他企业模型",
      },
    ])
    .execute();
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
    const omitted = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
    });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error).toBe("invalid_request");

    const res = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^sk-qianliu-/);
    expect(body.key_prefix).toMatch(/^sk-qianliu-/);
    expect(body.warning).toContain("一次");
    expect(body.metadata.id).toBeDefined();
    expect(body.metadata.allowed_model_ids).toEqual([ACTIVE_MODEL_ID]);

    const stored = await db
      .selectFrom("principal_key")
      .select("allowed_model_ids")
      .where("id", "=", body.metadata.id)
      .executeTakeFirstOrThrow();
    expect(stored.allowed_model_ids).toEqual([ACTIVE_MODEL_ID]);
  });

  it("生成 Key 拒绝非本企业、非 ACTIVE 与重复模型", async () => {
    for (const allowedModelIds of [
      [INACTIVE_MODEL_ID],
      [
        (
          await db
            .selectFrom("unified_model")
            .select("id")
            .where("enterprise_id", "=", FOREIGN_ENT_ID)
            .executeTakeFirstOrThrow()
        ).id,
      ],
    ]) {
      const pid = await createPrincipal("EMPLOYEE", `非法授权-${randomUUID().slice(0, 6)}`);
      const res = await app.inject({
        method: "POST",
        url: `/principals/${pid}/key`,
        headers: { cookie: adminCookie },
        payload: { allowed_model_ids: allowedModelIds },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_model_authorization");
    }

    const duplicatePid = await createPrincipal("EMPLOYEE", "重复模型授权");
    const duplicate = await app.inject({
      method: "POST",
      url: `/principals/${duplicatePid}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID, ACTIVE_MODEL_ID] },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toBe("invalid_request");
  });

  it("重复生成 Key 被拒（每主体默认一把主 Key）", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
    });
    expect(res.statusCode).toBe(409);
  });

  it("重新创建 Key 时以本次显式选择替换历史手工权限基线", async () => {
    const pid = await createPrincipal("EMPLOYEE", "历史基线替换员工");
    await db.insertInto("principal_model_manual_authorization").values({
      enterprise_id: ENT_ID, principal_id: pid, unified_model_id: ACTIVE_MODEL_ID,
    }).execute();
    const created = await app.inject({
      method: "POST", url: `/principals/${pid}/key`, headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [SECOND_ACTIVE_MODEL_ID] },
    });
    expect(created.statusCode).toBe(201);
    const baseline = await db.selectFrom("principal_model_manual_authorization")
      .select("unified_model_id").where("principal_id", "=", pid).execute();
    expect(baseline.map((item) => item.unified_model_id)).toEqual([SECOND_ACTIVE_MODEL_ID]);
  });

  it("并发生成 Key：数据库门禁保证仅一把 ACTIVE，另一请求稳定返回 409", async () => {
    const pid = await createPrincipal("EMPLOYEE", "并发创建 Key 员工");
    const createRequest = () =>
      app.inject({
        method: "POST",
        url: `/principals/${pid}/key`,
        headers: { cookie: adminCookie },
        payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
      });
    const results = await Promise.all([createRequest(), createRequest()]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    const conflict = results.find((result) => result.statusCode === 409);
    expect(conflict?.json().error).toBe("key_exists");

    const activeKeys = await db
      .selectFrom("principal_key")
      .select(["id", "allowed_model_ids"])
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", pid)
      .where("status", "=", "ACTIVE")
      .execute();
    expect(activeKeys).toHaveLength(1);
    expect(activeKeys[0]!.allowed_model_ids).toEqual([ACTIVE_MODEL_ID]);
  });

  it("当前 Key 可更新为显式模型集合或空集合", async () => {
    const update = await app.inject({
      method: "PATCH",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [SECOND_ACTIVE_MODEL_ID] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().key.allowed_model_ids).toEqual([SECOND_ACTIVE_MODEL_ID]);

    const denyAll = await app.inject({
      method: "PATCH",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [] },
    });
    expect(denyAll.statusCode).toBe(200);
    expect(denyAll.json().key.allowed_model_ids).toEqual([]);

    const restore = await app.inject({
      method: "PATCH",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
    });
    expect(restore.statusCode).toBe(200);
  });

  it("主体没有有效 Key 时不写入手工授权基线并返回 404", async () => {
    const pid = await createPrincipal("EMPLOYEE", "无 Key 员工");
    const response = await app.inject({
      method: "PATCH",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
    });
    expect(response.statusCode).toBe(404);
    expect(await db.selectFrom("principal_model_manual_authorization")
      .select("unified_model_id")
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", pid)
      .execute()).toEqual([]);
  });

  it("重置 Key：旧 Key 撤销、新 Key 不同（WT-09）", async () => {
    const beforeKeys = await app.inject({
      method: "GET",
      url: `/principals/${testPrincipalId}/key`,
      headers: { cookie: adminCookie },
    });
    const oldActive = beforeKeys.json().keys.find((k: { status: string }) => k.status === "ACTIVE");
    expect(oldActive).toBeDefined();
    const expiresAt = new Date("2027-01-02T03:04:05.000Z");
    await db
      .updateTable("principal_key")
      .set({
        ip_allowlist: JSON.stringify(["10.0.0.0/8"]) as unknown as string[],
        expires_at: expiresAt,
        quota_limit: 123456n,
        concurrency_limit: 7,
      })
      .where("id", "=", oldActive.id)
      .execute();

    const resetRes = await app.inject({
      method: "POST",
      url: `/principals/${testPrincipalId}/key/reset`,
      headers: { cookie: adminCookie },
    });
    expect(resetRes.statusCode).toBe(200);
    const newKey = resetRes.json().key;
    expect(newKey).toMatch(/^sk-qianliu-/);
    expect(resetRes.json().warning).toContain("立即失效");

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

    const inherited = await db
      .selectFrom("principal_key")
      .select([
        "allowed_model_ids",
        "ip_allowlist",
        "expires_at",
        "quota_limit",
        "concurrency_limit",
      ])
      .where("id", "=", newActive.id)
      .executeTakeFirstOrThrow();
    expect(inherited.allowed_model_ids).toEqual([ACTIVE_MODEL_ID]);
    expect(inherited.ip_allowlist).toEqual(["10.0.0.0/8"]);
    expect(inherited.expires_at).toEqual(expiresAt);
    expect(inherited.quota_limit).toBe("123456");
    expect(inherited.concurrency_limit).toBe(7);
  });

  it("重置兼容仅在旧 Key 保存模型、尚无手工授权基线的历史记录", async () => {
    const pid = await createPrincipal("EMPLOYEE", "历史 Key 员工");
    const created = await app.inject({
      method: "POST",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
    });
    expect(created.statusCode).toBe(201);
    await db.deleteFrom("principal_model_manual_authorization")
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", pid)
      .execute();

    const reset = await app.inject({
      method: "POST",
      url: `/principals/${pid}/key/reset`,
      headers: { cookie: adminCookie },
    });
    expect(reset.statusCode).toBe(200);
    const active = await db.selectFrom("principal_key")
      .select("allowed_model_ids")
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", pid)
      .where("status", "=", "ACTIVE")
      .executeTakeFirstOrThrow();
    expect(active.allowed_model_ids).toEqual([ACTIVE_MODEL_ID]);
  });

  it("并发重置串行化，最终只保留一把 ACTIVE Key", async () => {
    const pid = await createPrincipal("PROJECT", "并发重置项目");
    const created = await app.inject({
      method: "POST",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [ACTIVE_MODEL_ID] },
    });
    expect(created.statusCode).toBe(201);

    const results = await Promise.all([
      app.inject({
        method: "POST",
        url: `/principals/${pid}/key/reset`,
        headers: { cookie: adminCookie },
      }),
      app.inject({
        method: "POST",
        url: `/principals/${pid}/key/reset`,
        headers: { cookie: adminCookie },
      }),
    ]);
    expect(
      results.every((result) => result.statusCode === 200 || result.statusCode === 404),
    ).toBe(true);
    expect(results.some((result) => result.statusCode === 200)).toBe(true);

    const allKeys = await db
      .selectFrom("principal_key")
      .select(["id", "status", "allowed_model_ids"])
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", pid)
      .execute();
    const activeKeys = allKeys.filter((key) => key.status === "ACTIVE");
    expect(activeKeys).toHaveLength(1);
    expect(activeKeys[0]!.allowed_model_ids).toEqual([ACTIVE_MODEL_ID]);
    expect(allKeys.filter((key) => key.status === "REVOKED").length).toBeGreaterThanOrEqual(1);
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

  it("分配 grant 拒绝负数与非整数额度", async () => {
    for (const quotaValue of ["-1", "1.5", "abc"]) {
      const res = await app.inject({
        method: "POST",
        url: `/principals/${testPrincipalId}/grants`,
        headers: { cookie: adminCookie },
        payload: {
          provider: "deepseek",
          model_alias: "qianliu-deepseek",
          quota_value: quotaValue,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("停用主体同步撤销全部 Key（TRD §5.3 L219）", async () => {
    const pid = await createPrincipal("PROJECT", "停用测试项目");
    await app.inject({
      method: "POST",
      url: `/principals/${pid}/key`,
      headers: { cookie: adminCookie },
      payload: { allowed_model_ids: [] },
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
      payload: { allowed_model_ids: [] },
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
