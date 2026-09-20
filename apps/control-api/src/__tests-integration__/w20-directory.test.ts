import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createKysely, DirectoryRepository, migrateToLatest } from "@qianliu/database";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/password.js";
import { TEMPLATE_COLUMNS, TEMPLATE_SHEET, TEMPLATE_VERSION } from "../directory/contracts.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let adminCookie: string;
let otherCookie: string;
let wecomSourceId: string;
let feishuSourceId: string;

const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const adminId = randomUUID();
const otherAdminId = randomUUID();
const secretCanary = "directory-secret-canary-W20";

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  expect(response.statusCode, response.body).toBe(200);
  const cookie = response.headers["set-cookie"];
  return (Array.isArray(cookie) ? cookie[0] : cookie)!.split(";")[0]!;
}

async function importWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET);
  sheet.addRow([...TEMPLATE_COLUMNS]);
  sheet.addRow([TEMPLATE_VERSION, "正常员工", "E-100", "总部/研发部", "", "", ""]);
  sheet.addRow([TEMPLATE_VERSION, "缺部门员工", "E-101", "", "", "", ""]);
  sheet.addRow([TEMPLATE_VERSION, "重复员工甲", "E-200", "总部/销售部", "", "", ""]);
  sheet.addRow([TEMPLATE_VERSION, "重复员工乙", "e-200", "总部/销售部", "", "", ""]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function multipart(bytes: Buffer, filename = "directory.xlsx") {
  const boundary = `qianliu-${randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n",
  );
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([prefix, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  };
}

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_w20_directory_api");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  // 登录按 created_at,id 取第一个企业；显式错开时间戳，避免同事务随机 UUID 字典序
  // 决定登录落在本企业还是隔离企业（曾导致 50% 概率的 invalid_credentials）。
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "W20 通讯录企业", created_at: new Date("2026-09-01T00:00:00.000Z") },
    { id: otherEnterpriseId, name: "W20 通讯录隔离企业", created_at: new Date("2026-09-02T00:00:00.000Z") },
  ]).execute();
  await db.insertInto("admin_user").values([
    {
      id: adminId, enterprise_id: enterpriseId, username: "w20-directory-admin",
      password_hash: await hashPassword("W20-Directory-Password!"), status: "ACTIVE",
    },
    {
      id: otherAdminId, enterprise_id: otherEnterpriseId, username: "w20-directory-other",
      password_hash: await hashPassword("W20-Directory-Other!"), status: "ACTIVE",
    },
  ]).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  adminCookie = await login("w20-directory-admin", "W20-Directory-Password!");
  // 1.0 登录页按单企业部署查询第一个企业；跨企业负向用会话底层直接构造。
  const otherToken = generateSessionToken();
  await app.adminRepo.createSession(
    otherAdminId, digestSessionToken(otherToken), new Date(Date.now() + 60 * 60_000),
  );
  otherCookie = `${SESSION_COOKIE_NAME}=${otherToken}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("W20-02 通讯录来源与导入 Control API", () => {
  it("Secret 只存密文且不回显，同步 Run 按企业、管理员和幂等键约束", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/directory-sources/WECOM" });
    expect(unauthorized.statusCode).toBe(401);

    const saved = await app.inject({
      method: "PUT", url: "/directory-sources/WECOM", headers: { cookie: adminCookie },
      payload: {
        expected_version: 0,
        status: "ACTIVE",
        config: { corp_id: "corp-w20", corp_secret: secretCanary },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(secretCanary);
    expect(saved.body).not.toContain("config_ciphertext");
    expect(saved.json().source).toMatchObject({ type: "WECOM", configured: true, version: 1 });
    wecomSourceId = saved.json().source.id;

    const stored = await db.selectFrom("directory_source").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("id", "=", wecomSourceId).executeTakeFirstOrThrow();
    expect(stored.config_ciphertext).not.toContain(secretCanary);
    expect(stored.config_fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    const safeRead = await app.inject({
      method: "GET", url: "/directory-sources/WECOM", headers: { cookie: adminCookie },
    });
    expect(safeRead.statusCode).toBe(200);
    expect(safeRead.body).not.toContain(secretCanary);
    expect(safeRead.body).not.toContain("config_ciphertext");

    const otherTenantRead = await app.inject({
      method: "GET", url: "/directory-sources/WECOM", headers: { cookie: otherCookie },
    });
    expect(otherTenantRead.json()).toEqual({ source: null });
    const otherTenantSync = await app.inject({
      method: "POST", url: "/directory-sync-runs", headers: { cookie: otherCookie },
      payload: { source_id: wecomSourceId, idempotency_key: "sync-cross-tenant-001" },
    });
    expect(otherTenantSync.statusCode).toBe(404);

    const feishu = await app.inject({
      method: "PUT", url: "/directory-sources/FEISHU", headers: { cookie: adminCookie },
      payload: {
        expected_version: 0,
        status: "ACTIVE",
        config: { app_id: "app-w20", app_secret: "feishu-secret-canary-W20" },
      },
    });
    expect(feishu.statusCode).toBe(200);
    feishuSourceId = feishu.json().source.id;

    const first = await app.inject({
      method: "POST", url: "/directory-sync-runs", headers: { cookie: adminCookie },
      payload: { source_id: wecomSourceId, idempotency_key: "sync-idempotency-001" },
    });
    const replay = await app.inject({
      method: "POST", url: "/directory-sync-runs", headers: { cookie: adminCookie },
      payload: { source_id: wecomSourceId, idempotency_key: "sync-idempotency-001" },
    });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ runId: first.json().runId, replayed: true });
    const conflict = await app.inject({
      method: "POST", url: "/directory-sync-runs", headers: { cookie: adminCookie },
      payload: { source_id: feishuSourceId, idempotency_key: "sync-idempotency-001" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(await db.selectFrom("directory_import_run").select("created_by_admin_user_id")
      .where("id", "=", first.json().runId).executeTakeFirstOrThrow())
      .toEqual({ created_by_admin_user_id: adminId });

    const logs = await db.selectFrom("operation_log").select(["change_summary", "failure_reason"])
      .where("enterprise_id", "=", enterpriseId).execute();
    expect(JSON.stringify(logs)).not.toContain(secretCanary);
    expect(JSON.stringify(logs)).not.toContain("feishu-secret-canary-W20");
  });

  it("Excel 同文件重放返回原 Run，重复／错误行可见，正常行继续建主体且不改 Key/Grant", async () => {
    const bytes = await importWorkbook();
    const macroName = multipart(bytes, "directory.xlsm");
    const rejectedMacroName = await app.inject({
      method: "POST", url: "/directory-excel-imports", headers: { cookie: adminCookie, ...macroName.headers },
      payload: macroName.payload,
    });
    expect(rejectedMacroName.statusCode).toBe(400);
    expect(rejectedMacroName.json()).toEqual({ error: "invalid_file_type" });

    const oversized = multipart(Buffer.alloc(5 * 1024 * 1024 + 1));
    const rejectedOversized = await app.inject({
      method: "POST", url: "/directory-excel-imports", headers: { cookie: adminCookie, ...oversized.headers },
      payload: oversized.payload,
    });
    expect(rejectedOversized.statusCode).toBe(413);
    expect(rejectedOversized.json()).toMatchObject({ error: "FILE_TOO_LARGE" });

    const request = multipart(bytes);
    const first = await app.inject({
      method: "POST", url: "/directory-excel-imports", headers: { cookie: adminCookie, ...request.headers },
      payload: request.payload,
    });
    const replayRequest = multipart(bytes);
    const replay = await app.inject({
      method: "POST", url: "/directory-excel-imports", headers: { cookie: adminCookie, ...replayRequest.headers },
      payload: replayRequest.payload,
    });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ runId: first.json().runId, replayed: true });
    const runId = first.json().runId as string;
    expect(await db.selectFrom("directory_import_run").select(["created_by_admin_user_id", "total_count"])
      .where("id", "=", runId).executeTakeFirstOrThrow())
      .toEqual({ created_by_admin_user_id: adminId, total_count: 4 });

    const staged = await db.selectFrom("directory_import_item").select(["row_number", "status", "reason_code"])
      .where("enterprise_id", "=", enterpriseId).where("run_id", "=", runId).orderBy("row_number").execute();
    expect(staged).toEqual([
      { row_number: 2, status: "STAGED", reason_code: null },
      { row_number: 3, status: "FAILED", reason_code: "REQUIRED_FIELD" },
      { row_number: 4, status: "FAILED", reason_code: "DUPLICATE_EMPLOYEE_NUMBER" },
      { row_number: 5, status: "FAILED", reason_code: "DUPLICATE_EMPLOYEE_NUMBER" },
    ]);

    const repository = new DirectoryRepository(db);
    await expect(repository.applyRun(enterpriseId, runId)).resolves.toMatchObject({
      status: "PARTIAL", created_count: 1, failed_count: 3,
    });
    const run = await app.inject({
      method: "GET", url: `/directory-import-runs/${runId}`, headers: { cookie: adminCookie },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().run).toMatchObject({ source_type: "EXCEL", status: "PARTIAL", total_count: 4, success_count: 1, failed_count: 3 });
    const items = await app.inject({
      method: "GET", url: `/directory-import-runs/${runId}/items?limit=10`, headers: { cookie: adminCookie },
    });
    expect(items.statusCode).toBe(200);
    expect(items.json().items.map((item: { row_number: number; status: string; reason_code: string | null }) => [item.row_number, item.status, item.reason_code]))
      .toEqual([
        [2, "CREATED", null],
        [3, "FAILED", "REQUIRED_FIELD"],
        [4, "FAILED", "DUPLICATE_EMPLOYEE_NUMBER"],
        [5, "FAILED", "DUPLICATE_EMPLOYEE_NUMBER"],
      ]);
    expect((await app.inject({
      method: "GET", url: `/directory-import-runs/${runId}`, headers: { cookie: otherCookie },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET", url: `/directory-import-runs/${runId}/items`, headers: { cookie: otherCookie },
    })).statusCode).toBe(404);

    const person = await db.selectFrom("person").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("employee_number", "=", "E-100").executeTakeFirstOrThrow();
    // 两层解耦：导入完成只有自然人候选档案，还没有任何使用主体。
    expect(await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).where("person_id", "=", person.id).execute()).toHaveLength(0);
    // A 方式：通讯录列表勾选批量开通。
    const activation = await app.inject({
      method: "POST", url: "/directory-members/activate", headers: { cookie: adminCookie },
      payload: { person_ids: [person.id] },
    });
    expect(activation.statusCode, activation.body).toBe(200);
    expect(activation.json()).toMatchObject({ activated_count: 1, already_active_count: 0 });
    const principalId = activation.json().items[0].principal_id as string;
    expect(activation.json().items[0]).toMatchObject({ person_id: person.id, status: "ACTIVATED" });
    expect(await db.selectFrom("principal_access_config_state").select("principal_id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId).executeTakeFirstOrThrow())
      .toEqual({ principal_id: principalId });
    expect(await db.selectFrom("principal_key").select("id").where("principal_id", "=", principalId).execute()).toHaveLength(0);
    expect(await db.selectFrom("principal_grant").select("id").where("principal_id", "=", principalId).execute()).toHaveLength(0);
    // 重复开通幂等：只为未开通者建主体，已开通者安全跳过。
    const repeatActivation = await app.inject({
      method: "POST", url: "/directory-members/activate", headers: { cookie: adminCookie },
      payload: { person_ids: [person.id] },
    });
    expect(repeatActivation.statusCode).toBe(200);
    expect(repeatActivation.json()).toMatchObject({ activated_count: 0, already_active_count: 1 });
    expect(await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).where("person_id", "=", person.id).execute()).toHaveLength(1);

    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId,
      key_prefix: "ql_w20_directory", key_digest: randomUUID(), status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_grant").values({
      enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
      model_alias: "qianliu-deepseek", quota_value: 1_000n, status: "ACTIVE",
    }).execute();
    const secondWorkbook = new ExcelJS.Workbook();
    const secondSheet = secondWorkbook.addWorksheet(TEMPLATE_SHEET);
    secondSheet.addRow([...TEMPLATE_COLUMNS]);
    secondSheet.addRow([TEMPLATE_VERSION, "正常员工", "e-100", "总部/研发部", "employee@example.test", "", ""]);
    // 同名但稳定员工编号不同：必须作为增量新人，不得按姓名猜测合并。
    secondSheet.addRow([TEMPLATE_VERSION, "正常员工", "E-300", "总部/研发部", "", "", ""]);
    const secondBytes = Buffer.from(await secondWorkbook.xlsx.writeBuffer());
    const secondRequest = multipart(secondBytes);
    const second = await app.inject({
      method: "POST", url: "/directory-excel-imports", headers: { cookie: adminCookie, ...secondRequest.headers },
      payload: secondRequest.payload,
    });
    expect(second.statusCode).toBe(202);
    await expect(repository.applyRun(enterpriseId, second.json().runId)).resolves.toMatchObject({
      status: "SUCCEEDED", updated_count: 1, created_count: 1,
    });
    expect(await db.selectFrom("person").select("id").where("enterprise_id", "=", enterpriseId).execute()).toHaveLength(2);
    expect(await db.selectFrom("principal").select("id").where("enterprise_id", "=", enterpriseId).execute()).toHaveLength(1);
    expect(await db.selectFrom("principal_key").select(["key_prefix", "status"]).where("principal_id", "=", principalId).execute())
      .toEqual([{ key_prefix: "ql_w20_directory", status: "ACTIVE" }]);
    expect(await db.selectFrom("principal_grant").select(["provider", "status"]).where("principal_id", "=", principalId).execute())
      .toEqual([{ provider: "deepseek", status: "ACTIVE" }]);

    await db.insertInto("person_external_identity").values([
      {
        enterprise_id: enterpriseId, person_id: person.id, directory_source_id: wecomSourceId,
        provider: "WECOM", provider_user_id: "wx-e100", status: "ACTIVE",
        updated_at: new Date("2026-08-13T00:00:00.000Z"),
      },
      {
        enterprise_id: enterpriseId, person_id: person.id, directory_source_id: feishuSourceId,
        provider: "FEISHU", provider_user_id: "fs-e100", status: "ACTIVE",
        updated_at: new Date("2026-08-13T01:00:00.000Z"),
      },
    ]).execute();
    const members = await app.inject({ method: "GET", url: "/directory-members", headers: { cookie: adminCookie } });
    expect(members.statusCode).toBe(200);
    expect(members.json().total).toBe(2);
    expect(members.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      employee_number: "E-100", principal_id: principalId,
      source_type: "FEISHU", external_member_id: "fs-e100",
    })]));
    const isolatedMembers = await app.inject({ method: "GET", url: "/directory-members", headers: { cookie: otherCookie } });
    expect(isolatedMembers.json()).toMatchObject({ total: 0, items: [] });

    const inactiveRun = await repository.createRun({
      enterpriseId,
      mode: "SYNC",
      idempotencyKey: "sync-source-inactive-001",
      requestHash: "sync-source-inactive-request-001",
      createdByAdminUserId: adminId,
      directorySourceId: wecomSourceId,
    });
    await repository.stageRun({ enterpriseId, runId: inactiveRun.run.id, items: [] });
    await expect(repository.applyRun(enterpriseId, inactiveRun.run.id)).resolves.toMatchObject({
      status: "SUCCEEDED", skipped_count: 1,
    });
    expect((await repository.listRunItems(enterpriseId, inactiveRun.run.id)).items).toEqual([
      expect.objectContaining({
        external_member_id: "wx-e100", status: "SKIPPED", reason_code: "SOURCE_INACTIVE",
        person_id: person.id, principal_id: principalId,
      }),
    ]);
    expect(await db.selectFrom("principal_key").select("status").where("principal_id", "=", principalId).execute())
      .toEqual([{ status: "ACTIVE" }]);
    expect(await db.selectFrom("principal_grant").select("status").where("principal_id", "=", principalId).execute())
      .toEqual([{ status: "ACTIVE" }]);
  });

  it("显式 Principal 只能绑定本企业员工主体，同名不猜测合并且冲突行不阻断其他行", async () => {
    const manualPrincipal = await db.insertInto("principal").values({
      enterprise_id: enterpriseId, type: "EMPLOYEE", name: "同名员工", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    const foreignPrincipal = await db.insertInto("principal").values({
      enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "跨企业主体", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: manualPrincipal.id,
      key_prefix: "ql_manual_before_import", key_digest: randomUUID(), status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_grant").values({
      enterprise_id: enterpriseId, principal_id: manualPrincipal.id, provider: "deepseek",
      model_alias: "qianliu-deepseek", quota_value: 2_000n, status: "ACTIVE",
    }).execute();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(TEMPLATE_SHEET);
    sheet.addRow([...TEMPLATE_COLUMNS]);
    sheet.addRow([TEMPLATE_VERSION, "同名员工", "EX-1", "总部/平台组", "", "", manualPrincipal.id]);
    sheet.addRow([TEMPLATE_VERSION, "跨企业冲突", "EX-2", "总部/平台组", "", "", foreignPrincipal.id]);
    sheet.addRow([TEMPLATE_VERSION, "同名员工", "EX-3", "总部/平台组", "", "", ""]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const request = multipart(bytes);
    const uploaded = await app.inject({
      method: "POST", url: "/directory-excel-imports", headers: { cookie: adminCookie, ...request.headers },
      payload: request.payload,
    });
    expect(uploaded.statusCode).toBe(202);
    const repository = new DirectoryRepository(db);
    await expect(repository.applyRun(enterpriseId, uploaded.json().runId)).resolves.toMatchObject({
      status: "PARTIAL", created_count: 2, conflict_count: 1,
    });
    expect((await repository.listRunItems(enterpriseId, uploaded.json().runId)).items
      .map((item) => [item.row_number, item.status, item.reason_code])).toEqual([
      [2, "CREATED", null],
      [3, "CONFLICT", "EXPLICIT_PRINCIPAL_INVALID"],
      [4, "CREATED", null],
    ]);
    const conflictAudit = await db.selectFrom("operation_log").select(["action", "failure_reason", "change_summary"])
      .where("enterprise_id", "=", enterpriseId)
      .where("action", "=", "directory_import_item.conflict")
      .where("failure_reason", "=", "EXPLICIT_PRINCIPAL_INVALID").execute();
    expect(conflictAudit).toHaveLength(1);
    expect(JSON.stringify(conflictAudit)).not.toContain(foreignPrincipal.id);

    const rebound = await db.selectFrom("principal").select(["id", "person_id"])
      .where("enterprise_id", "=", enterpriseId).where("id", "=", manualPrincipal.id).executeTakeFirstOrThrow();
    expect(rebound.person_id).not.toBeNull();
    expect(await db.selectFrom("person").select("id")
      .where("enterprise_id", "=", enterpriseId).where("name", "=", "同名员工").execute()).toHaveLength(2);
    expect(await db.selectFrom("principal_key").select(["key_prefix", "status"])
      .where("principal_id", "=", manualPrincipal.id).execute())
      .toEqual([{ key_prefix: "ql_manual_before_import", status: "ACTIVE" }]);
    expect(await db.selectFrom("principal_grant").select(["quota_value", "status"])
      .where("principal_id", "=", manualPrincipal.id).execute())
      .toEqual([{ quota_value: "2000", status: "ACTIVE" }]);
    expect(await db.selectFrom("principal_access_config_state").select("principal_id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", manualPrincipal.id).executeTakeFirstOrThrow())
      .toEqual({ principal_id: manualPrincipal.id });
  });

  it("A/C/B 方式开通：名单匹配、未匹配反馈、跨企业与重复绑定防护", async () => {
    const repository = new DirectoryRepository(db);
    const e300 = await db.selectFrom("person").select("id")
      .where("enterprise_id", "=", enterpriseId).where("employee_number", "=", "E-300").executeTakeFirstOrThrow();
    const unauthorized = await app.inject({
      method: "POST", url: "/directory-members/activate", payload: { person_ids: [e300.id] },
    });
    expect(unauthorized.statusCode).toBe(401);

    // C 方式：按名单（工号）匹配开通，未匹配条目原样返回（Scenario 4.1/4.2）。
    const list = await app.inject({
      method: "POST", url: "/directory-members/activate-by-list", headers: { cookie: adminCookie },
      payload: { identifiers: ["EX-3", " e-300 ", "NO-SUCH-ID", ""] },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ activated_count: 2, already_active_count: 0, not_found: ["NO-SUCH-ID"] });
    expect(await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).where("person_id", "=", e300.id).execute()).toHaveLength(1);

    // A 方式跨租户：其他企业管理员不能开通本企业人员。
    const crossTenant = await app.inject({
      method: "POST", url: "/directory-members/activate", headers: { cookie: otherCookie },
      payload: { person_ids: [e300.id] },
    });
    expect(crossTenant.statusCode).toBe(404);
    const crossTenantList = await app.inject({
      method: "POST", url: "/directory-members/activate-by-list", headers: { cookie: otherCookie },
      payload: { identifiers: ["E-300"] },
    });
    expect(crossTenantList.statusCode).toBe(200);
    expect(crossTenantList.json()).toMatchObject({ activated_count: 0, not_found: ["E-300"] });
    expect(await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).where("person_id", "=", e300.id).execute()).toHaveLength(1);

    // 参数校验：空数组和非法 UUID 拒绝。
    expect((await app.inject({
      method: "POST", url: "/directory-members/activate", headers: { cookie: adminCookie },
      payload: { person_ids: [] },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: "/directory-members/activate", headers: { cookie: adminCookie },
      payload: { person_ids: ["not-a-uuid"] },
    })).statusCode).toBe(400);

    // B 方式：POST /principals 绑定自然人；已开通人员返回 409，跨企业人员 404。
    const conflict = await app.inject({
      method: "POST", url: "/principals", headers: { cookie: adminCookie },
      payload: { type: "EMPLOYEE", name: "正常员工", department_label: "研发部", person_id: e300.id },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "person_already_active" });
    const otherTenantPerson = await db.insertInto("person").values({
      enterprise_id: otherEnterpriseId, name: "外企业人员",
    }).returning("id").executeTakeFirstOrThrow();
    const foreign = await app.inject({
      method: "POST", url: "/principals", headers: { cookie: adminCookie },
      payload: { type: "EMPLOYEE", name: "外企业人员", person_id: otherTenantPerson.id },
    });
    expect(foreign.statusCode).toBe(404);
    expect((await app.inject({
      method: "POST", url: "/principals", headers: { cookie: adminCookie },
      payload: { type: "PROJECT", name: "项目主体", person_id: e300.id },
    })).statusCode).toBe(400);

    const fresh = await db.insertInto("person").values({
      enterprise_id: enterpriseId, employee_number: "B-NEW-1", name: "B方式新员工",
    }).returning("id").executeTakeFirstOrThrow();
    const created = await app.inject({
      method: "POST", url: "/principals", headers: { cookie: adminCookie },
      payload: { type: "EMPLOYEE", name: "B方式新员工", department_label: "技术部", person_id: fresh.id },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().principal).toMatchObject({ type: "EMPLOYEE", person_id: fresh.id, status: "ACTIVE" });
    const audits = await db.selectFrom("operation_log").select(["action", "change_summary"])
      .where("enterprise_id", "=", enterpriseId).where("target_id", "=", created.json().principal.id).execute();
    expect(JSON.stringify(audits)).toContain("person_id");
    expect(await db.selectFrom("principal_access_config_state").select("principal_id")
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", created.json().principal.id).execute()).toHaveLength(1);

    // C 方式名单预览：首行常见表头（工号）被识别跳过，只返回数据行标识。
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("名单");
    sheet.addRow(["工号"]);
    sheet.addRow(["B-NEW-1"]);
    sheet.addRow(["EX-3"]);
    sheet.addRow([""]);
    sheet.addRow(["NO-SUCH-ID"]);
    const previewRequest = multipart(Buffer.from(await workbook.xlsx.writeBuffer()), "activation-list.xlsx");
    const preview = await app.inject({
      method: "POST", url: "/directory-members/activate-list-preview",
      headers: { cookie: adminCookie, ...previewRequest.headers }, payload: previewRequest.payload,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({ identifiers: ["B-NEW-1", "EX-3", "NO-SUCH-ID"] });
    // 无表头纯数据文件不误跳首行。
    const plainWorkbook = new ExcelJS.Workbook();
    const plainSheet = plainWorkbook.addWorksheet("名单");
    plainSheet.addRow(["EX-3"]);
    plainSheet.addRow(["NO-SUCH-ID"]);
    const plainRequest = multipart(Buffer.from(await plainWorkbook.xlsx.writeBuffer()), "activation-list-plain.xlsx");
    const plainPreview = await app.inject({
      method: "POST", url: "/directory-members/activate-list-preview",
      headers: { cookie: adminCookie, ...plainRequest.headers }, payload: plainRequest.payload,
    });
    expect(plainPreview.statusCode, plainPreview.body).toBe(200);
    expect(plainPreview.json()).toEqual({ identifiers: ["EX-3", "NO-SUCH-ID"] });
    const rejectedPreview = await app.inject({
      method: "POST", url: "/directory-members/activate-list-preview",
      headers: { cookie: adminCookie }, payload: {},
    });
    // 非 multipart 请求由 @fastify/multipart 直接拒绝（406），不进入业务逻辑。
    expect(rejectedPreview.statusCode).toBe(406);

    // Scenario 4.1/4.2 闭环：预览结果原样提交开通，not_found 只含真实缺失标识。
    const listByPreview = await app.inject({
      method: "POST", url: "/directory-members/activate-by-list", headers: { cookie: adminCookie },
      payload: { identifiers: preview.json().identifiers },
    });
    expect(listByPreview.statusCode, listByPreview.body).toBe(200);
    expect(listByPreview.json()).toMatchObject({
      activated_count: 0, already_active_count: 2, not_found: ["NO-SUCH-ID"],
    });

    // 名单开通幂等：重复执行只返回已开通数量。
    const replayList = await app.inject({
      method: "POST", url: "/directory-members/activate-by-list", headers: { cookie: adminCookie },
      payload: { identifiers: ["EX-3"] },
    });
    expect(replayList.json()).toMatchObject({ activated_count: 0, already_active_count: 1, not_found: [] });
    expect((await repository.listMembers(enterpriseId)).total).toBe(5);
  });

  it("1,000 行标准 Excel 经真实上传、解析与 apply 全链在冻结时限内完成", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(TEMPLATE_SHEET);
    sheet.addRow([...TEMPLATE_COLUMNS]);
    for (let index = 1; index <= 1_000; index += 1) {
      const suffix = String(index).padStart(4, "0");
      sheet.addRow([
        TEMPLATE_VERSION,
        `容量员工-${suffix}`,
        `CAPACITY-${suffix}`,
        "总部/容量测试部",
        "",
        "",
        "",
      ]);
    }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const request = multipart(bytes, "directory-capacity-1000.xlsx");
    const principalsBeforeImport = await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).execute();
    const startedAt = performance.now();
    const uploaded = await app.inject({
      method: "POST",
      url: "/directory-excel-imports",
      headers: { cookie: adminCookie, ...request.headers },
      payload: request.payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(202);
    const runId = uploaded.json().runId as string;
    const completed = await new DirectoryRepository(db).applyRun(enterpriseId, runId);
    const elapsedMs = performance.now() - startedAt;
    expect(completed).toMatchObject({
      status: "SUCCEEDED",
      total_count: 1_000,
      created_count: 1_000,
      failed_count: 0,
      conflict_count: 0,
    });
    // Scenario 1.1：1,000 行导入只入候选库，主体表零新增。
    expect(await db.selectFrom("person").select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("employee_number", "like", "CAPACITY-%").execute()).toHaveLength(1_000);
    expect(await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).execute()).toHaveLength(principalsBeforeImport.length);
    expect(elapsedMs).toBeLessThanOrEqual(10 * 60_000);

    const firstPage = await app.inject({
      method: "GET",
      url: `/directory-import-runs/${runId}/items?limit=100&offset=0`,
      headers: { cookie: adminCookie },
    });
    const secondPage = await app.inject({
      method: "GET",
      url: `/directory-import-runs/${runId}/items?limit=100&offset=900`,
      headers: { cookie: adminCookie },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(secondPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({ total: 1_000, limit: 100, offset: 0 });
    expect(secondPage.json()).toMatchObject({ total: 1_000, limit: 100, offset: 900 });
    expect(firstPage.json().items).toHaveLength(100);
    expect(secondPage.json().items).toHaveLength(100);
  }, 660_000);
});
