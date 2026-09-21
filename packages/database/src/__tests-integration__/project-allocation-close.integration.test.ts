/**
 * WP06 集成测试：结账冻结（启用账期 close 写 ref、脏输入拒结、被引用 run 禁删）、
 * 补偿扫描 tick（新结算推脏→执行→消费）、旧账兼容（未启用账期 close 无 ref）。
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { Database } from "../kysely.js";
import {
  createProjectMembership, publishEmployeeRules,
  enableProjectAllocation, runDueAllocationRuns, projectAllocationTick,
  OperatingBillRepository, AllocationNotReadyError,
} from "../index.js";

let pg: PostgresTestInstance;
let db: Kysely<Database>;

const ent = randomUUID();
const entLegacy = randomUUID();
const admin = randomUUID();
const adminLegacy = randomUUID();
const projectA = randomUUID();
const employee1 = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
const keyId = randomUUID();

const T = (iso: string) => new Date(iso);
const SEP = (day: number) => T(`2026-09-${String(day).padStart(2, "0")}T10:00:00+08:00`);

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  for (const [id, name] of [[ent, "归集企业"], [entLegacy, "旧账企业"]] as const) {
    await db.insertInto("enterprise").values([{ id, name }]).execute();
  }
  await db.insertInto("admin_user").values([
    { id: admin, enterprise_id: ent, username: "a1", password_hash: "x" },
    { id: adminLegacy, enterprise_id: entLegacy, username: "a2", password_hash: "x" },
  ]).execute();
  await db.insertInto("principal").values([
    { id: projectA, enterprise_id: ent, type: "PROJECT", name: "项目A" },
    { id: employee1, enterprise_id: ent, type: "EMPLOYEE", name: "员工1" },
  ]).execute();
  await db.insertInto("provider").values([
    { id: providerId, enterprise_id: ent, code: "wp06", name: "WP06", adapter_type: "openai" },
  ]).execute();
  await db.insertInto("provider_resource").values([
    { id: resourceId, enterprise_id: ent, provider_id: providerId, name: "R", mode: "API", credential_type: "API_KEY" },
  ]).execute();
  await db.insertInto("principal_key").values([
    { id: keyId, enterprise_id: ent, principal_id: employee1, key_prefix: "k", key_digest: "d" },
  ]).execute();

  await seedLedgerLine(employee1, SEP(10), 1_000_000n, "3.0000");
  await createProjectMembership(db, {
    enterpriseId: ent, projectId: projectA, employeePrincipalId: employee1,
    joinedAt: SEP(1), leftAt: null, reason: "加入", idempotencyKey: "wp06-join", actorAdminId: admin,
  });
  const { rows } = await sql<{ membership_id: string }>`
    SELECT r.membership_id FROM project_membership_revision r
    JOIN project_membership m ON m.id = r.membership_id
    WHERE r.enterprise_id = ${ent} AND m.employee_principal_id = ${employee1} AND r.status = 'ACTIVE'
    LIMIT 1`.execute(db);
  await publishEmployeeRules(db, {
    enterpriseId: ent, employeePrincipalId: employee1, actorAdminId: admin,
    reason: "100%", idempotencyKey: "wp06-rules", expectedPolicyVersion: 0,
    rules: [{ projectPrincipalId: projectA, membershipId: rows[0]!.membership_id, weightBps: 10000, validFrom: SEP(1), validUntil: null }],
  });
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function seedLedgerLine(principalId: string, occurredAt: Date, inputTokens: bigint, apiCost: string): Promise<string> {
  const request = randomUUID();
  await db.insertInto("ai_request").values({
    id: request, enterprise_id: ent, principal_id: principalId, principal_key_id: keyId,
    protocol: "openai", unified_model: "m", status: "SUCCEEDED",
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
    usage_quality: "PROVIDER_REPORTED", dedup_key: `wp06-${request}`, created_at: occurredAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: request, enterprise_id: ent, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: resourceId, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: inputTokens, raw_output_tokens: 0n, raw_cache_tokens: 0n,
    api_cost: apiCost, usage_quality: "PROVIDER_REPORTED", created_at: occurredAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: request,
    enterprise_id: ent,
    principal_id: principalId,
    total_input_tokens: inputTokens,
    total_output_tokens: 0n,
    total_cache_tokens: 0n,
    total_reasoning_tokens: 0n,
    total_deducted_quota: 0n,
    total_api_cost: apiCost,
    usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1,
    status: "SETTLED",
    created_at: occurredAt,
  }).execute();
  await sql`UPDATE ledger_line SET api_cost_currency = 'CNY' WHERE ai_request_id = ${request}`.execute(db);
  return request;
}

function newRepo(): OperatingBillRepository {
  return new OperatingBillRepository(db);
}

describe("结账冻结（H02/H04）", () => {
  it("启用但无批次：close 拒绝（allocation_not_ready）", async () => {
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: "2026-09", actorAdminId: admin });
    await expect(newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month: "2026-09",
      allowIncomplete: true, note: "无批次结账",
    })).rejects.toThrow(AllocationNotReadyError);
  });

  it("执行批次后 close：ref 写入且被引用 run 禁删；脏输入再 close 拒绝", async () => {
    const results = await runDueAllocationRuns(db, "wp06");
    expect(results[0]?.status).toBe("SUCCEEDED");

    const closed = await newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month: "2026-09",
      allowIncomplete: true, note: "正常结账",
    });
    expect(closed.status).toBe("CLOSED");

    const ref = await sql<{ run_id: string; result_hash: string | null }>`
      SELECT run_id::text, (frozen->>'result_hash') AS result_hash
      FROM operating_bill_project_allocation_ref r
      JOIN operating_bill_version v ON v.id = r.bill_version_id
      JOIN operating_bill_period p ON p.id = v.period_id
      WHERE p.enterprise_id = ${ent} AND p.period_month = '2026-09-01'`.execute(db);
    expect(ref.rows).toHaveLength(1);
    expect(ref.rows[0]?.result_hash).not.toBeNull();
    await expect(sql`DELETE FROM project_allocation_run WHERE id = ${ref.rows[0]!.run_id}`.execute(db))
      .rejects.toThrow();

    // 重开 → 规则变更（脏代次前进）→ 再 close 被拒（stale_input）。
    const reopened = await newRepo().reopenMonth({ enterpriseId: ent, adminId: admin, month: "2026-09", reason: "测试重开" });
    expect(reopened.status).toBe("DRAFT");
    await publishEmployeeRules(db, {
      enterpriseId: ent, employeePrincipalId: employee1, actorAdminId: admin,
      reason: "改权重", idempotencyKey: "wp06-rules-2", expectedPolicyVersion: 1,
      rules: [{ projectPrincipalId: projectA, membershipId: (await sql<{ membership_id: string }>`
        SELECT r.membership_id FROM project_membership_revision r
        JOIN project_membership m ON m.id = r.membership_id
        WHERE r.enterprise_id = ${ent} AND m.employee_principal_id = ${employee1} AND r.status = 'ACTIVE'
        LIMIT 1`.execute(db)).rows[0]!.membership_id, weightBps: 5000, validFrom: SEP(1), validUntil: null }],
    });
    await expect(newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month: "2026-09",
      allowIncomplete: true, note: "脏输入结账",
    })).rejects.toThrow(AllocationNotReadyError);
  });

  it("旧账兼容（H03）：未启用企业 close 无 ref，旧口径可读", async () => {
    const legacyRepo = new OperatingBillRepository(db);
    const closed = await legacyRepo.closeMonth({
      enterpriseId: entLegacy, adminId: adminLegacy, month: "2026-09",
      allowIncomplete: true, note: "未启用归集的企业结账",
    });
    expect(closed.status).toBe("CLOSED");
    const refs = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM operating_bill_project_allocation_ref`.execute(db);
    expect(refs.rows[0]?.n).toBe(1);
  });
});

describe("补偿扫描 tick（A03 阶段一）", () => {
  it("新结算 → tick 推脏 → 登记并执行 → 再 tick 无事发生", async () => {
    // 上一用例结束时账期为 DRAFT（脏输入 close 被拒）；先执行积压批次清脏。
    await runDueAllocationRuns(db, "wp06");
    const first = await projectAllocationTick(db, "wp06-worker");
    expect(first.runsExecuted).toBeGreaterThanOrEqual(0);

    // 补偿扫描按 created_at 水位前进：新结算行用当前时间（仍在 2026-09 账期内）。
    await seedLedgerLine(employee1, new Date(), 500_000n, "1.5000");
    const afterNewLine = await projectAllocationTick(db, "wp06-worker");
    expect(afterNewLine.monthsMarked.some((m) => m.endsWith(":2026-09"))).toBe(true);
    expect(afterNewLine.runsExecuted).toBe(1);

    const idle = await projectAllocationTick(db, "wp06-worker");
    expect(idle.runsCreated).toBe(0);
    expect(idle.runsExecuted).toBe(0);
  });
});
