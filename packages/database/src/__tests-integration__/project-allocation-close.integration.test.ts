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
  createProjectMembership, publishEmployeeRules, publishProjectIntent,
  enableProjectAllocation, enqueueAllocationRun, runDueAllocationRuns, projectAllocationTick,
  reviseProjectAccountingLifecycle, listAllocationLines, markAllocationDirty,
  getAllocationRunStatus, getUnallocatedSummary, listUnallocatedLines,
  AllocationRunNotAccessibleError, OperatingBillRepository, AllocationNotReadyError,
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

    // 补偿扫描按 created_at 水位前进：新结算行的 created_at 必须取**数据库时钟**。
    // 用宿主 JS 时钟写入时，容器时钟偏移（本机实测快 1.2–6.0s）会让
    // MAX(created_at) 与 DB now() 写的 last_marked_at 比较翻转，tick 重复标记同一
    // 月份 → idle.runsCreated 期望 0 实际 1（R02 P1：非确定性 flake）。
    const { rows: clock } = await sql<{ now: Date; month: string }>`
      SELECT now() AS now, to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month`.execute(db);
    const month = clock[0]!.month;
    await seedLedgerLine(employee1, clock[0]!.now, 500_000n, "1.5000");
    const afterNewLine = await projectAllocationTick(db, "wp06-worker");
    expect(afterNewLine.monthsMarked.some((m) => m.endsWith(`:${month}`))).toBe(true);
    expect(afterNewLine.runsExecuted).toBe(1);

    const idle = await projectAllocationTick(db, "wp06-worker");
    expect(idle.runsCreated).toBe(0);
    expect(idle.runsExecuted).toBe(0);
  });

  it("P2-c：纯规则变更（无新 ledger 行）→ tick 自行登记重算，不依赖人工重建", async () => {
    const month = "2026-08";
    const employee2 = randomUUID();
    const project = randomUUID();
    await db.insertInto("principal").values([
      { id: employee2, enterprise_id: ent, type: "EMPLOYEE", name: "P2-c 员工" },
      { id: project, enterprise_id: ent, type: "PROJECT", name: "P2-c 项目" },
    ]).execute();
    const request = await seedLedgerLine(employee2, T("2026-08-05T10:00:00+08:00"), 300_000n, "0.9000");
    const key2 = randomUUID();
    await db.insertInto("principal_key").values([
      { id: key2, enterprise_id: ent, principal_id: employee2, key_prefix: "p2c", key_digest: "p2c-digest" },
    ]).execute();
    await sql`UPDATE ai_request SET principal_key_id = ${key2} WHERE id = ${request}`.execute(db);
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    const first = await runDueAllocationRuns(db, "p2c-worker");
    expect(first[0]?.status).toBe("SUCCEEDED");

    // F-1：项目明细严格按项目口径——此时该账期只有企业级未分配行，
    // 不得把它们混入项目明细并计入 total（修复前 total 会大于 0）。
    const emptyDetail = await listAllocationLines(db, ent, month, project, { limit: 25, offset: 0 });
    expect(emptyDetail.total).toBe(0);
    expect(emptyDetail.lines).toEqual([]);

    // 参与 + 规则发布：归集输入变了，但该账期没有任何新 ledger 行——
    // 修复前 tick 只按"迟到行"登记，这个账期永远不会被重算（只能人工点重建批次）。
    await createProjectMembership(db, {
      enterpriseId: ent, projectId: project, employeePrincipalId: employee2,
      joinedAt: T("2026-08-01T00:00:00+08:00"), leftAt: null,
      reason: "P2-c 加入", idempotencyKey: "p2c-join", actorAdminId: admin,
    });
    const membership = await sql<{ membership_id: string }>`
      SELECT r.membership_id FROM project_membership_revision r
      JOIN project_membership m ON m.id = r.membership_id
      WHERE r.enterprise_id = ${ent} AND m.employee_principal_id = ${employee2} AND r.status = 'ACTIVE'
      LIMIT 1`.execute(db);
    await publishEmployeeRules(db, {
      enterpriseId: ent, employeePrincipalId: employee2, actorAdminId: admin,
      reason: "P2-c 规则", idempotencyKey: "p2c-rules", expectedPolicyVersion: 0,
      rules: [{
        projectPrincipalId: project, membershipId: membership.rows[0]!.membership_id,
        weightBps: 10000, validFrom: T("2026-08-01T00:00:00+08:00"), validUntil: null,
      }],
    });

    const tick = await projectAllocationTick(db, "p2c-worker");
    expect(tick.monthsEnqueued.some((m) => m.endsWith(`:${month}`))).toBe(true);
    expect(tick.runsExecuted).toBeGreaterThanOrEqual(1);
    const after = await sql<{ sources: string }>`
      SELECT string_agg(DISTINCT allocation_source, ',') AS sources
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(after.rows[0]?.sources).toBe("MEMBERSHIP_RULE");
    // 正例对照：重算后该项目的明细确实有这一行（端点不是恒空）。
    const projectDetail = await listAllocationLines(db, ent, month, project, { limit: 25, offset: 0 });
    expect(projectDetail.total).toBe(1);
    expect(projectDetail.lines[0]?.requestId).toBe(request);

    const closed = await newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "P2-c 自动重算后结账",
    });
    expect(closed.status).toBe("CLOSED");
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

describe("P1-a：digest 命中幂等再发布（R02 返修）", () => {
  it("启用→SUCCEEDED→代次前进但摘要未变（重建/无关标记）→no-op 成功、dirty 清除、close 放行", async () => {
    // 摘要命中方向的触发路径：配置类写入会给账期推脏，但若归集的全部输入
    // （行事实/规则/参与/核算窗口/人工指定）都没变（例如运营点"重建批次"、
    // 或为无关项目做的标记落到该账期），新批次必然命中已发布摘要。
    const month = "2026-07";
    await seedLedgerLine(employee1, T("2026-07-15T10:00:00+08:00"), 400_000n, "1.2000");
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    const first = await runDueAllocationRuns(db, "p1a-worker");
    expect(first[0]?.status).toBe("SUCCEEDED");
    const published = await sql<{ id: string; input_digest: string; input_dirty_generation: string }>`
      SELECT id, input_digest, input_dirty_generation::text FROM project_allocation_run
      WHERE enterprise_id = ${ent} AND period_month = '2026-07-01' AND is_current`.execute(db);
    expect(published.rows[0]?.input_digest).not.toBeNull();

    await markAllocationDirty(db, ent, [month]);
    const stale = await sql<{ generation: string; dirty: boolean }>`
      SELECT generation::text, dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-07-01'`.execute(db);
    expect(stale.rows[0]?.dirty).toBe(true);
    expect(BigInt(stale.rows[0]!.generation))
      .toBeGreaterThan(BigInt(published.rows[0]!.input_dirty_generation));

    // 闸门仍然生效：代次前进且未消费 → 拒绝结账。
    await expect(newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "P1-a 脏输入",
    })).rejects.toThrow(AllocationNotReadyError);

    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId: ent, month, actorType: "SYSTEM", actorAdminId: null,
    });
    expect(enqueued.created).toBe(true);
    // 修复前：短路分支把 input_digest 写回 → 撞 project_allocation_run_published_idem_uq
    // → 一次 runDue 内烧完全部尝试额度转终态 FAILED，dirty 永不消费，账期永久无法结账。
    const second = await runDueAllocationRuns(db, "p1a-worker");
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe("SUCCEEDED");
    expect(second[0]?.error).toBeNull();
    expect(second[0]?.runId).not.toBe(published.rows[0]!.id);

    // no-op 批次：SUCCEEDED 但不占幂等键、不夺 current，既有发布批次继续供读。
    const runs = await sql<{ id: string; status: string; is_current: boolean; input_digest: string | null }>`
      SELECT id, status, is_current, input_digest FROM project_allocation_run
      WHERE enterprise_id = ${ent} AND period_month = '2026-07-01' ORDER BY created_at`.execute(db);
    const succeeded = runs.rows.filter((row) => row.status === "SUCCEEDED");
    expect(succeeded).toHaveLength(2);
    expect(succeeded.filter((row) => row.input_digest !== null)).toHaveLength(1);
    expect(succeeded.filter((row) => row.is_current)).toHaveLength(1);
    expect(succeeded.filter((row) => row.is_current)[0]?.id).toBe(published.rows[0]!.id);

    // 脏代次被消费：清 dirty 标志（闸门按"未消费"判定，不再改写代次）。
    const consumed = await sql<{ generation: string; dirty: boolean }>`
      SELECT generation::text, dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-07-01'`.execute(db);
    expect(consumed.rows[0]?.dirty).toBe(false);
    // 只读状态与闸门同谓词：已消费即不再报告陈旧。
    const statusView = await getAllocationRunStatus(db, ent, month);
    expect(statusView.currentRun?.stale).toBe(false);

    const closed = await newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "P1-a digest 命中后结账",
    });
    expect(closed.status).toBe("CLOSED");
  });

  it("R03-P1：人工指定 A→B→A 输入回到历史状态 → 确定性重发布为 current，close 冻结新批次", async () => {
    // 幂等索引限定 current 维度后：命中历史批次不再等价于"无需发布"，而是
    // "输入回到某个历史状态"，必须重发布为 current，否则 current 批次仍指向 B。
    const month = "2026-05";
    const employee5 = randomUUID();
    const projectA2 = randomUUID();
    const projectB2 = randomUUID();
    await db.insertInto("principal").values([
      { id: employee5, enterprise_id: ent, type: "EMPLOYEE", name: "R03 员工" },
      { id: projectA2, enterprise_id: ent, type: "PROJECT", name: "R03 项目A" },
      { id: projectB2, enterprise_id: ent, type: "PROJECT", name: "R03 项目B" },
    ]).execute();
    const request = await seedLedgerLine(employee5, T("2026-05-12T10:00:00+08:00"), 300_000n, "0.9000");
    const key5 = randomUUID();
    await db.insertInto("principal_key").values([
      { id: key5, enterprise_id: ent, principal_id: employee5, key_prefix: "r03", key_digest: "r03-digest" },
    ]).execute();
    await sql`UPDATE ai_request SET principal_key_id = ${key5} WHERE id = ${request}`.execute(db);
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });

    const publish = async (projectId: string, reason: string): Promise<string> => {
      await newRepo().assignRequestToProject({
        enterpriseId: ent, adminId: admin, month, requestId: request,
        projectPrincipalId: projectId, reason,
      });
      await enqueueAllocationRun(db, { enterpriseId: ent, month, actorType: "SYSTEM", actorAdminId: null });
      const results = await runDueAllocationRuns(db, `r03-${reason}`);
      expect(results[0]?.status, reason).toBe("SUCCEEDED");
      return results[0]!.runId;
    };
    const currentOf = async (): Promise<{ id: string; digest: string | null }> => {
      const { rows } = await sql<{ id: string; digest: string | null }>`
        SELECT id, input_digest AS digest FROM project_allocation_run
        WHERE enterprise_id = ${ent} AND period_month = '2026-05-01' AND is_current`.execute(db);
      return { id: rows[0]!.id, digest: rows[0]!.digest };
    };

    const firstA = await publish(projectA2, "A");
    const digestA = (await currentOf()).digest;
    expect(digestA).not.toBeNull();
    await publish(projectB2, "B");
    expect((await currentOf()).id).not.toBe(firstA);

    // 回到 A：摘要与历史批次相同，但历史批次非 current → 必须重发布为 current。
    const backToA = await publish(projectA2, "A2");
    const currentAfter = await currentOf();
    expect(currentAfter.id).toBe(backToA);
    expect(currentAfter.digest).toBe(digestA);

    const currentSources = await sql<{ sources: string; target: string | null }>`
      SELECT string_agg(DISTINCT l.allocation_source, ',') AS sources,
             MAX(l.target_project_principal_id::text) AS target
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(currentSources.rows[0]?.sources).toBe("MANUAL_ASSIGNMENT");
    expect(currentSources.rows[0]?.target).toBe(projectA2);

    const dirty = await sql<{ dirty: boolean }>`
      SELECT dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-05-01'`.execute(db);
    expect(dirty.rows[0]?.dirty).toBe(false);

    const closed = await newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "R03-P1 回到历史状态后结账",
    });
    expect(closed.status).toBe("CLOSED");
    const frozen = await sql<{ run_id: string }>`
      SELECT r.run_id::text FROM operating_bill_project_allocation_ref r
      JOIN operating_bill_version v ON v.id = r.bill_version_id
      JOIN operating_bill_period p ON p.id = v.period_id
      WHERE p.enterprise_id = ${ent} AND p.period_month = '2026-05-01'`.execute(db);
    expect(frozen.rows[0]?.run_id).toBe(backToA);
  });

  it("R03-P1：no-op 执行期间并发推脏 → 代次守卫不吞标记，闸门拒绝结账", async () => {
    const month = "2026-04";
    await seedLedgerLine(employee1, T("2026-04-09T10:00:00+08:00"), 120_000n, "0.4000");
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    const first = await runDueAllocationRuns(db, "r03c-worker");
    expect(first[0]?.status).toBe("SUCCEEDED");

    // 登记（捕获代次 G）之后、执行之前再推一次脏（G+1）：no-op 的捕获代次已落后，
    // 守卫必须拒绝清除标记 —— 否则并发标记被吞、闸门误判为新鲜。
    await markAllocationDirty(db, ent, [month]);
    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId: ent, month, actorType: "SYSTEM", actorAdminId: null,
    });
    expect(enqueued.created).toBe(true);
    await markAllocationDirty(db, ent, [month]);
    const second = await runDueAllocationRuns(db, "r03c-worker");
    expect(second[0]?.status).toBe("SUCCEEDED");

    const dirty = await sql<{ generation: string; dirty: boolean }>`
      SELECT generation::text, dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-04-01'`.execute(db);
    expect(dirty.rows[0]?.dirty).toBe(true);
    const statusView = await getAllocationRunStatus(db, ent, month);
    expect(statusView.currentRun?.stale).toBe(true);
    await expect(newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "R03-P1 并发推脏结账",
    })).rejects.toThrow(AllocationNotReadyError);
  });

  it("R04-P1 回归：两位数代次边界不退化（bigint 经 pg 返回字符串）", async () => {
    // 构造 captured=9 / generation=10 的跨位边界：裸字符串比较在此处方向反转。
    const month = "2026-02";
    const request = await seedLedgerLine(employee1, T("2026-02-11T10:00:00+08:00"), 60_000n, "0.2000");
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    expect((await runDueAllocationRuns(db, "r04-worker"))[0]?.status).toBe("SUCCEEDED");
    // 内容变更（人工指定）使下一批次必须真实发布，从而让 current 批次捕获到 9。
    await newRepo().assignRequestToProject({
      enterpriseId: ent, adminId: admin, month, requestId: request,
      projectPrincipalId: projectA, reason: "R04 边界内容变更",
    });
    for (let i = 0; i < 7; i += 1) await markAllocationDirty(db, ent, [month]);
    await enqueueAllocationRun(db, { enterpriseId: ent, month, actorType: "SYSTEM", actorAdminId: null });
    expect((await runDueAllocationRuns(db, "r04-worker"))[0]?.status).toBe("SUCCEEDED");
    await markAllocationDirty(db, ent, [month]);
    const state = await sql<{ captured: string; generation: string }>`
      SELECT r.input_dirty_generation::text AS captured, d.generation::text AS generation
      FROM project_allocation_run r, project_allocation_dirty d
      WHERE r.enterprise_id = ${ent} AND r.period_month = '2026-02-01' AND r.is_current
        AND d.enterprise_id = ${ent} AND d.period_month = '2026-02-01'`.execute(db);
    expect(state.rows[0]).toEqual({ captured: "9", generation: "10" });

    // 登记判定 10 > 9：必须新建批次（"9" >= "10" 的字符串比较会误判为已最新而卡死账期）。
    const enqueued = await enqueueAllocationRun(db, {
      enterpriseId: ent, month, actorType: "SYSTEM", actorAdminId: null,
    });
    expect(enqueued.created).toBe(true);
    // 只读状态与闸门同谓词：未消费的脏代次 → stale 且 close 拒绝。
    expect((await getAllocationRunStatus(db, ent, month)).currentRun?.stale).toBe(true);
    await expect(newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "R04-P1 边界结账",
    })).rejects.toThrow(AllocationNotReadyError);
  });

  it("R02-P1 回归：核算窗口变化必须真实重算，不得被幂等短路吞掉（fail-open）", async () => {
    // 摘要未覆盖核算窗口时：先发布规则、后月中开始核算会把同一批行从
    // MEMBERSHIP_RULE 改为待修复未分配（金额量级变化），却被 no-op 跳过 →
    // 代次对齐清脏 → 结账把陈旧归集冻入 ref。摘要纳入核算窗口后必须重算。
    const month = "2026-06";
    const employee4 = randomUUID();
    const project = randomUUID();
    await db.insertInto("principal").values([
      { id: employee4, enterprise_id: ent, type: "EMPLOYEE", name: "R02 员工" },
      { id: project, enterprise_id: ent, type: "PROJECT", name: "R02 无窗口项目" },
    ]).execute();
    const request = await seedLedgerLine(employee4, T("2026-06-10T10:00:00+08:00"), 200_000n, "0.6000");
    const key4 = randomUUID();
    await db.insertInto("principal_key").values([
      { id: key4, enterprise_id: ent, principal_id: employee4, key_prefix: "r02", key_digest: "r02-digest" },
    ]).execute();
    await sql`UPDATE ai_request SET principal_key_id = ${key4} WHERE id = ${request}`.execute(db);
    await createProjectMembership(db, {
      enterpriseId: ent, projectId: project, employeePrincipalId: employee4,
      joinedAt: T("2026-06-01T00:00:00+08:00"), leftAt: null,
      reason: "R02 加入", idempotencyKey: "r02-join", actorAdminId: admin,
    });
    const membership = await sql<{ membership_id: string }>`
      SELECT r.membership_id FROM project_membership_revision r
      JOIN project_membership m ON m.id = r.membership_id
      WHERE r.enterprise_id = ${ent} AND m.employee_principal_id = ${employee4} AND r.status = 'ACTIVE'
      LIMIT 1`.execute(db);
    // 项目此时**没有核算窗口**（合法）：规则照常生效 → 先发布 MEMBERSHIP_RULE。
    await publishEmployeeRules(db, {
      enterpriseId: ent, employeePrincipalId: employee4, actorAdminId: admin,
      reason: "R02 规则", idempotencyKey: "r02-rules", expectedPolicyVersion: 0,
      rules: [{
        projectPrincipalId: project, membershipId: membership.rows[0]!.membership_id,
        weightBps: 10000, validFrom: T("2026-06-01T00:00:00+08:00"), validUntil: null,
      }],
    });
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    const before = await runDueAllocationRuns(db, "r02p1-worker");
    expect(before[0]?.status).toBe("SUCCEEDED");
    const beforeSources = await sql<{ sources: string }>`
      SELECT string_agg(DISTINCT allocation_source, ',') AS sources
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(beforeSources.rows[0]?.sources).toBe("MEMBERSHIP_RULE");

    // 月中开始核算（窗口起点晚于请求时点）→ 该行应变为"规则待修复/未分配"。
    const started = await reviseProjectAccountingLifecycle(db, {
      enterpriseId: ent, projectId: project,
      effectiveAt: T("2026-06-20T00:00:00+08:00"), effectiveAtIsDateOnly: false,
      reason: "R02 月中开始核算", expectedVersion: 0, actorAdminId: admin,
    });
    expect(started.mode).toBe("STARTED");
    expect(started.affectedMonths).toContain(month);

    const tick = await projectAllocationTick(db, "r02p1-worker");
    expect(tick.runsExecuted).toBeGreaterThanOrEqual(1);
    const after = await sql<{ sources: string; reason: string | null; digest: string | null }>`
      SELECT string_agg(DISTINCT allocation_source, ',') AS sources,
             MAX(unallocated_reason) AS reason,
             MAX(r.input_digest) AS digest
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(after.rows[0]?.sources).toBe("UNALLOCATED");
    expect(after.rows[0]?.reason).toBe("RULE_PENDING_REPAIR");

    // 结账冻结的必须是重算后的结果（修复前会冻结陈旧的 MEMBERSHIP_RULE）。
    const closed = await newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "R02-P1 重算后结账",
    });
    expect(closed.status).toBe("CLOSED");
    const frozen = await sql<{ run_id: string }>`
      SELECT r.run_id::text FROM operating_bill_project_allocation_ref r
      JOIN operating_bill_version v ON v.id = r.bill_version_id
      JOIN operating_bill_period p ON p.id = v.period_id
      WHERE p.enterprise_id = ${ent} AND p.period_month = '2026-06-01'`.execute(db);
    const currentRun = await sql<{ id: string }>`
      SELECT id FROM project_allocation_run
      WHERE enterprise_id = ${ent} AND period_month = '2026-06-01' AND is_current`.execute(db);
    expect(frozen.rows[0]?.run_id).toBe(currentRun.rows[0]?.id);
  });
});

