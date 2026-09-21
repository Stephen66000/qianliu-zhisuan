/**
 * 项目归集计算端到端集成测试（候选 C3 WP03：源行装载、批次执行、原子发布、
 * 幂等、规则变更重算、终态不可变；金标 GS-3 的端到端对应）。
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { Database } from "../kysely.js";
import {
  createProjectMembership, publishEmployeeRules,
  enableProjectAllocation, enqueueAllocationRun, runDueAllocationRuns,
  markAllocationDirty, getUnallocatedSummary,
} from "../index.js";

let pg: PostgresTestInstance;
let db: Kysely<Database>;

const ent = randomUUID();
const admin = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const employee1 = randomUUID();
const employee2 = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
const keyId = randomUUID();
const modelId = randomUUID();

const T = (iso: string) => new Date(iso);
/** 2026-09（北京月）内的时刻。 */
const SEP = (day: number, hour = 10) => T(`2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`);

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([{ id: ent, name: "归集计算企业" }]).execute();
  await db.insertInto("admin_user").values([
    { id: admin, enterprise_id: ent, username: "admin", password_hash: "x" },
  ]).execute();
  await db.insertInto("principal").values([
    { id: projectA, enterprise_id: ent, type: "PROJECT", name: "项目A" },
    { id: projectB, enterprise_id: ent, type: "PROJECT", name: "项目B" },
    { id: employee1, enterprise_id: ent, type: "EMPLOYEE", name: "员工1" },
    { id: employee2, enterprise_id: ent, type: "EMPLOYEE", name: "员工2" },
  ]).execute();
  await db.insertInto("provider").values([
    { id: providerId, enterprise_id: ent, code: "test-prov", name: "测试厂商", adapter_type: "openai" },
  ]).execute();
  await db.insertInto("provider_resource").values([
    { id: resourceId, enterprise_id: ent, provider_id: providerId, name: "API 资源", mode: "API", credential_type: "API_KEY" },
  ]).execute();
  await db.insertInto("principal_key").values([
    { id: keyId, enterprise_id: ent, principal_id: employee1, key_prefix: "alloc-test", key_digest: "alloc-digest" },
  ]).execute();
  await db.insertInto("unified_model").values([
    { id: modelId, enterprise_id: ent, alias: "test-model", display_name: "测试模型" },
  ]).execute();

  // GS-1/GS-3 形态：员工1 三段（100% / 60+30 / 退出）各 100/200/300 万输入 token；
  // 项目A 直接调用 10 万；员工2 人工指定到 B 20 万。
  await seedLedgerLine(employee1, SEP(5), 1_000_000n, "3.0000", "CNY");
  await seedLedgerLine(employee1, SEP(15), 2_000_000n, "6.0000", "CNY");
  await seedLedgerLine(employee1, SEP(25), 3_000_000n, "9.0000", "CNY");
  await seedLedgerLine(projectA, SEP(10), 100_000n, "1.0000", "CNY");
  const manualRequest = await seedLedgerLine(employee2, SEP(12), 200_000n, "2.0000", "USD");
  await db.insertInto("operating_bill_request_project_assignment").values({
    enterprise_id: ent,
    ai_request_id: manualRequest,
    project_principal_id: projectB,
    assigned_by: admin,
    reason: "人工指定",
  }).execute();

  await createProjectMembership(db, {
    enterpriseId: ent, projectId: projectA, employeePrincipalId: employee1,
    joinedAt: SEP(1), leftAt: null,
    reason: "加入A", idempotencyKey: "gs-join-a", actorAdminId: admin,
  });
  await createProjectMembership(db, {
    enterpriseId: ent, projectId: projectB, employeePrincipalId: employee1,
    joinedAt: SEP(11), leftAt: SEP(21),
    reason: "加入B", idempotencyKey: "gs-join-b", actorAdminId: admin,
  });
  const membershipA = await activeMembership(projectA);
  const membershipB = await activeMembership(projectB);
  await publishEmployeeRules(db, {
    enterpriseId: ent, employeePrincipalId: employee1, actorAdminId: admin,
    reason: "三段规则", idempotencyKey: "gs-rules-1", expectedPolicyVersion: 0,
    rules: [
      { projectPrincipalId: projectA, membershipId: membershipA, weightBps: 10000, validFrom: SEP(1), validUntil: SEP(11) },
      { projectPrincipalId: projectA, membershipId: membershipA, weightBps: 6000, validFrom: SEP(11), validUntil: SEP(21) },
      { projectPrincipalId: projectB, membershipId: membershipB, weightBps: 3000, validFrom: SEP(11), validUntil: SEP(21) },
    ],
  });
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function seedLedgerLine(
  principalId: string,
  occurredAt: Date,
  inputTokens: bigint,
  apiCost: string,
  currency: "CNY" | "USD",
): Promise<string> {
  const request = randomUUID();
  await db.insertInto("ai_request").values({
    id: request,
    enterprise_id: ent,
    principal_id: principalId,
    principal_key_id: principalId === employee1 ? keyId : keyId,
    protocol: "openai",
    unified_model: "test-model",
    unified_model_id: modelId,
    status: "SUCCEEDED",
    started_at: occurredAt,
    finished_at: new Date(occurredAt.getTime() + 1000),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: request,
    enterprise_id: ent,
    attempt_no: 1,
    provider_resource_id: resourceId,
    upstream_model: "test-model",
    finished_at: new Date(occurredAt.getTime() + 1000),
    http_status: 200,
    response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: request,
    enterprise_id: ent,
    upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId,
    input_tokens: inputTokens,
    output_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED",
    dedup_key: `alloc-${request}`,
    created_at: occurredAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: request,
    enterprise_id: ent,
    usage_event_id: usage.id,
    upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId,
    principal_id: principalId,
    resource_mode: "API",
    raw_input_tokens: inputTokens,
    raw_output_tokens: 0n,
    raw_cache_tokens: 0n,
    api_cost: apiCost,
    usage_quality: "PROVIDER_REPORTED",
    created_at: occurredAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: request,
    enterprise_id: ent,
    principal_id: principalId,
    total_input_tokens: inputTokens,
    total_output_tokens: 0n,
    total_cache_tokens: 0n,
    total_deducted_quota: 0n,
    total_api_cost: apiCost,
    usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1,
    status: "SETTLED",
    created_at: occurredAt,
  }).execute();
  // api_cost_currency 无默认值列：补写。
  await sql`UPDATE ledger_line SET api_cost_currency = ${currency} WHERE ai_request_id = ${request}`.execute(db);
  return request;
}

