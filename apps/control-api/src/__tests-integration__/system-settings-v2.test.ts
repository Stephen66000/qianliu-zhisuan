import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { generateSessionToken, digestSessionToken } from "@qianliu/provider-adapters";
import { buildControlApi } from "../server.js";
import { hashPassword } from "../auth/password.js";
import { createMigrator } from "../../../../packages/database/src/migrator.js";
let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>; let app: ReturnType<typeof buildControlApi>;
const ent = randomUUID(), owner = randomUUID(), custom = randomUUID(), otherEnt = randomUUID();
let ownerCookie: string, customCookie: string, customSession: string, otherSession: string;
async function session(id: string) {
  const token = generateSessionToken();
  const row = await app.adminRepo.createSession(id, digestSessionToken(token), new Date(Date.now() + 8 * 3600_000));
  return { cookie: "qianliu_admin_session=" + token, id: row.id };
}
beforeAll(async () => {
  pg = await startPostgresContainer(); db = createKysely(pg.connectionString);
  const source = await createMigrator(db).migrateTo("0071_enterprise_contact_details");
  if (source.error) throw source.error;
  await db.insertInto("enterprise").values([{ id: ent, name: "设置测试", created_at: new Date("2020-01-01") }, { id: otherEnt, name: "其他企业" }]).execute();
  const password_hash = await hashPassword("Settings-Test-2026!");
  await db.insertInto("admin_user").values({ id: owner, enterprise_id: ent, username: "owner", display_name: "负责人", password_hash }).execute();
  expect(await migrateToLatest(db)).toEqual([
    "0072_admin_roles_security", "0073_credential_chat_probe", "0074_runtime_notification_recipients",
    "0075_provider_resource_archive", "0076_provider_model_probe", "0077_provider_model_probe_run_identity",
    "0078_provider_model_probe_enum_checks", "0079_project_allocation_relations", "0080_project_allocation_compute",
  ]);
  await db.insertInto("admin_user").values([{ id: custom, enterprise_id: ent, username: "custom", display_name: "查看账号", role_code: "CUSTOM", password_hash },
    { id: otherEnt, enterprise_id: otherEnt, username: "other", password_hash }]).execute();
  app = buildControlApi(db); await app.ready(); ownerCookie = (await session(owner)).cookie;
  const c = await session(custom); customCookie = c.cookie; customSession = c.id; otherSession = (await session(otherEnt)).id;
}, 120_000);
afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); });
describe("系统设置第二版", () => {
  it("保留老管理员全部权限，自定义岗位未配置时拒绝访问", async () => {
    const me = await app.inject({ url: "/auth/me", headers: { cookie: ownerCookie } });
    expect(me.json().admin.roleCode).toBe("SUPER_ADMIN");
    expect((await app.inject({ url: "/principals", headers: { cookie: customCookie } })).statusCode).toBe(403);
  });
  it("岗位名称必填、未知权限及越权授权被拒绝", async () => {
    for (const payload of [ { expected_version: 0, name: " ", permissions: {} },
      { expected_version: 0, name: "查看岗", permissions: { unknown: { view: true, operate: true } } },
      { expected_version: 0, name: "查看岗", permissions: { principals: { view: false, operate: true } } },
      { expected_version: 0, name: "查看岗", permissions: { admins: { view: true, operate: true } } } ]) {
      expect((await app.inject({ method: "PUT", url: "/admin-role", headers: { cookie: ownerCookie }, payload })).statusCode).toBe(400);
    }
  });
  it("保存命名岗位、旧会话实时应用权限、限制写入及直接访问", async () => {
    expect((await app.inject({ method: "PUT", url: "/admin-role", headers: { cookie: ownerCookie }, payload: {
      expected_version: 0, name: "业务查看岗", permissions: { principals: { view: true, operate: false }, audit: { view: true, operate: false }, admins: { view: true, operate: false } },
    } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/principals", headers: { cookie: customCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/principals", headers: { cookie: customCookie }, payload: { name: "越权", type: "EMPLOYEE" } })).statusCode).toBe(403);
    for (const url of ["/enterprise-settings", "/provider-resources", "/security-settings"]) expect((await app.inject({ url, headers: { cookie: customCookie } })).statusCode).toBe(403);
    const refs = await app.inject({ url: "/reference-data/resources", headers: { cookie: customCookie } });
    expect(refs.statusCode).toBe(200); expect(refs.body).not.toMatch(/credential|balance|password|secret/);
    expect((await app.inject({ method: "PATCH", url: "/admins/" + custom, headers: { cookie: customCookie }, payload: { display_name: "越权", role_code: "SUPER_ADMIN" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/admin-role", headers: { cookie: ownerCookie }, payload: { expected_version: 0, name: "过期", permissions: {} } })).statusCode).toBe(409);
  });
  it("保护最后一个超级管理员，不能因仍有自定义账号而降级", async () => {
    expect((await app.inject({ method: "PATCH", url: "/admins/" + owner, headers: { cookie: ownerCookie }, payload: { display_name: "负责人", role_code: "CUSTOM" } })).statusCode).toBe(409);
    expect((await db.selectFrom("admin_user").select("role_code").where("id", "=", owner).executeTakeFirstOrThrow()).role_code).toBe("SUPER_ADMIN");
  });
  it("审计支持企业时区的单日及区间、操作人、失败和越界输入", async () => {
    for (const [created_at, result] of [["2026-09-07T15:59:59Z", "SUCCESS"], ["2026-09-07T16:00:00Z", "FAILURE"], ["2026-09-08T15:59:59Z", "SUCCESS"], ["2026-09-08T16:00:00Z", "SUCCESS"]] as const) {
      await db.insertInto("operation_log").values({ enterprise_id: ent, admin_user_id: owner, actor_source: "ADMIN", action: "test.date", target_type: "enterprise", result, created_at: new Date(created_at) }).execute();
    }
    const day = await app.inject({ url: "/operation-logs?from=2026-09-08&to=2026-09-08&actor=" + owner, headers: { cookie: ownerCookie } });
    expect(day.statusCode).toBe(200); expect(day.json().logs).toHaveLength(2); expect(day.json().logs[0].actor_name).toBe("负责人");
    expect((await app.inject({ url: "/operation-logs?from=2026-09-07&to=2026-09-08&result=FAILURE", headers: { cookie: ownerCookie } })).json().logs).toHaveLength(1);
    for (const query of ["from=2026-09-09&to=2026-09-08", "from=2026-02-30", "limit=NaN"]) expect((await app.inject({ url: "/operation-logs?" + query, headers: { cookie: ownerCookie } })).statusCode).toBe(400);
  });
  it("安全配置持久化、乐观锁、有效会话隔离与撤销", async () => {
    const payload = { expected_version: 1, session_minutes: 30, login_max_failures: 3, login_lock_minutes: 15, force_initial_password_change: false };
    expect((await app.inject({ method: "PATCH", url: "/security-settings", payload, headers: { cookie: ownerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/security-settings", payload, headers: { cookie: ownerCookie } })).statusCode).toBe(409);
    const listed = await app.inject({ url: "/admin-sessions", headers: { cookie: ownerCookie } });
    expect(listed.body).not.toMatch(/token_hash|password_hash/); expect(listed.body).not.toContain(otherSession);
    expect((await app.inject({ method: "DELETE", url: "/admin-sessions/" + otherSession, headers: { cookie: ownerCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/admin-sessions/" + listed.json().current_session_id, headers: { cookie: ownerCookie } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/admin-sessions/" + customSession, headers: { cookie: ownerCookie } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/auth/me", headers: { cookie: customCookie } })).statusCode).toBe(401);
  });
  it("新账号使用岗位及首次改密策略，新登录按保存的时长与失败次数执行", async () => {
    const created = await app.inject({ method: "POST", url: "/admins", headers: { cookie: ownerCookie }, payload: { username: "new", display_name: "新账号", role_code: "CUSTOM", password: "Settings-Test-2026!" } });
    expect(created.statusCode).toBe(201); expect(created.json().admin).toMatchObject({ role_code: "CUSTOM", must_change_password: false });
    const beforeLogin = Date.now();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "new", password: "Settings-Test-2026!" } });
    expect(login.statusCode).toBe(200);
    const stored = await db.selectFrom("admin_session").select(["created_at", "expires_at"]).where("admin_user_id", "=", created.json().admin.id).executeTakeFirstOrThrow();
    expect(stored.expires_at.getTime()).toBeGreaterThanOrEqual(beforeLogin + 30 * 60_000);
    expect(stored.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "rate-test", password: "wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "rate-test", password: "wrong" } })).statusCode).toBe(429);
  });
  it("自定义角色撤权立即生效，历史审计未丢失，版本不伪造", async () => {
    const c = await session(custom);
    expect((await app.inject({ method: "PUT", url: "/admin-role", headers: { cookie: ownerCookie }, payload: { expected_version: 1, name: "暂停查看岗", permissions: {} } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/principals", headers: { cookie: c.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/system-version", headers: { cookie: ownerCookie } })).json()).toMatchObject({ product: "仟流智算", releases: [] });
    const count = await sql<{ count: string }>`SELECT count(*)::text AS count FROM operation_log WHERE action='admin.role.update' AND enterprise_id=${ent}::uuid`.execute(db);
    expect(Number(count.rows[0]?.count)).toBe(2);
  });
});