describe("80 终审 P1-2：指定批次绑定企业账期", () => {
  it("跨账期 run_id 拒绝；同月历史批次允许且汇总明细同源", async () => {
    const month = "2025-12";
    const otherMonthRun = randomUUID();
    const historicalRun = randomUUID();
    const currentRun = randomUUID();
    for (const [id, day, digest, isCurrent] of [
      [currentRun, "2025-12-01", "d-cur", true],
      [historicalRun, "2025-12-01", "d-hist", false],
      [otherMonthRun, "2025-11-01", "d-nov", false],
    ] as const) {
      await sql`INSERT INTO project_allocation_run
        (id, enterprise_id, period_month, schema_version, algorithm_version, status, generation, actor_type, is_current, input_digest)
      VALUES (${id}::uuid, ${ent}::uuid, ${day}::date, '1', '1', 'SUCCEEDED', 1, 'SYSTEM', ${isCurrent}, ${digest})`.execute(db);
    }

    // 跨账期：统一解析器必须拒绝（旧实现会把 11 月批次混进 12 月响应）。
    await expect(getUnallocatedSummary(db, ent, month, otherMonthRun))
      .rejects.toThrow(AllocationRunNotAccessibleError);
    await expect(listAllocationLines(db, ent, month, projectA, { runId: otherMonthRun, limit: 25, offset: 0 }))
      .rejects.toThrow(AllocationRunNotAccessibleError);

    // 同月历史批次：允许读取，且汇总与明细必须解析到同一个批次。
    const summary = await getUnallocatedSummary(db, ent, month, historicalRun);
    const detail = await listUnallocatedLines(db, ent, month, { runId: historicalRun, limit: 25, offset: 0 });
    expect(summary.runId).toBe(historicalRun);
    expect(detail.runId).toBe(historicalRun);

    // 未指定时取当月 current。
    expect((await getUnallocatedSummary(db, ent, month)).runId).toBe(currentRun);
  });
});