async function activeMembership(projectId: string): Promise<string> {
  const { rows } = await sql<{ membership_id: string }>`
    SELECT r.membership_id FROM project_membership_revision r
    JOIN project_membership m ON m.id = r.membership_id
    WHERE r.enterprise_id = ${ent} AND m.project_principal_id = ${projectId}
      AND m.employee_principal_id = ${employee1} AND r.status = 'ACTIVE'
    ORDER BY r.revision LIMIT 1`.execute(db);
  const id = rows[0]?.membership_id;
  if (id === undefined) throw new Error(`no membership for ${projectId}`);
  return id;
}

describe("归集计算端到端", () => {
  it("启用 → 执行 → 发布：源行 5 行、份额守恒、run 字段完整", async () => {
    const enabled = await enableProjectAllocation(db, {
      enterpriseId: ent, startMonth: "2026-09", actorAdminId: admin,
    });
    expect(enabled.runId).not.toBeNull();
    const results = await runDueAllocationRuns(db, "test-worker");
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("SUCCEEDED");

    const run = await sql<{
      id: string; is_current: boolean; status: string; source_line_count: number;
      input_digest: string; result_hash: string; conservation: { byProject?: Array<{ projectPrincipalId: string; totalTokens: string }> };
    }>`
      SELECT id, is_current, status, source_line_count, input_digest, result_hash, conservation
      FROM project_allocation_run WHERE id = ${enabled.runId}`.execute(db);
    const row = run.rows[0]!;
    expect(row.is_current).toBe(true);
    expect(row.source_line_count).toBe(5);
    expect(row.input_digest).not.toBeNull();
    expect(row.result_hash).not.toBeNull();

    // 金标（GS-3 端到端）：A 230 万、B 80 万、未分配 320 万、源总量 630 万。
    const totals = await sql<{ project: string; tokens: string }>`
      SELECT target_project_principal_id::text AS project, SUM(share_input_tokens)::text AS tokens
      FROM project_allocation_line WHERE run_id = ${enabled.runId} AND target_type = 'PROJECT'
      GROUP BY target_project_principal_id`.execute(db);
    const tokensOf = (id: string) => totals.rows.find((r) => r.project === id)?.tokens;
    expect(tokensOf(projectA)).toBe("2300000.0000");
    expect(tokensOf(projectB)).toBe("800000.0000");
    const unallocated = await sql<{ tokens: string }>`
      SELECT SUM(share_input_tokens)::text AS tokens FROM project_allocation_line
      WHERE run_id = ${enabled.runId} AND target_type = 'UNALLOCATED'`.execute(db);
    expect(unallocated.rows[0]?.tokens).toBe("3200000.0000");

    // 币种分离：CNY 全在池+直接，USD 全在人工指定行。
    const cny = await sql<{ total: string }>`
      SELECT SUM(share_api_cost)::text AS total FROM project_allocation_line
      WHERE run_id = ${enabled.runId} AND api_cost_currency = 'CNY'`.execute(db);
    expect(cny.rows[0]?.total).toBe("19.0000");
    const usd = await sql<{ total: string }>`
      SELECT SUM(share_api_cost)::text AS total FROM project_allocation_line
      WHERE run_id = ${enabled.runId} AND api_cost_currency = 'USD'`.execute(db);
    expect(usd.rows[0]?.total).toBe("2.0000");

    // dirty 已消费。
    const dirty = await sql<{ dirty: boolean }>`
      SELECT dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-09-01'`.execute(db);
    expect(dirty.rows[0]?.dirty).toBe(false);
  });

  it("幂等：无新输入时 enqueue 返回既有 SUCCEEDED，不新建批次", async () => {
    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId: ent, month: "2026-09", actorType: "SYSTEM", actorAdminId: null,
    });
    expect(enqueued.created).toBe(false);
    expect(enqueued.status).toBe("SUCCEEDED");
    const count = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM project_allocation_run
      WHERE enterprise_id = ${ent} AND period_month = '2026-09-01'`.execute(db);
    expect(count.rows[0]?.n).toBe(1);
  });

  it("规则变更推 dirty → 新批次 → 发布新版本，旧批次保留", async () => {
    const membershipA = await activeMembership(projectA);
    await publishEmployeeRules(db, {
      enterpriseId: ent, employeePrincipalId: employee1, actorAdminId: admin,
      reason: "改权重", idempotencyKey: "gs-rules-2", expectedPolicyVersion: 1,
      rules: [
        { projectPrincipalId: projectA, membershipId: membershipA, weightBps: 5000, validFrom: SEP(11), validUntil: SEP(21) },
      ],
    });
    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId: ent, month: "2026-09", actorType: "SYSTEM", actorAdminId: null,
    });
    expect(enqueued.created).toBe(true);
    const results = await runDueAllocationRuns(db, "test-worker");
    expect(results[0]?.status).toBe("SUCCEEDED");

    const runs = await sql<{ id: string; is_current: boolean }>`
      SELECT id, is_current FROM project_allocation_run
      WHERE enterprise_id = ${ent} AND period_month = '2026-09-01'
      ORDER BY created_at`.execute(db);
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.filter((r) => r.is_current)).toHaveLength(1);

    // 新口径：整集替换后仅剩 A 段 5000bps[11,21)；s1 无规则 100 万、s2 余 100 万、
    // s3 退出后 300 万 → 未分配 500 万。
    const newTotals = await sql<{ tokens: string }>`
      SELECT SUM(share_input_tokens)::text AS tokens FROM project_allocation_line l
      JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.period_month = '2026-09-01' AND r.is_current
        AND l.target_type = 'UNALLOCATED'`.execute(db);
    expect(newTotals.rows[0]?.tokens).toBe("5000000.0000");
  });

  it("GET 类读取路径不产生新批次（enqueue 只由显式调用触发）", async () => {
    // 模拟只读路径：再次执行 worker 但无脏数据，应无事发生。
    const results = await runDueAllocationRuns(db, "test-worker");
    expect(results).toHaveLength(0);
  });
});

describe("P1 修复专项", () => {
  it("P1-1/GS-5：无 Token 行的 CODING_PLAN 资源套餐成本进入资源余量，不伪造 Token（C08）", async () => {
    const entPlan = randomUUID();
    const adminPlan = randomUUID();
    const planResource = randomUUID();
    const planResourceSnap = randomUUID();
    await db.insertInto("enterprise").values({ id: entPlan, name: "残量企业", timezone: "Asia/Shanghai" }).execute();
    await db.insertInto("admin_user").values({ id: adminPlan, enterprise_id: entPlan, username: "p1", password_hash: "x" }).execute();
    await db.insertInto("provider").values({
      id: randomUUID(), enterprise_id: entPlan, code: "plan-prov", name: "套餐厂商", adapter_type: "zhipu",
    }).execute();
    await db.insertInto("provider_resource").values([
      { id: planResource, enterprise_id: entPlan, provider_id: (await sql<{ id: string }>`
        SELECT id FROM provider WHERE enterprise_id = ${entPlan} LIMIT 1`.execute(db)).rows[0]!.id,
        name: "套餐资源（有现金事件）", mode: "CODING_PLAN", credential_type: "API_KEY" },
    ]).execute();
    // finance 运行态开启：authority = 当月 cash_paid_cny。
    // shape 约束要求激活态带激活人与时间（0061）。
    await sql`INSERT INTO provider_finance_runtime_state
      (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id)
      VALUES (${entPlan}::uuid, true, now(), ${adminPlan}::uuid)`.execute(db);
    await db.transaction().execute(async (trx) => {
      const event = await trx.insertInto("provider_finance_event").values({
        enterprise_id: entPlan, provider_resource_id: planResource,
        event_type: "CODING_PLAN_PURCHASE", account_amount: "100", account_currency: "CNY",
        cash_paid_cny: "100", occurred_at: new Date("2026-08-05T00:00:00+08:00"),
        external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: null, description: "套餐采购", evidence_ref: null,
        source: "MIGRATION", idempotency_key: `p11-${randomUUID()}`, created_by_admin_user_id: adminPlan,
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("provider_subscription_period").values({
        enterprise_id: entPlan, provider_resource_id: planResource, finance_event_id: event.id,
        product_name: "套餐", period_start: new Date("2026-08-05T00:00:00+08:00"),
        period_end_exclusive: new Date("2026-09-05T00:00:00+08:00"),
        source: "PURCHASE", created_by_admin_user_id: adminPlan,
      }).execute();
    });

    await enableProjectAllocation(db, { enterpriseId: entPlan, startMonth: "2026-08", actorAdminId: adminPlan });
    const results = await runDueAllocationRuns(db, "p11-worker");
    expect(results[0]?.status).toBe("SUCCEEDED");

    // 无任何源行：份额行为 0，套餐成本 100 全额进入资源余量。
    const shareCount = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM project_allocation_line WHERE enterprise_id = ${entPlan}`.execute(db);
    expect(shareCount.rows[0]?.n).toBe(0);
    const residual = await sql<{ amount: string; currency: string; note: string }>`
      SELECT amount::text, currency, note FROM project_allocation_resource_residual
      WHERE enterprise_id = ${entPlan}`.execute(db);
    expect(residual.rows).toHaveLength(1);
    expect(residual.rows[0]?.amount).toBe("100.00000000");
    expect(residual.rows[0]?.note).toBe("PLAN_CASH_RESIDUAL");

    // 读取模型透出资源余量（C08 展示口径）。
    const view = await getUnallocatedSummary(db, entPlan, "2026-08");
    expect(view.resourceResidual).toHaveLength(1);
    expect(view.resourceResidual[0]?.amount).toBe("100.00000000");

    // 快照口径变体：非 finance 企业，快照 package_cost=40 且无源行 → 余量 40。
    const entSnap = randomUUID();
    const adminSnap = randomUUID();
    await db.insertInto("enterprise").values({ id: entSnap, name: "快照残量企业" }).execute();
    await db.insertInto("admin_user").values({ id: adminSnap, enterprise_id: entSnap, username: "p2", password_hash: "x" }).execute();
    await db.insertInto("provider").values({
      id: randomUUID(), enterprise_id: entSnap, code: "snap-prov", name: "快照厂商", adapter_type: "openai",
    }).execute();
    const snapRes = randomUUID();
    await db.insertInto("provider_resource").values({
      id: snapRes, enterprise_id: entSnap,
      provider_id: (await sql<{ id: string }>`
        SELECT id FROM provider WHERE enterprise_id = ${entSnap} LIMIT 1`.execute(db)).rows[0]!.id,
      name: "快照套餐资源", mode: "CODING_PLAN", credential_type: "API_KEY",
    }).execute();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: entSnap, provider_resource_id: snapRes, version: 1,
      package_cost: "40", effective_from: new Date("2026-08-01T00:00:00+08:00"),
      effective_until: null, collected_at: new Date("2026-08-20T00:00:00+08:00"),
      source: "ADMIN",
    }).execute();
    await enableProjectAllocation(db, { enterpriseId: entSnap, startMonth: "2026-08", actorAdminId: adminSnap });
    await runDueAllocationRuns(db, "p11-worker");
    const snapResidual = await sql<{ amount: string; note: string }>`
      SELECT amount::text, note FROM project_allocation_resource_residual
      WHERE enterprise_id = ${entSnap}`.execute(db);
    expect(snapResidual.rows).toHaveLength(1);
    expect(snapResidual.rows[0]?.amount).toBe("40.00000000");
    expect(snapResidual.rows[0]?.note).toBe("SNAPSHOT_RESIDUAL");
    void planResourceSnap;
  });

  it("P1-3：finance 原地 UPDATE 改变行内容 → digest 变化强制重算，dirty 不被错误清除", async () => {
    // 第一轮：正常行 → 计算成功。
    const request = await seedLedgerLine(employee1, new Date("2026-08-20T12:00:00+08:00"), 10_000n, "1.0000");
    await markAllocationDirty(db, ent, ["2026-08"]);
    await enqueueAllocationRun(db, {
      enterpriseId: ent, month: "2026-08", actorType: "SYSTEM", actorAdminId: null,
    });
    const first = await runDueAllocationRuns(db, "p13-worker");
    expect(first[0]?.status).toBe("SUCCEEDED");
    const firstRun = first[0]!.runId;

    // 原地 UPDATE（模拟 finance 回填）：行数不变、内容变化。
    await sql`UPDATE ledger_line SET api_cost_status = 'UNKNOWN_COST', api_cost = NULL
      WHERE ai_request_id = ${request}`.execute(db);
    await markAllocationDirty(db, ent, ["2026-08"]);

    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId: ent, month: "2026-08", actorType: "SYSTEM", actorAdminId: null,
    });
    expect(enqueued.created).toBe(true);

    const second = await runDueAllocationRuns(db, "p13-worker");
    expect(second[0]?.status).toBe("SUCCEEDED");
    const secondRun = second[0]!.runId;
    expect(secondRun).not.toBe(firstRun);

    // 新 current 的明细反映新内容：UNKNOWN 行 share_api_cost 为 NULL。
    const updated = await sql<{ null_cost_lines: number }>`
      SELECT COUNT(*)::int AS null_cost_lines
      FROM project_allocation_line l
      JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}
        AND l.share_api_cost IS NULL`.execute(db);
    expect(Number(updated.rows[0]?.null_cost_lines)).toBeGreaterThan(0);

    // 旧批次不再是 current；dirty 已被成功发布消费。
    const runs = await sql<{ n: number; current: number }>`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_current)::int AS current
      FROM project_allocation_run WHERE enterprise_id = ${ent} AND period_month = '2026-08-01'`.execute(db);
    expect(runs.rows[0]?.n).toBe(2);
    expect(runs.rows[0]?.current).toBe(1);
    const dirty = await sql<{ dirty: boolean }>`
      SELECT dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-08-01'`.execute(db);
    expect(dirty.rows[0]?.dirty).toBe(false);
  });
});
