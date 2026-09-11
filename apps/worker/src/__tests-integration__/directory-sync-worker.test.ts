import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  createKysely,
  DirectoryRepository,
  migrateToLatest,
} from "@qianliu/database";
import {
  credentialFingerprint,
  decodeKek,
  encryptCredential,
} from "@qianliu/provider-adapters";
import { runDirectorySyncTick, type DirectorySyncLogRecord } from "../directory/runner.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_directory_worker");
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("directory sync worker", () => {
  it("凭证只在内存解密，通过统一 staging/apply 完成部分成功且重复快照不重复建人", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterprise = await db.insertInto("enterprise").values({ name: "Worker 通讯录企业" })
        .returning("id").executeTakeFirstOrThrow();
      const admin = await db.insertInto("admin_user").values({
        enterprise_id: enterprise.id,
        username: "worker-directory-admin",
        password_hash: "test-only",
      }).returning("id").executeTakeFirstOrThrow();
      const repository = new DirectoryRepository(db);
      const corpSecret = "wecom-secret-canary-never-log";
      const plaintext = JSON.stringify({
        corp_id: "corp-1",
        corp_secret: corpSecret,
        employee_number_attr: "员工编号",
      });
      const kek = randomBytes(32);
      const source = await repository.upsertSource({
        enterpriseId: enterprise.id,
        actorAdminUserId: admin.id,
        type: "WECOM",
        configCiphertext: JSON.stringify(encryptCredential(plaintext, kek)),
        configFingerprint: credentialFingerprint(plaintext),
      });
      const first = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "SYNC",
        idempotencyKey: "worker-sync:first",
        requestHash: "worker-sync-request-first",
        createdByAdminUserId: admin.id,
        directorySourceId: source.id,
      });
      const token = "access-token-canary-never-log";
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cgi-bin/gettoken") {
          expect(url.searchParams.get("corpsecret")).toBe(corpSecret);
          return response({ errcode: 0, access_token: token });
        }
        if (url.pathname === "/cgi-bin/department/list") {
          return response({
            errcode: 0,
            department: [
              { id: 1, parentid: 0, name: "公司" },
              { id: 2, parentid: 1, name: "研发部" },
            ],
          });
        }
        if (url.pathname === "/cgi-bin/user/list") {
          expect(url.searchParams.get("access_token")).toBe(token);
          return response({
            errcode: 0,
            userlist: [
              {
                userid: "wx-1", name: "张三", department: [2], main_department: 2,
                email: "zhangsan@example.test", status: 1,
                extattr: { attrs: [{ name: "员工编号", value: "E-001" }] },
              },
              {
                userid: "wx-2", name: "部门缺失", department: [999], main_department: 999,
                status: 1,
                extattr: { attrs: [{ name: "员工编号", value: "E-002" }] },
              },
            ],
          });
        }
        throw new Error("unexpected request");
      });
      const logs: DirectorySyncLogRecord[] = [];
      const now = new Date("2026-08-13T00:00:00Z");
      const tick = await runDirectorySyncTick({
        db,
        kekBase64: kek.toString("base64"),
        fetch: fetchMock,
        now,
        runId: first.run.id,
        logger: (record) => logs.push(record),
      });
      expect(tick).toMatchObject({
        runsScanned: 1,
        snapshotsPulled: 1,
        partial: 1,
        deferred: 0,
      });
      expect(await repository.getRun(enterprise.id, first.run.id)).toMatchObject({
        status: "PARTIAL",
        created_count: 1,
        failed_count: 1,
      });
      const firstItems = await repository.listRunItems(enterprise.id, first.run.id);
      expect(firstItems.items.map((item) => [item.external_member_id, item.status, item.reason_code])).toEqual([
        ["wx-1", "CREATED", null],
        ["wx-2", "FAILED", "DEPARTMENT_NOT_FOUND"],
      ]);
      const savedSource = await repository.getSourceForWorker(enterprise.id, source.id);
      expect(savedSource).toMatchObject({
        cursor: expect.stringMatching(/^wecom:[0-9a-f]{64}$/u),
        last_error_code: null,
        last_successful_sync_at: now,
      });
      expect(JSON.stringify(logs)).not.toContain(corpSecret);
      expect(JSON.stringify(logs)).not.toContain(token);
      const auditRows = await db.selectFrom("operation_log").select(["change_summary", "failure_reason"])
        .where("enterprise_id", "=", enterprise.id).execute();
      expect(JSON.stringify(auditRows)).not.toContain(corpSecret);
      expect(JSON.stringify(auditRows)).not.toContain(token);

      const second = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "SYNC",
        idempotencyKey: "worker-sync:second",
        requestHash: "worker-sync-request-second",
        createdByAdminUserId: admin.id,
        directorySourceId: source.id,
      });
      const repeat = await runDirectorySyncTick({
        db,
        kekBase64: kek.toString("base64"),
        fetch: fetchMock,
        now: new Date("2026-08-13T01:00:00Z"),
        runId: second.run.id,
        logger: (record) => logs.push(record),
      });
      expect(repeat).toMatchObject({ runsScanned: 1, partial: 1 });
      expect(await repository.getRun(enterprise.id, second.run.id)).toMatchObject({
        status: "PARTIAL",
        matched_count: 1,
        created_count: 0,
        failed_count: 1,
      });
      expect(await db.selectFrom("person").select("id")
        .where("enterprise_id", "=", enterprise.id).execute()).toHaveLength(1);
      // 两层解耦：同步只维护自然人档案，不自动建立使用主体。
      expect(await db.selectFrom("principal").select("id")
        .where("enterprise_id", "=", enterprise.id).execute()).toHaveLength(0);
      expect(await db.selectFrom("organization_membership").select("id")
        .where("enterprise_id", "=", enterprise.id).execute()).toHaveLength(1);
      expect(await db.selectFrom("principal_access_config_state").select("principal_id")
        .where("enterprise_id", "=", enterprise.id).execute()).toHaveLength(0);
      expect(await db.selectFrom("principal_key").select("id")
        .where("enterprise_id", "=", enterprise.id).execute()).toHaveLength(0);
      expect(await db.selectFrom("principal_grant").select("id")
        .where("enterprise_id", "=", enterprise.id).execute()).toHaveLength(0);

      const recovered = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "SYNC",
        idempotencyKey: "worker-sync:recovered-apply",
        requestHash: "worker-sync-request-recovered-apply",
        createdByAdminUserId: admin.id,
        directorySourceId: source.id,
      });
      await repository.stageRun({
        enterpriseId: enterprise.id,
        runId: recovered.run.id,
        sourceSnapshotId: `wecom:${"d".repeat(64)}`,
        items: [{
          rowNumber: 1,
          externalMemberId: "wx-1",
          employeeNumber: "E-001",
          normalizedName: "张三",
          normalizedDepartmentPath: "公司/研发部",
          externalDepartmentId: "2",
        }],
      });
      const callsBeforeRecovery = fetchMock.mock.calls.length;
      const recoveredTick = await runDirectorySyncTick({
        db,
        kekBase64: kek.toString("base64"),
        runId: recovered.run.id,
        now: new Date("2026-08-13T02:00:00Z"),
        fetch: fetchMock,
        logger: (record) => logs.push(record),
      });
      expect(recoveredTick).toMatchObject({
        runsScanned: 1,
        snapshotsPulled: 0,
        applyRunsCompleted: 1,
        succeeded: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRecovery);
      expect(await repository.getSourceForWorker(enterprise.id, source.id)).toMatchObject({
        cursor: `wecom:${"d".repeat(64)}`,
        last_successful_sync_at: new Date("2026-08-13T02:00:00Z"),
      });
    } finally {
      await db.destroy();
    }
  });

  it("厂商可重试错误保留 QUEUED，永久凭证错误结束为 FAILED", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const enterprise = await db.insertInto("enterprise").values({ name: "Worker 错误分类企业" })
        .returning("id").executeTakeFirstOrThrow();
      const admin = await db.insertInto("admin_user").values({
        enterprise_id: enterprise.id,
        username: "worker-error-admin",
        password_hash: "test-only",
      }).returning("id").executeTakeFirstOrThrow();
      const repository = new DirectoryRepository(db);
      const kek = randomBytes(32);
      const plaintext = JSON.stringify({ corp_id: "corp-error", corp_secret: "secret-error-canary" });
      const source = await repository.upsertSource({
        enterpriseId: enterprise.id,
        actorAdminUserId: admin.id,
        type: "WECOM",
        configCiphertext: JSON.stringify(encryptCredential(plaintext, decodeKek(kek.toString("base64")))),
        configFingerprint: credentialFingerprint(plaintext),
      });
      const retryRun = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "SYNC",
        idempotencyKey: "worker-error:retry",
        requestHash: "worker-error-request-retry",
        createdByAdminUserId: admin.id,
        directorySourceId: source.id,
      });
      const retry = await runDirectorySyncTick({
        db,
        kekBase64: kek.toString("base64"),
        runId: retryRun.run.id,
        now: new Date("2026-08-13T02:00:00Z"),
        fetch: vi.fn<typeof fetch>(async () => response({ errcode: 45009 })),
        logger: () => undefined,
      });
      expect(retry).toMatchObject({ deferred: 1, failed: 0 });
      expect(await repository.getRun(enterprise.id, retryRun.run.id)).toMatchObject({
        status: "QUEUED",
        failure_reason_code: "WECOM_RATE_LIMITED",
        next_attempt_at: expect.any(Date),
      });
      expect(await repository.getSourceForWorker(enterprise.id, source.id)).toMatchObject({
        last_error_code: "WECOM_RATE_LIMITED",
      });

      const permanentRun = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "SYNC",
        idempotencyKey: "worker-error:permanent",
        requestHash: "worker-error-request-permanent",
        createdByAdminUserId: admin.id,
        directorySourceId: source.id,
      });
      const permanent = await runDirectorySyncTick({
        db,
        kekBase64: kek.toString("base64"),
        runId: permanentRun.run.id,
        now: new Date("2026-08-13T03:00:00Z"),
        fetch: vi.fn<typeof fetch>(async () => response({ errcode: 40013 })),
        logger: () => undefined,
      });
      expect(permanent).toMatchObject({ failed: 1, deferred: 0 });
      expect(await repository.getRun(enterprise.id, permanentRun.run.id)).toMatchObject({
        status: "FAILED",
        failure_reason_code: "WECOM_CREDENTIAL_INVALID",
      });
    } finally {
      await db.destroy();
    }
  });
});