describe("P1-b：人工指定同事务推脏（方案 A）", () => {
  it("assignRequestToProject→脏代次前进→结账被拒→重算为 MANUAL_ASSIGNMENT→结账放行", async () => {
    const month = "2026-10";
    const project = randomUUID();
    const employee3 = randomUUID();
    const projectRule = randomUUID();
    await db.insertInto("principal").values([
      { id: project, enterprise_id: ent, type: "PROJECT", name: "P1-b 人工指定项目" },
      { id: employee3, enterprise_id: ent, type: "EMPLOYEE", name: "P1-b 员工" },
      { id: projectRule, enterprise_id: ent, type: "PROJECT", name: "P1-b 规则项目" },
    ]).execute();
    const request = await seedLedgerLine(employee3, T("2026-10-12T10:00:00+08:00"), 700_000n, "2.1000");
    const key3 = randomUUID();
    await db.insertInto("principal_key").values([
      { id: key3, enterprise_id: ent, principal_id: employee3, key_prefix: "p1b", key_digest: "p1b-digest" },
    ]).execute();
    await sql`UPDATE ai_request SET principal_key_id = ${key3} WHERE id = ${request}`.execute(db);
    // 独立员工的 100% 规则：确保"指定前"确实是规则归集，而不是缺规则导致的未分配。
    await createProjectMembership(db, {
      enterpriseId: ent, projectId: projectRule, employeePrincipalId: employee3,
      joinedAt: T("2026-10-01T00:00:00+08:00"), leftAt: null,
      reason: "P1-b 加入", idempotencyKey: "p1b-join", actorAdminId: admin,
    });
    const membership3 = await sql<{ membership_id: string }>`
      SELECT r.membership_id FROM project_membership_revision r
      JOIN project_membership m ON m.id = r.membership_id
      WHERE r.enterprise_id = ${ent} AND m.employee_principal_id = ${employee3} AND r.status = 'ACTIVE'
      LIMIT 1`.execute(db);
    await publishEmployeeRules(db, {
      enterpriseId: ent, employeePrincipalId: employee3, actorAdminId: admin,
      reason: "P1-b 规则", idempotencyKey: "p1b-rules", expectedPolicyVersion: 0,
      rules: [{
        projectPrincipalId: projectRule, membershipId: membership3.rows[0]!.membership_id,
        weightBps: 10000, validFrom: T("2026-10-01T00:00:00+08:00"), validUntil: null,
      }],
    });
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    const first = await runDueAllocationRuns(db, "p1b-worker");
    expect(first[0]?.status).toBe("SUCCEEDED");
    // 指定前：员工规则把该请求归到 projectA。
    const before = await sql<{ sources: string }>`
      SELECT string_agg(DISTINCT allocation_source, ',') AS sources
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(before.rows[0]?.sources).toContain("MEMBERSHIP_RULE");

    await newRepo().assignRequestToProject({
      enterpriseId: ent, adminId: admin, month, requestId: request,
      projectPrincipalId: project, reason: "P1-b 人工指定",
    });

    // 写入方同事务推脏：不依赖 worker 扫描，也不会有"先提交后补标"的崩溃窗口。
    const dirty = await sql<{ generation: string; dirty: boolean }>`
      SELECT generation::text, dirty FROM project_allocation_dirty
      WHERE enterprise_id = ${ent} AND period_month = '2026-10-01'`.execute(db);
    expect(dirty.rows[0]?.dirty).toBe(true);
    await expect(newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "P1-b 脏输入",
    })).rejects.toThrow(AllocationNotReadyError);

    // 全自动恢复：不点"重建批次"，由 tick 按"已脏且未消费该代次"登记并执行。
    const tick = await projectAllocationTick(db, "p1b-worker");
    expect(tick.runsExecuted).toBeGreaterThanOrEqual(1);
    const after = await sql<{ sources: string; target: string | null }>`
      SELECT string_agg(DISTINCT allocation_source, ',') AS sources,
             MAX(target_project_principal_id::text) AS target
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(after.rows[0]?.sources).toBe("MANUAL_ASSIGNMENT");
    expect(after.rows[0]?.target).toBe(project);

    const closed = await newRepo().closeMonth({
      enterpriseId: ent, adminId: admin, month, allowIncomplete: true, note: "P1-b 重算后结账",
    });
    expect(closed.status).toBe("CLOSED");
  });
});

