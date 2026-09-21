/**
 * B01 不变性集成测试（候选 C3 WP07；合同 12 §2 方法）。
 * 步骤 A（仅迁移后）与步骤 B（配置成员/权重并完成计算后）分别捕获
 * S1 原始表摘要、S2 员工账、S3 项目账旧口径、S4 经营总览、S8 用量总览物化状态，
 * 断言逐字节一致；仅归集新表允许出现数据。
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { Database } from "../kysely.js";
import {
  createProjectMembership, publishEmployeeRules,
  enableProjectAllocation, runDueAllocationRuns,
  OperatingBillRepository, OperatingBillAccountRepository,
  loadOperatingDepartmentAccounts,
  getStandardHomeSummary,
  UsageOverviewRepository,
} from "../index.js";
import { loadMonthlyOperatingCosts } from "../repositories/monthly-operating-cost.js";
import { operatingBillMonthRange } from "../repositories/operating-bill-month.js";

let pg: PostgresTestInstance;
let db: Kysely<Database>;

const ent = randomUUID();
const admin = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const employee1 = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
const keyId = randomUUID();
const modelId = randomUUID();

const T = (iso: string) => new Date(iso);
const SEP = (day: number) => T(`2026-09-${String(day).padStart(2, "0")}T10:00:00+08:00`);

async function digest(query: string): Promise<string> {
  const { rows } = await sql<{ d: string }>`SELECT md5(string_agg(row_to_json(t)::text, E'\n' ORDER BY 1)) AS d FROM (${sql.raw(query)}) t`.execute(db);
  return rows[0]?.d ?? "empty";
}

async function snapshots(): Promise<Record<string, string>> {
  return {
    S1_ledger: await digest(`SELECT id, ai_request_id, raw_input_tokens, raw_output_tokens, api_cost, api_cost_currency, usage_quality, created_at FROM ledger_line WHERE enterprise_id='${ent}'`),
    S1_usage: await digest(`SELECT id, input_tokens, output_tokens, usage_quality, created_at FROM usage_event WHERE enterprise_id='${ent}'`),
    S1_request: await digest(`SELECT id, status, started_at FROM ai_request WHERE enterprise_id='${ent}'`),
    S2_employee: JSON.stringify(await new OperatingBillAccountRepository(db).listAccounts(ent, "2026-09", "EMPLOYEE", { limit: 100, offset: 0 })),
    S3_project_old: JSON.stringify(await new OperatingBillAccountRepository(db).listAccounts(ent, "2026-09", "PROJECT", { limit: 100, offset: 0 })),
    // generatedAt 为读时生成时间，属时间性字段，比较前归一化。
    S4_bill: JSON.stringify(await new OperatingBillRepository(db).getBill(ent, "2026-09"), (key, value) => (key === "generatedAt" ? "<normalized>" : value)),
    S8_usage_aggregate_state: await digest(`SELECT * FROM usage_aggregate_bucket_state WHERE enterprise_id='${ent}'`),
    S8_usage_buckets: await digest(`SELECT * FROM usage_bucket_aggregate WHERE enterprise_id='${ent}'`),
    S8_usage_dirty: await digest(`SELECT * FROM usage_aggregate_dirty_bucket WHERE enterprise_id='${ent}'`),
    // S5 部门账（直接读模型，非 getBill 代理）
    S5_department_accounts: JSON.stringify(await loadOperatingDepartmentAccounts(db, ent, "2026-09"),
      (key, value) => (key === "generatedAt" ? "<normalized>" : value)),
    // S6 厂商资金账（月度费用读模型：knownLedgerCosts 不传由其内部自取）
    S6_monthly_costs: JSON.stringify(await loadMonthlyOperatingCosts(
      db, ent, operatingBillMonthRange("2026-09").start, operatingBillMonthRange("2026-09").end)),
    // S7 首页（标准版聚合：Token/同期费用/资源区一并覆盖；bill 与月度总览同源快照传入）
    S7_home_summary: JSON.stringify(await getStandardHomeSummary(db, {
      enterpriseId: ent, asOf: new Date("2026-09-15T06:00:00.000Z"),
      bill: await new OperatingBillRepository(db).getBill(ent, "2026-09") as never,
      financeRead: false,
    }), (key, value) => (key === "asOf" || key === "generatedAt" ? "<time>" : value)),
  };
}

async function seedLedgerLine(principalId: string, occurredAt: Date, inputTokens: bigint, apiCost: string): Promise<string> {
  const request = randomUUID();
  await db.insertInto("ai_request").values({
    id: request, enterprise_id: ent, principal_id: principalId, principal_key_id: keyId,
    protocol: "openai", unified_model: "m", unified_model_id: modelId, status: "SUCCEEDED",
    started_at: occurredAt, finished_at: new Date(occurredAt.getTime() + 1000),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: request, enterprise_id: ent, attempt_no: 1, provider_resource_id: resourceId,
    upstream_model: "m", finished_at: new Date(occurredAt.getTime() + 1000), http_status: 200, response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: request, enterprise_id: ent, upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId, input_tokens: inputTokens, output_tokens: 0n,
    cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: `b01-${request}`, created_at: occurredAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: request, enterprise_id: ent, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: resourceId, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: inputTokens, raw_output_tokens: 0n, raw_cache_tokens: 0n,
    api_cost: apiCost, usage_quality: "PROVIDER_REPORTED", created_at: occurredAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: request, enterprise_id: ent, principal_id: principalId,
    total_input_tokens: inputTokens, total_output_tokens: 0n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: apiCost,
    usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: occurredAt,
  }).execute();
  await sql`UPDATE ledger_line SET api_cost_currency='CNY' WHERE ai_request_id=${request}`.execute(db);
  return request;
}

let stepA: Record<string, string>;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([{ id: ent, name: "B01 企业" }]).execute();
  await db.insertInto("admin_user").values([{ id: admin, enterprise_id: ent, username: "b01", password_hash: "x" }]).execute();
  await db.insertInto("principal").values([
    { id: projectA, enterprise_id: ent, type: "PROJECT", name: "项目A" },
    { id: projectB, enterprise_id: ent, type: "PROJECT", name: "项目B" },
    { id: employee1, enterprise_id: ent, type: "EMPLOYEE", name: "员工1" },
  ]).execute();
  await db.insertInto("provider").values([
    { id: providerId, enterprise_id: ent, code: "b01", name: "B01 厂商", adapter_type: "openai" },
  ]).execute();
  await db.insertInto("provider_resource").values([
    { id: resourceId, enterprise_id: ent, provider_id: providerId, name: "R", mode: "API", credential_type: "API_KEY" },
  ]).execute();
  await db.insertInto("principal_key").values([
    { id: keyId, enterprise_id: ent, principal_id: employee1, key_prefix: "k", key_digest: "d" },
  ]).execute();
  await db.insertInto("unified_model").values([
    { id: modelId, enterprise_id: ent, alias: "b01-m", display_name: "B01 模型" },
  ]).execute();

  await seedLedgerLine(employee1, SEP(5), 1_000_000n, "3.0000");
  await seedLedgerLine(employee1, SEP(15), 2_000_000n, "6.0000");
  await seedLedgerLine(employee1, SEP(25), 3_000_000n, "9.0000");
  await seedLedgerLine(projectA, SEP(10), 100_000n, "1.0000");
  const manualRequest = await seedLedgerLine(employee1, SEP(12), 200_000n, "2.0000");
  await db.insertInto("operating_bill_request_project_assignment").values({
    enterprise_id: ent, ai_request_id: manualRequest,
    project_principal_id: projectB, assigned_by: admin, reason: "人工指定",
  }).execute();

  // 步骤 A：仅迁移 + 源事实，无任何归集配置。
  stepA = await snapshots();
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("B01 不变性（S1–S8 直接断言：原始表/员工账/项目账/总览/部门账/资金账/首页/用量总览）", () => {
  it("配置成员/权重并完成计算后，全部不变性面保持原值", async () => {
    await createProjectMembership(db, {
      enterpriseId: ent, projectId: projectA, employeePrincipalId: employee1,
      joinedAt: SEP(1), leftAt: null, reason: "B01", idempotencyKey: "b01-join", actorAdminId: admin,
    });
    await createProjectMembership(db, {
      enterpriseId: ent, projectId: projectB, employeePrincipalId: employee1,
      joinedAt: SEP(11), leftAt: SEP(21), reason: "B01", idempotencyKey: "b01-join-b", actorAdminId: admin,
    });
    const { rows } = await sql<{ a: string; b: string }>`
      SELECT
        (SELECT r.membership_id FROM project_membership_revision r JOIN project_membership m ON m.id=r.membership_id
          WHERE r.enterprise_id=${ent} AND m.project_principal_id=${projectA} AND r.status='ACTIVE' LIMIT 1) AS a,
        (SELECT r.membership_id FROM project_membership_revision r JOIN project_membership m ON m.id=r.membership_id
          WHERE r.enterprise_id=${ent} AND m.project_principal_id=${projectB} AND r.status='ACTIVE' LIMIT 1) AS b`.execute(db);
    await publishEmployeeRules(db, {
      enterpriseId: ent, employeePrincipalId: employee1, actorAdminId: admin,
      reason: "B01 规则", idempotencyKey: "b01-rules", expectedPolicyVersion: 0,
      rules: [
        { projectPrincipalId: projectA, membershipId: rows[0]!.a, weightBps: 10000, validFrom: SEP(1), validUntil: SEP(11) },
        { projectPrincipalId: projectA, membershipId: rows[0]!.a, weightBps: 6000, validFrom: SEP(11), validUntil: SEP(21) },
        { projectPrincipalId: projectB, membershipId: rows[0]!.b, weightBps: 3000, validFrom: SEP(11), validUntil: SEP(21) },
      ],
    });
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: "2026-09", actorAdminId: admin });
    const results = await runDueAllocationRuns(db, "b01-worker");
    expect(results[0]?.status).toBe("SUCCEEDED");

    const stepB = await snapshots();
    const failures: string[] = [];
    for (const [key, value] of Object.entries(stepA)) {
      if (stepB[key] !== value) failures.push(key);
    }
    expect(failures).toEqual([]);

    // 原始表行数不变；归集新表出现数据（唯一预期变化）。
    const counts = await sql<{ ledger_n: number; alloc_n: number }>`
      SELECT (SELECT COUNT(*)::int FROM ledger_line WHERE enterprise_id=${ent}) AS ledger_n,
             (SELECT COUNT(*)::int FROM project_allocation_line WHERE enterprise_id=${ent}) AS alloc_n`.execute(db);
    expect(counts.rows[0]?.ledger_n).toBe(5);
    expect(counts.rows[0]?.alloc_n).toBeGreaterThan(0);
  });
});
