import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { generateSessionToken, digestSessionToken } from "@qianliu/provider-adapters";
import { buildControlApi } from "../server.js";
import { allowsRoute } from "../admins/access.js";
let pg: PostgresTestInstance, db: ReturnType<typeof createKysely>, app: ReturnType<typeof buildControlApi>, cookie: string;
const enterpriseId = randomUUID(), adminId = randomUUID();
beforeAll(async () => {
  vi.stubEnv("FEATURE_DIRECTORY_IMPORT", "true");
  pg = await startPostgresContainer(); db = createKysely(pg.connectionString); await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "F02 isolated" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId, username: "operator", password_hash: "unused", role_code: "CUSTOM" }).execute();
  await db.insertInto("admin_role").values({ enterprise_id: enterpriseId, name: "主体操作岗", permissions: { principals: { view: true, operate: true } } }).execute();
  app = buildControlApi(db); await app.ready();
  const token = generateSessionToken(); await app.adminRepo.createSession(adminId, digestSessionToken(token), new Date(Date.now() + 600_000)); cookie = "qianliu_admin_session=" + token;
}, 120_000);
afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); vi.unstubAllEnvs(); });
describe("F02 既有组织通讯录权限", () => {
  it("操作岗能读来源和模板、保存来源、创建并查询同步任务", async () => {
    for (const url of ["/directory-members", "/directory-sources/WECOM", "/directory-excel-template"]) {
      expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(200);
    }
    const saved = await app.inject({ method: "PUT", url: "/directory-sources/WECOM", headers: { cookie }, payload: {
      expected_version: 0, config: { corp_id: "F02-test", corp_secret: "F02-never-real-secret" },
    } });
    expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain("F02-never-real-secret");
    const run = await app.inject({ method: "POST", url: "/directory-sync-runs", headers: { cookie }, payload: { source_id: saved.json().source.id, idempotency_key: "F02-test-run-1" } });
    expect(run.statusCode).toBe(202);
    for (const tail of ["", "/items"]) expect((await app.inject({ url: "/directory-import-runs/" + run.json().runId + tail, headers: { cookie } })).statusCode).toBe(200);
    const upload = await app.inject({ method: "POST", url: "/directory-excel-imports", headers: { cookie }, payload: {} });
    expect(upload.statusCode).toBe(406); // Authorized; multipart parser rejects the deliberately non-multipart input.
  });
  it("只读岗不能写，撤去查看权限后拒绝读取，未知端点仍默认拒绝", async () => {
    await db.updateTable("admin_role").set({ permissions: { principals: { view: true, operate: false } } }).where("enterprise_id", "=", enterpriseId).execute();
    expect((await app.inject({ url: "/directory-excel-template", headers: { cookie } })).statusCode).toBe(200);
    for (const [method, url] of [["PUT", "/directory-sources/WECOM"], ["POST", "/directory-sync-runs"], ["POST", "/directory-excel-imports"]] as const) expect((await app.inject({ method, url, headers: { cookie }, payload: {} })).statusCode).toBe(403);
    await db.updateTable("admin_role").set({ permissions: {} }).where("enterprise_id", "=", enterpriseId).execute();
    expect((await app.inject({ url: "/directory-sources/WECOM", headers: { cookie } })).statusCode).toBe(403);
    expect(allowsRoute({ adminUserId: adminId, enterpriseId, username: "operator", displayName: "操作岗", mustChangePassword: false, roleCode: "CUSTOM", permissions: { principals: { view: true, operate: true } } }, "/directory-unregistered", "GET")).toBe(false);
  });
});