describe("80 终审 P1-3：修改未来权重后历史月份重算不漂移", () => {
  it("8 月 40% → 9 月改 60%：8 月重算仍按 40% 归集，不落未分配", async () => {
    const month = "2025-10";
    const employee6 = randomUUID();
    const project = randomUUID();
    await db.insertInto("principal").values([
      { id: employee6, enterprise_id: ent, type: "EMPLOYEE", name: "漂移员工" },
      { id: project, enterprise_id: ent, type: "PROJECT", name: "漂移项目" },
    ]).execute();
    const request = await seedLedgerLine(employee6, T("2025-10-15T10:00:00+08:00"), 1_000n, "0.5000");
    const key6 = randomUUID();
    await db.insertInto("principal_key").values([
      { id: key6, enterprise_id: ent, principal_id: employee6, key_prefix: "drift", key_digest: "drift-digest" },
    ]).execute();
    await sql`UPDATE ai_request SET principal_key_id = ${key6} WHERE id = ${request}`.execute(db);
    await createProjectMembership(db, {
      enterpriseId: ent, projectId: project, employeePrincipalId: employee6,
      joinedAt: T("2025-10-01T00:00:00+08:00"), leftAt: null,
      reason: "加入", idempotencyKey: "drift-join", actorAdminId: admin,
    });
    await publishProjectIntent(db, {
      enterpriseId: ent, employeePrincipalId: employee6, projectId: project,
      segments: [{ weightBps: 4000, validFrom: T("2025-10-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: null, reason: "10月起40%", idempotencyKey: "drift-r1", actorAdminId: admin,
    });
    await enableProjectAllocation(db, { enterpriseId: ent, startMonth: month, actorAdminId: admin });
    expect((await runDueAllocationRuns(db, "drift-worker"))[0]?.status).toBe("SUCCEEDED");
    const before = await sql<{ sources: string; share: string; bps: number | null }>`
      SELECT string_agg(DISTINCT l.allocation_source, ',') AS sources,
             MAX(l.share_input_tokens)::text AS share, MAX(l.weight_bps)::int AS bps
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    expect(before.rows[0]?.sources).toBe("MEMBERSHIP_RULE,UNALLOCATED");
    expect(before.rows[0]?.bps).toBe(4000);

    // 修改"未来"权重：11 月起 60%。affectedMonths 会把 10 月推脏并触发重算。
    await publishProjectIntent(db, {
      enterpriseId: ent, employeePrincipalId: employee6, projectId: project,
      segments: [{ weightBps: 6000, validFrom: T("2025-11-01T00:00:00+08:00"), validUntil: null }],
      expectedPolicyVersion: 1, reason: "11月起改60%", idempotencyKey: "drift-r2", actorAdminId: admin,
    });
    // tick 自动登记"已脏未消费"账期并重算（P2-c 路径），无需人工点重建。
    const driftTick = await projectAllocationTick(db, "drift-worker");
    expect(driftTick.runsExecuted).toBeGreaterThanOrEqual(1);
    const after = await sql<{ sources: string; share: string; bps: number | null }>`
      SELECT string_agg(DISTINCT l.allocation_source, ',') AS sources,
             MAX(l.share_input_tokens)::text AS share, MAX(l.weight_bps)::int AS bps
      FROM project_allocation_line l JOIN project_allocation_run r ON r.id = l.run_id
      WHERE r.enterprise_id = ${ent} AND r.is_current AND l.ai_request_id = ${request}`.execute(db);
    // 修复前：当前规则只剩 11 月 60%，10 月行漂移为 NO_EFFECTIVE_RULE 全额未分配。
    expect(after.rows[0]?.sources).toBe("MEMBERSHIP_RULE,UNALLOCATED");
    expect(after.rows[0]?.bps).toBe(4000);
    expect(after.rows[0]?.share).toBe(before.rows[0]?.share);
  });
});
