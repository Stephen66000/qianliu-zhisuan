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
  reviseProjectAccountingLifecycle,
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

describe("P1-2：date-only 结束核算统一排他边界", () => {
  it("结束日期当天全天请求仍按权重归集；规则段与 profile 边界一致", async () => {
    // 生命线：P 开始核算（date-only）→ 员工最后一天请求 → date-only 结束 9-20
    // → 边界 9-21T00:00+08；重算后最后一天请求仍为 MEMBERSHIP_RULE。
    const started = await reviseProjectAccountingLifecycle(db, {
      enterpriseId: ent, projectId: projectA,
      effectiveAt: T("2026-09-01T00:00:00+08:00"), effectiveAtIsDateOnly: true,
      reason: "P1-2 开始核算", expectedVersion: 0, actorAdminId: admin,
    });
    expect(started.mode).toBe("STARTED");

    // 9-20（结束日当天）的请求。
    const lastDayRequest = await seedLedgerLine(employee1, T("2026-09-20T20:00:00+08:00"), 100_000n, "1.0000");

    const ended = await reviseProjectAccountingLifecycle(db, {
      enterpriseId: ent, projectId: projectA,
      effectiveAt: T("2026-09-20T00:00:00+08:00"), effectiveAtIsDateOnly: true,
      reason: "P1-2 date-only 结束", expectedVersion: started.version, actorAdminId: admin,
    });
    expect(ended.mode).toBe("ENDED");

    // profile 边界 = 次日零点（+08）。
    const profile = await sql<{ ended: Date }>`
      SELECT accounting_ended_at AS ended FROM project_accounting_profile_version
      WHERE enterprise_id = ${ent} AND project_principal_id = ${projectA} AND is_current`.execute(db);
    expect((profile.rows[0]!.ended as Date).toISOString()).toBe("2026-09-20T16:00:00.000Z");

    // 规则段裁剪到同一边界。
    const ruleEdge = await sql<{ max_until: Date }>`
      SELECT MAX(ru.valid_until) AS max_until
      FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${ent} AND pol.is_current
        AND ru.project_principal_id = ${projectA}`.execute(db);
    expect((ruleEdge.rows[0]!.max_until as Date).toISOString()).toBe("2026-09-20T16:00:00.000Z");

    // 重算：结束日当天的请求按权重归集（不落入 NO_EFFECTIVE_RULE）。
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: "2026-09", actorAdminId: admin });
    const results = await runDueAllocationRuns(db, "p12-worker");
    expect(results[0]?.status).toBe("SUCCEEDED");

    // P1-2 修复验证：结束日当天的请求按权重归集（修复前会全部
    // NO_EFFECTIVE_RULE 未分配）。5000bps 段 → 50% 归集 + 50% 余量。
    const currentSources = await sql<{ sources: string }>`
      SELECT string_agg(DISTINCT allocation_source, ',') AS sources
      FROM project_allocation_line l
      JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current
        AND l.ai_request_id = ${lastDayRequest}`.execute(db);
    expect(currentSources.rows[0]?.sources).toBe("MEMBERSHIP_RULE,UNALLOCATED");
    const noRuleRows = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n
      FROM project_allocation_line l
      JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current
        AND l.ai_request_id = ${lastDayRequest}
        AND l.unallocated_reason = 'NO_EFFECTIVE_RULE'`.execute(db);
    expect(noRuleRows.rows[0]?.n).toBe(0);
  });
});
