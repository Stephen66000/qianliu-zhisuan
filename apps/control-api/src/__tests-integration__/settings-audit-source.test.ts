import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createKysely, migrateToLatest, DirectoryRepository } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { generateSessionToken, digestSessionToken } from "@qianliu/provider-adapters";
import { buildControlApi } from "../server.js";
let pg: PostgresTestInstance, db: ReturnType<typeof createKysely>, app: ReturnType<typeof buildControlApi>, cookie: string;
const enterpriseId = randomUUID(), adminId = randomUUID();
beforeAll(async () => {
  pg = await startPostgresContainer(); db = createKysely(pg.connectionString); await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "F03 isolated" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId, username: "owner", display_name: "F03 owner", password_hash: "unused" }).execute();
  app = buildControlApi(db); await app.ready();
  const token = generateSessionToken(); await app.adminRepo.createSession(adminId, digestSessionToken(token), new Date(Date.now() + 600_000)); cookie = "qianliu_admin_session=" + token;
}, 120_000);
afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); });
describe("F03 审计来源", () => {
  it("真实主体停用标注为人工，原有UNKNOWN历史记录不被改写", async () => {
    const historical = await db.insertInto("operation_log").values({ enterprise_id: enterpriseId, admin_user_id: adminId, action: "historical.unclassified", target_type: "principal", result: "SUCCESS" }).returning("id").executeTakeFirstOrThrow();
    const created = await app.inject({ method: "POST", url: "/principals", headers: { cookie }, payload: { name: "F03 project", type: "PROJECT" } });
    expect(created.statusCode).toBe(201);
    const disabled = await app.inject({ method: "PATCH", url: "/principals/" + created.json().principal.id, headers: { cookie }, payload: { status: "DISABLED" } });
    expect(disabled.statusCode).toBe(200);
    const logs = await app.inject({ url: "/operation-logs?search=principal.disable", headers: { cookie } });
    expect(logs.json().logs).toContainEqual(expect.objectContaining({ action: "principal.disable", actor_source: "ADMIN", actor_name: "F03 owner" }));
    expect((await db.selectFrom("operation_log").select("actor_source").where("id", "=", historical.id).executeTakeFirstOrThrow()).actor_source).toBe("UNKNOWN");
  });
  it("人工创建导入任务与后台执行、失败各自记录真实来源", async () => {
    const repo = new DirectoryRepository(db);
    const created = await repo.createRun({ enterpriseId, createdByAdminUserId: adminId, mode: "EXCEL", idempotencyKey: "F03-import", requestHash: "test-only", templateVersion: "v1", contentSha256: "a".repeat(64) });
    await repo.stageRun({ enterpriseId, runId: created.run.id, items: [{ rowNumber: 2, employeeNumber: "F03-001", normalizedName: "测试人员", normalizedDepartmentPath: "研发部" }] });
    await repo.applyRun(enterpriseId, created.run.id);
    const failing = await repo.createRun({ enterpriseId, createdByAdminUserId: adminId, mode: "EXCEL", idempotencyKey: "F03-failed", requestHash: "test-only-2", templateVersion: "v1", contentSha256: "b".repeat(64) });
    await repo.markRunFailed(enterpriseId, failing.run.id, "TEST_FAILURE");
    const logs = await db.selectFrom("operation_log").select(["action", "actor_source", "admin_user_id"]).where("enterprise_id", "=", enterpriseId).execute();
    expect(logs).toContainEqual({ action: "directory_excel_run.create", actor_source: "ADMIN", admin_user_id: adminId });
    expect(logs).toContainEqual({ action: "directory_import_item.created", actor_source: "SYSTEM", admin_user_id: adminId });
    expect(logs).toContainEqual({ action: "directory_import_run.complete", actor_source: "SYSTEM", admin_user_id: adminId });
    expect(logs).toContainEqual({ action: "directory_import_run.failed", actor_source: "SYSTEM", admin_user_id: adminId });
  });
});
