import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createKysely,
  migrateDown,
  migrateToLatest,
  type Database,
} from "@qianliu/database";
import {
  startPostgresContainer,
  type PostgresTestInstance,
} from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;

const enterpriseId = randomUUID();
const adminId = randomUUID();
const adminPassword = "Pool015-Admin-Start!";

function cookieOf(response: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("响应未设置 Cookie");
  return value.split(";")[0]!;
}

async function login(username: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password },
  });
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db
    .insertInto("enterprise")
    .values({ id: enterpriseId, name: "POOL-015 企业" })
    .execute();
  await db
    .insertInto("admin_user")
    .values({
      id: adminId,
      enterprise_id: enterpriseId,
      username: "owner",
      display_name: "老板",
      password_hash: await hashPassword(adminPassword),
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

describe("POOL-015 管理员生命周期", () => {
  it("创建、首次改密、重置、停用、企业隔离与审计形成闭环", async () => {
    const ownerLogin = await login("owner", adminPassword);
    expect(ownerLogin.statusCode).toBe(200);
    const ownerCookie = cookieOf(ownerLogin);

    const invalidCleanup = await app.inject({
      method: "DELETE",
      url: "/admins/not-a-uuid",
      headers: { cookie: ownerCookie },
    });
    expect(invalidCleanup.statusCode).toBe(400);

    const weak = await app.inject({
      method: "POST",
      url: "/admins",
      headers: { cookie: ownerCookie },
      payload: {
        username: "second",
        display_name: "第二管理员",
        password: "weak",
      },
    });
    expect(weak.statusCode).toBe(400);

    const initialPassword = "Pool015-Second-Start!";
    const created = await app.inject({
      method: "POST",
      url: "/admins",
      headers: { cookie: ownerCookie },
      payload: {
        username: "second",
        display_name: "第二管理员",
        password: initialPassword,
      },
    });
    expect(created.statusCode).toBe(201);
    const secondId = created.json().admin.id as string;
    expect(created.json().admin).toMatchObject({
      username: "second",
      display_name: "第二管理员",
      status: "ACTIVE",
      must_change_password: true,
    });
    expect(JSON.stringify(created.json())).not.toContain(initialPassword);

    const duplicate = await app.inject({
      method: "POST",
      url: "/admins",
      headers: { cookie: ownerCookie },
      payload: {
        username: "second",
        display_name: "重复",
        password: "Pool015-Duplicate-1!",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const secondLogin = await login("second", initialPassword);
    expect(secondLogin.statusCode).toBe(200);
    const secondCookie = cookieOf(secondLogin);
    expect(secondLogin.json().admin.must_change_password).toBe(true);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admins",
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(403);

    const wrongCurrent = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { cookie: secondCookie },
      payload: {
        current_password: "wrong",
        new_password: "Pool015-Second-New-1!",
      },
    });
    expect(wrongCurrent.statusCode).toBe(400);

    const changedPassword = "Pool015-Second-New-1!";
    const changed = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { cookie: secondCookie },
      payload: {
        current_password: initialPassword,
        new_password: changedPassword,
      },
    });
    expect(changed.statusCode).toBe(204);
    expect((await login("second", initialPassword)).statusCode).toBe(401);
    const secondRelogin = await login("second", changedPassword);
    expect(secondRelogin.statusCode).toBe(200);
    const secondReloginCookie = cookieOf(secondRelogin);
    expect(secondRelogin.json().admin.must_change_password).toBe(false);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/admins/${secondId}`,
      headers: { cookie: ownerCookie },
      payload: { display_name: "运维管理员" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().admin.display_name).toBe("运维管理员");

    const resetPassword = "Pool015-Second-Reset-1!";
    const reset = await app.inject({
      method: "POST",
      url: `/admins/${secondId}/reset-password`,
      headers: { cookie: ownerCookie },
      payload: { new_password: resetPassword },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().admin.must_change_password).toBe(true);
    expect(JSON.stringify(reset.json())).not.toContain(resetPassword);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/auth/me",
          headers: { cookie: secondReloginCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect((await login("second", changedPassword)).statusCode).toBe(401);
    expect((await login("second", resetPassword)).statusCode).toBe(200);

    const selfDisable = await app.inject({
      method: "POST",
      url: `/admins/${adminId}/disable`,
      headers: { cookie: ownerCookie },
    });
    expect(selfDisable.statusCode).toBe(409);
    expect(selfDisable.json().error).toBe("self_disable_forbidden");

    const selfCleanup = await app.inject({
      method: "DELETE",
      url: `/admins/${adminId}`,
      headers: { cookie: ownerCookie },
    });
    expect(selfCleanup.statusCode).toBe(409);
    expect(selfCleanup.json().error).toBe("self_cleanup_forbidden");

    const disabled = await app.inject({
      method: "POST",
      url: `/admins/${secondId}/disable`,
      headers: { cookie: ownerCookie },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().admin.status).toBe("DISABLED");
    expect((await login("second", resetPassword)).statusCode).toBe(401);

    const enabled = await app.inject({
      method: "POST",
      url: `/admins/${secondId}/enable`,
      headers: { cookie: ownerCookie },
    });
    expect(enabled.statusCode).toBe(200);

    const cleanupActive = await app.inject({
      method: "DELETE",
      url: `/admins/${secondId}`,
      headers: { cookie: ownerCookie },
    });
    expect(cleanupActive.statusCode).toBe(409);
    expect(cleanupActive.json().error).toBe("admin_must_be_disabled");

    const cleanupImplementation = app.adminRepo.cleanup.bind(app.adminRepo);
    app.adminRepo.cleanup = async () => {
      throw new Error("cleanup-storage-failure");
    };
    const cleanupFailure = await app.inject({
      method: "DELETE",
      url: `/admins/${secondId}`,
      headers: { cookie: ownerCookie },
    });
    expect(cleanupFailure.statusCode).toBe(500);
    app.adminRepo.cleanup = cleanupImplementation;

    const disabledForCleanup = await app.inject({
      method: "POST",
      url: `/admins/${secondId}/disable`,
      headers: { cookie: ownerCookie },
    });
    expect(disabledForCleanup.statusCode).toBe(200);
    await expect(
      app.adminRepo.cleanup({
        enterpriseId,
        actorAdminId: randomUUID(),
        targetAdminId: secondId,
      }),
    ).rejects.toThrow();
    expect(
      await db
        .selectFrom("admin_user")
        .select("archived_at")
        .where("id", "=", secondId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ archived_at: null });
    const cleanup = await app.inject({
      method: "DELETE",
      url: `/admins/${secondId}`,
      headers: { cookie: ownerCookie },
    });
    expect(cleanup.statusCode).toBe(204);
    expect((await login("second", resetPassword)).statusCode).toBe(401);
    const listedAfterCleanup = await app.inject({
      method: "GET",
      url: "/admins",
      headers: { cookie: ownerCookie },
    });
    expect(listedAfterCleanup.statusCode).toBe(200);
    expect(listedAfterCleanup.json().admins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: secondId })]),
    );
    const archived = await db
      .selectFrom("admin_user")
      .select(["status", "archived_at"])
      .where("id", "=", secondId)
      .executeTakeFirstOrThrow();
    expect(archived.status).toBe("DISABLED");
    expect(archived.archived_at).toBeInstanceOf(Date);
    const repeatedCleanup = await app.inject({
      method: "DELETE",
      url: `/admins/${secondId}`,
      headers: { cookie: ownerCookie },
    });
    expect(repeatedCleanup.statusCode).toBe(404);

    const otherEnterpriseId = randomUUID();
    const otherAdminId = randomUUID();
    await db
      .insertInto("enterprise")
      .values({ id: otherEnterpriseId, name: "其他企业" })
      .execute();
    await db
      .insertInto("admin_user")
      .values({
        id: otherAdminId,
        enterprise_id: otherEnterpriseId,
        username: "other",
        display_name: "其他管理员",
        password_hash: await hashPassword("Pool015-Other-Start!"),
        status: "ACTIVE",
      })
      .execute();
    const crossEnterpriseCleanup = await app.inject({
      method: "DELETE",
      url: `/admins/${otherAdminId}`,
      headers: { cookie: ownerCookie },
    });
    expect(crossEnterpriseCleanup.statusCode).toBe(404);
    expect(
      await db
        .selectFrom("admin_user")
        .select("archived_at")
        .where("id", "=", otherAdminId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ archived_at: null });
    const crossEnterprise = await app.inject({
      method: "PATCH",
      url: `/admins/${otherAdminId}`,
      headers: { cookie: ownerCookie },
      payload: { display_name: "越界" },
    });
    expect(crossEnterprise.statusCode).toBe(404);

    const logs = await db
      .selectFrom("operation_log")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("target_type", "=", "admin_user")
      .execute();
    const actions = logs.map((log) => log.action);
    expect(actions).toContain("admin.create");
    expect(actions).toContain("admin.rename");
    expect(actions).toContain("admin.password.change");
    expect(actions).toContain("admin.password.reset");
    expect(actions).toContain("admin.disable");
    expect(actions).toContain("admin.enable");
    expect(actions).toContain("admin.cleanup");
    const cleanupLog = logs.find(
      (log) =>
        log.action === "admin.cleanup" &&
        log.target_id === secondId &&
        log.result === "SUCCESS",
    );
    expect(cleanupLog).toMatchObject({
      target_type: "admin_user",
      target_id: secondId,
      result: "SUCCESS",
      change_summary: {
        username: "second",
        status: "DISABLED",
        archived_at: expect.any(String),
        sessions_revoked: true,
      },
    });
    expect(logs.some((log) => log.result === "FAILURE")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(initialPassword);
    expect(JSON.stringify(logs)).not.toContain(changedPassword);
    expect(JSON.stringify(logs)).not.toContain(resetPassword);
    expect(await migrateDown(db)).toBe("0070_alert_recovery_evidence");
    expect(await migrateDown(db)).toBe("0069_auth_error_evidence");
    expect(await migrateDown(db)).toBe("0068_alert_resource_context");
    await expect(migrateDown(db)).rejects.toThrow(
      "cannot roll back while archived administrators exist",
    );
  }, 120_000);
});
