import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateDown, migrateToLatest } from "@qianliu/database";
import {
  startPostgresContainer,
  type PostgresTestInstance,
} from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

const PASSWORD = "System-Settings-2026!";
const enterpriseId = randomUUID();
const adminId = randomUUID();

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db
    .insertInto("enterprise")
    .values({ id: enterpriseId, name: "仟流测试企业" })
    .execute();
  await db
    .insertInto("admin_user")
    .values({
      id: adminId,
      enterprise_id: enterpriseId,
      username: "settings-admin",
      password_hash: await hashPassword(PASSWORD),
      status: "ACTIVE",
    })
    .execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "settings-admin", password: PASSWORD },
  });
  const setCookie = login.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(
    ";",
  )[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("系统设置第一版：企业信息", () => {
  it("读取、保存、清空联系信息，并保留并发与审计边界", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/enterprise-settings",
      headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({
      name: "仟流测试企业",
      management_contact: null,
      contact_email: null,
      timezone: "Asia/Shanghai",
      default_currency: "CNY",
      version: 1,
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/enterprise-settings",
      headers: { cookie },
      payload: {
        expected_version: 1,
        name: "仟流智算",
        management_contact: "企业管理员",
        contact_email: "admin@example.com",
        timezone: "Asia/Singapore",
        default_currency: "SGD",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toMatchObject({
      name: "仟流智算",
      management_contact: "企业管理员",
      contact_email: "admin@example.com",
      timezone: "Asia/Singapore",
      default_currency: "SGD",
      version: 2,
    });
    expect(await migrateDown(db)).toBe("0072_admin_roles_security");
    await expect(migrateDown(db)).rejects.toThrow(
      "0071 down refused: enterprise contact details already contain data",
    );
    await migrateToLatest(db);

    const stale = await app.inject({
      method: "PATCH",
      url: "/enterprise-settings",
      headers: { cookie },
      payload: { expected_version: 1, name: "过期修改" },
    });
    expect(stale.statusCode).toBe(409);

    const cleared = await app.inject({
      method: "PATCH",
      url: "/enterprise-settings",
      headers: { cookie },
      payload: {
        expected_version: 2,
        management_contact: null,
        contact_email: "",
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings).toMatchObject({
      management_contact: null,
      contact_email: null,
      version: 3,
    });

    const audits = await db
      .selectFrom("operation_log")
      .select(["action", "admin_user_id", "change_summary"])
      .where("enterprise_id", "=", enterpriseId)
      .where("action", "=", "enterprise_settings.update")
      .orderBy("created_at", "asc")
      .execute();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      admin_user_id: adminId,
      change_summary: {
        before: { management_contact: null, contact_email: null },
        after: {
          management_contact: "企业管理员",
          contact_email: "admin@example.com",
        },
      },
    });
  });
});
