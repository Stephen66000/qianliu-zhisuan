import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookie: string;

const enterpriseId = randomUUID();
const adminId = randomUUID();
const employeeId = randomUUID();
const projectId = randomUUID();
const keyId = randomUUID();
const password = "Pool025-Admin-Test!";
const occurredAt = new Date("2026-08-02T04:00:00.000Z");

async function addUsage(input: {
  resourceId: string;
  mode: "API" | "CODING_PLAN";
  input: number;
  output: number;
  deducted: number | null;
  cost: string | null;
}) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: employeeId,
    principal_key_id: keyId, protocol: "openai", unified_model: "pool-025-model",
    status: "SUCCEEDED", started_at: occurredAt, finished_at: new Date(occurredAt.getTime() + 500),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
    provider_resource_id: input.resourceId, upstream_model: "upstream-model",
    finished_at: new Date(occurredAt.getTime() + 500), http_status: 200, response_committed: true,
  }).returningAll().executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: input.resourceId, input_tokens: BigInt(input.input),
    output_tokens: BigInt(input.output), cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: `pool025-${requestId}`,
  }).returningAll().executeTakeFirstOrThrow();
  const line = await db.insertInto("ledger_line").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: input.resourceId,
    principal_id: employeeId, resource_mode: input.mode, raw_input_tokens: BigInt(input.input),
    raw_output_tokens: BigInt(input.output), raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    deducted_quota: input.deducted === null ? null : BigInt(input.deducted),
    api_cost: input.cost, usage_quality: "PROVIDER_REPORTED",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId,
    enterprise_id: enterpriseId,
    principal_id: employeeId,
    total_input_tokens: BigInt(input.input),
    total_output_tokens: BigInt(input.output),
    total_cache_tokens: 0n,
    total_reasoning_tokens: 0n,
    total_deducted_quota: BigInt(input.deducted ?? 0),
    total_api_cost: input.mode === "API" ? (input.cost ?? "0") : "0",
    usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1,
    status: "SETTLED",
  }).execute();
  return line;
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-025 企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "owner", display_name: "经营管理员",
    password_hash: await hashPassword(password), status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工甲",
    department_label: "研发", person_id: null, owner_person_id: null,
  }).execute();
  await db.insertInto("principal").values({
    id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "客户交付项目",
    department_label: null, person_id: null, owner_person_id: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: employeeId,
    key_prefix: "ql_pool025", key_digest: randomUUID(), allowed_model_ids: [],
    ip_allowlist: null, expires_at: null, quota_limit: null, concurrency_limit: null,
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "pool025", name: "经营测试厂商", adapter_type: "openai",
  }).returningAll().executeTakeFirstOrThrow();
  const api = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "API 主账号", mode: "API",
    credential_type: "API_KEY", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const plan = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "Coding Plan", mode: "CODING_PLAN",
    credential_type: "API_KEY", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("provider_resource_operating_snapshot").values([
    {
      enterprise_id: enterpriseId, provider_resource_id: api.id, version: 1, source: "ADMIN",
      collected_at: occurredAt, currency: "CNY", current_balance: "87.66",
    },
    {
      enterprise_id: enterpriseId, provider_resource_id: plan.id, version: 1, source: "ADMIN",
      collected_at: occurredAt, currency: "CNY", package_cost: "300", total_quota: "10000",
      used_quota: "5000", remaining_quota: "5000", quota_unit: "TOKEN",
      effective_from: new Date("2026-08-01T00:00:00+08:00"), effective_until: new Date("2026-09-01T00:00:00+08:00"),
    },
  ]).execute();
  await addUsage({ resourceId: api.id, mode: "API", input: 100, output: 20, deducted: null, cost: "12.34" });
  await addUsage({ resourceId: plan.id, mode: "CODING_PLAN", input: 200, output: 30, deducted: 5000, cost: "999.99" });
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "owner", password } });
  const setCookie = login.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("POOL-025 企业 AI 算力月度经营账单", () => {
  it("POOL20-026 先列资源事实并逐项确认，确认不改写原始快照和账本", async () => {
    const resources = await db.selectFrom("provider_resource").select(["id", "mode"]).where("enterprise_id", "=", enterpriseId).execute();
    const apiResource = resources.find((row) => row.mode === "API")!;
    await db.insertInto("resource_purchase_record").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResource.id,
      purchase_type: "API_RECHARGE", description: "9 月充值", amount: "50", currency: "CNY",
      purchased_at: new Date("2026-09-03T02:00:00Z"), source: "ADMIN", created_by: adminId,
    }).execute();
    const beforeSnapshots = await db.selectFrom("provider_resource_operating_snapshot")
      .select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const draft = await app.inject({ method: "GET", url: "/operating-bills/2026-09", headers: { cookie } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().providers.find((row: { providerResourceId: string }) => row.providerResourceId === apiResource.id))
      .toMatchObject({
        purchases: [{ type: "API_RECHARGE", amount: "50.00000000", currency: "CNY", source: "ADMIN" }],
        apiCost: "0.00000000", confirmation: { status: "PENDING", matchesCurrentFacts: false },
      });
    for (const resource of resources) {
      const confirmed = await app.inject({
        method: "PUT", url: `/operating-bills/2026-09/resource-confirmations/${resource.id}`,
        headers: { cookie }, payload: { status: "CONFIRMED", note: "负责人已核对" },
      });
      expect(confirmed.statusCode).toBe(200);
    }
    const after = await app.inject({ method: "GET", url: "/operating-bills/2026-09", headers: { cookie } });
    expect(after.json().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ confirmation: expect.objectContaining({ status: "CONFIRMED", confirmedBy: "经营管理员", matchesCurrentFacts: true }) }),
    ]));
    const afterSnapshots = await db.selectFrom("provider_resource_operating_snapshot")
      .select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    expect(afterSnapshots.count).toBe(beforeSnapshots.count);
  });

  it("按自然月汇总真实成本、确认价值并冻结不可变版本", async () => {
    const draft = await app.inject({ method: "GET", url: "/operating-bills/2026-08", headers: { cookie } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT", version: 0,
      summary: {
        apiCost: "12.34000000", packageCost: "300.00000000", totalCost: "312.34000000",
        endingBalance: "87.66000000", unallocatedCost: "0.00000000", activePrincipalCount: 1,
      },
      gaps: [],
    });
    expect(draft.json().sourceFacts.ledgerLines).toHaveLength(2);
    const apiResource = await db.selectFrom("provider_resource").select("id")
      .where("enterprise_id", "=", enterpriseId).where("mode", "=", "API").executeTakeFirstOrThrow();
    const imported = await app.inject({
      method: "POST", url: "/operating-bill-snapshot-imports", headers: { cookie },
      payload: { rows: [{ provider_resource_id: apiResource.id, snapshot: { collected_at: "2026-08-03T04:00:00.000Z", currency: "CNY", current_balance: "87.66", current_period_cost: "12.34", cost_period_start: "2026-07-31T16:00:00.000Z", cost_period_end: "2026-08-31T16:00:00.000Z" } }] },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ imported_count: 1, snapshots: [{ source: "BILL_RECONCILIATION" }] });
    expect(draft.json().subjects[0]).toMatchObject({
      principalName: "员工甲", totalTokens: "350", apiCost: "12.34000000",
      packageAllocatedCost: "300.00000000", totalAllocatedCost: "312.34000000",
      activeDays: 1, requestCount: 2,
    });
    expect(draft.json().subjects.some((row: { principalName: string }) => row.principalName === "未归属项目")).toBe(true);

    const apiRequest = await db.selectFrom("ledger_line").select("ai_request_id").where("resource_mode", "=", "API").executeTakeFirstOrThrow();
    const assigned = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/project-assignments", headers: { cookie },
      payload: { ai_request_id: apiRequest.ai_request_id, project_principal_id: projectId, reason: "客户项目请求" },
    });
    expect(assigned.statusCode).toBe(204);
    const assignedDraft = await app.inject({ method: "GET", url: "/operating-bills/2026-08", headers: { cookie } });
    expect(assignedDraft.json().subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalName: "客户交付项目", principalType: "PROJECT", apiCost: "12.34000000" }),
      expect.objectContaining({ principalName: "未归属项目", principalType: "PROJECT", packageAllocatedCost: "300.00000000" }),
    ]));

    const created = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/value-items", headers: { cookie },
      payload: { title: "交付周期缩短", value_type: "NON_MONETARY", metric_value: "5 天→2 天", metric_unit: "周期", evidence_ref: "验收单-025" },
    });
    expect(created.statusCode).toBe(201);
    const itemId = created.json().item.id as string;
    const confirmed = await app.inject({ method: "POST", url: `/operating-bill-value-items/${itemId}/confirm`, headers: { cookie } });
    expect(confirmed.statusCode).toBe(200);

    const closed = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/close", headers: { cookie },
      payload: { allow_incomplete: false, note: "8 月经营账确认" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "CLOSED", version: 1, summary: { totalCost: "312.34000000", confirmedNonMonetaryCount: 1 } });
    const closedAssignment = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/project-assignments", headers: { cookie },
      payload: { ai_request_id: apiRequest.ai_request_id, project_principal_id: projectId },
    });
    expect(closedAssignment.statusCode).toBe(409);

    const apiLine = await db.selectFrom("ledger_line").select("id").where("resource_mode", "=", "API").executeTakeFirstOrThrow();
    await db.updateTable("ledger_line").set({ api_cost: "99.99" }).where("id", "=", apiLine.id).execute();
    await db.updateTable("ledger_transaction").set({ total_api_cost: "99.99" })
      .where("ai_request_id", "=", apiRequest.ai_request_id).execute();
    const frozen = await app.inject({ method: "GET", url: "/operating-bills/2026-08", headers: { cookie } });
    expect(frozen.json().summary.totalCost).toBe("312.34000000");

    const reopen = await app.inject({ method: "POST", url: "/operating-bills/2026-08/reopen", headers: { cookie }, payload: { reason: "对账修正" } });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json()).toMatchObject({ status: "DRAFT", version: 1, summary: { totalCost: "399.99000000" } });
    const reclose = await app.inject({ method: "POST", url: "/operating-bills/2026-08/close", headers: { cookie }, payload: { allow_incomplete: false, note: "修正后结账" } });
    expect(reclose.statusCode).toBe(200);
    expect(reclose.json()).toMatchObject({ status: "CLOSED", version: 2, summary: { totalCost: "399.99000000" } });
    expect(reclose.json().versions).toHaveLength(2);

    await app.inject({ method: "POST", url: "/operating-bills/2026-08/reopen", headers: { cookie }, payload: { reason: "并发验收" } });
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: "/operating-bills/2026-08/close", headers: { cookie }, payload: { allow_incomplete: false, note: "并发 A" } }),
      app.inject({ method: "POST", url: "/operating-bills/2026-08/close", headers: { cookie }, payload: { allow_incomplete: false, note: "并发 B" } }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  }, 120_000);

  it("数据缺口禁止静默结账，授权例外必须填写说明", async () => {
    const rejected = await app.inject({
      method: "POST", url: "/operating-bills/2026-07/close", headers: { cookie },
      payload: { allow_incomplete: false, note: null },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe("bill_incomplete");
    const missingNote = await app.inject({
      method: "POST", url: "/operating-bills/2026-07/close", headers: { cookie },
      payload: { allow_incomplete: true, note: null },
    });
    expect(missingNote.statusCode).toBe(400);
    expect(missingNote.json().error).toBe("close_note_required");
    const authorized = await app.inject({
      method: "POST", url: "/operating-bills/2026-07/close", headers: { cookie },
      payload: { allow_incomplete: true, note: "厂商暂未提供 7 月历史账单，经财务授权带缺口结账" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().status).toBe("CLOSED");
    expect(authorized.json().versions[0].exceptions.length).toBeGreaterThan(0);
  }, 120_000);

  it("金额价值缺少金额时在 API 层拒绝", async () => {
    const response = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/value-items", headers: { cookie },
      payload: { title: "节省成本", value_type: "MONETARY" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
    const excessivePrecision = await app.inject({
      method: "POST", url: "/operating-bills/2026-08/value-items", headers: { cookie },
      payload: { title: "节省成本", value_type: "MONETARY", amount: "12.345" },
    });
    expect(excessivePrecision.statusCode).toBe(400);
  });

  it("未登录请求与跨企业数据均受门禁保护", async () => {
    expect((await app.inject({ method: "GET", url: "/operating-bills/2026-08" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/operating-bills/not-a-month", headers: { cookie } })).statusCode).toBe(400);
  });
});
