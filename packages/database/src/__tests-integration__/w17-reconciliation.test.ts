/**
 * database W17 集成测试：对账（重复 0、丢失检测、汇总比对、异常队列）。
 *
 * 用真实账本表验证 ReconciliationRepository：
 *   - 正常账本（W13~W16 闭环产出）→ 对账 PASS（重复 0、丢失 0）
 *   - 手动制造 SETTLEMENT_MISMATCH（改 ledger_transaction.total 不等于 line 聚合）→ REVIEW
 *   - 异常队列：差异落 reconciliation_discrepancy，listOpenDiscrepancies 可查、可流转
 *
 * 依据：TRD 行 870-871（重复 0、丢失<0.1%）、行 857（账本重复/丢失 → 立即停止）。
 *
 * 风格对齐 w15-supply-forecast.test.ts：纯 DB + 真实账本 seed，不走 buildGateway。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, ReconciliationRepository, type Database } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;
let db: Database;
let repo: ReconciliationRepository;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const KEY_ID = randomUUID();
let resourceId: string;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  repo = new ReconciliationRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W17对账" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "员工" }).execute();
  // 真实 principal_key（ai_request.principal_key_id 外键要求）
  await db.insertInto("principal_key").values({
    id: KEY_ID,
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: "qianliu-test",
    key_digest: "test-digest-w17",
    status: "ACTIVE",
  }).execute();
  // 真实 provider + resource（外键要求 provider_resource_id 必须存在）
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "DS 主账号",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  resourceId = resource.id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

/** 构造一个完整闭环的请求：ai_request → attempt → usage_event → ledger_line → ledger_transaction。 */
async function seedCompleteRequest(input: number, output: number): Promise<string> {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const usageId = randomUUID();
  const lineId = randomUUID();
  const now = new Date();

  await db.insertInto("ai_request").values({
    id: requestId,
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    principal_key_id: KEY_ID,
    protocol: "chat",
    unified_model: "qianliu-deepseek",
    stream: false,
    status: "SUCCEEDED",
    started_at: now,
  }).execute();
  await db.insertInto("upstream_attempt").values({
    id: attemptId,
    enterprise_id: ENT_ID,
    ai_request_id: requestId,
    attempt_no: 1,
    provider_resource_id: resourceId,
    upstream_model: "deepseek-chat",
    started_at: now,
    response_committed: true,
  }).execute();
  await db.insertInto("usage_event").values({
    id: usageId,
    enterprise_id: ENT_ID,
    ai_request_id: requestId,
    upstream_attempt_id: attemptId,
    provider_resource_id: resourceId,
    input_tokens: BigInt(input),
    output_tokens: BigInt(output),
    cache_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED",
    dedup_key: `${requestId}:attempt1`,
  }).execute();
  await db.insertInto("ledger_line").values({
    id: lineId,
    enterprise_id: ENT_ID,
    ai_request_id: requestId,
    usage_event_id: usageId,
    upstream_attempt_id: attemptId,
    provider_resource_id: resourceId,
    principal_id: PRINCIPAL_ID,
    resource_mode: "API",
    raw_input_tokens: BigInt(input),
    raw_output_tokens: BigInt(output),
    raw_cache_tokens: 0n,
    api_cost: "0.00100000",
    usage_quality: "PROVIDER_REPORTED",
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId,
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    total_input_tokens: BigInt(input),
    total_output_tokens: BigInt(output),
    total_cache_tokens: 0n,
    total_deducted_quota: 0n,
    total_api_cost: "0.00100000",
    usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1,
    status: "SETTLED",
  }).execute();

  return requestId;
}

describe("W17 对账", () => {
  it("正常账本 → 对账 PASS（重复 0、丢失 0、无汇总不一致）", async () => {
    await seedCompleteRequest(1000, 500);
    await seedCompleteRequest(800, 300);

    const outcome = await repo.runReconciliation({
      enterpriseId: ENT_ID,
      rangeFrom: new Date(Date.now() - 3600_000),
      rangeTo: new Date(Date.now() + 60_000),
    });

    expect(outcome.verdict.result).toBe("PASS");
    expect(outcome.verdict.duplicateCount).toBe(0);
    expect(outcome.verdict.missingCount).toBe(0);
    expect(outcome.verdict.mismatchCount).toBe(0);
    expect(outcome.verdict.duplicateRate).toBe("0.00000000");
  });

  it("SETTLEMENT_MISMATCH：ledger_transaction.total 与 line 聚合不一致 → REVIEW", async () => {
    // 先造一个正常请求，然后手动改 transaction.total 制造不一致
    const requestId = await seedCompleteRequest(600, 200);
    await db
      .updateTable("ledger_transaction")
      .set({ total_input_tokens: 9999n }) // 故意改错，不等于 line 聚合（600）
      .where("ai_request_id", "=", requestId)
      .execute();

    const outcome = await repo.runReconciliation({
      enterpriseId: ENT_ID,
      rangeFrom: new Date(Date.now() - 3600_000),
      rangeTo: new Date(Date.now() + 60_000),
    });

    // 存在 SETTLEMENT_MISMATCH → REVIEW（无重复/丢失）
    expect(outcome.verdict.mismatchCount).toBeGreaterThanOrEqual(1);
    // 可能因前面用例的数据累计，result 至少不是纯 PASS（有 mismatch）
    expect(["REVIEW", "FAIL"]).toContain(outcome.verdict.result);

    // 异常队列：差异已落 reconciliation_discrepancy
    const openDiscrepancies = await repo.listOpenDiscrepancies(ENT_ID);
    expect(openDiscrepancies.length).toBeGreaterThanOrEqual(1);
    const mismatch = openDiscrepancies.find((d) => d.discrepancy_type === "SETTLEMENT_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe("MEDIUM");
    expect(mismatch!.ai_request_id).toBe(requestId);
  });

  it("异常队列流转：OPEN → INVESTIGATING → RESOLVED", async () => {
    const openDiscrepancies = await repo.listOpenDiscrepancies(ENT_ID);
    const target = openDiscrepancies[0]!;
    expect(target.status).toBe("OPEN");

    await repo.updateDiscrepancyStatus(target.id, "INVESTIGATING");
    await repo.updateDiscrepancyStatus(target.id, "RESOLVED", "人工核对确认是测试注入");

    // RESOLVED 后不再出现在 OPEN 队列
    const stillOpen = await repo.listOpenDiscrepancies(ENT_ID);
    expect(stillOpen.find((d) => d.id === target.id)).toBeUndefined();
  });

  it("对账 run 历史保留：多次运行产生多条 run（审计可追溯）", async () => {
    const outcome1 = await repo.runReconciliation({
      enterpriseId: ENT_ID,
      rangeFrom: new Date(Date.now() - 3600_000),
      rangeTo: new Date(),
    });
    const outcome2 = await repo.runReconciliation({
      enterpriseId: ENT_ID,
      rangeFrom: new Date(Date.now() - 3600_000),
      rangeTo: new Date(),
    });
    expect(outcome1.runId).not.toBe(outcome2.runId);

    // 两条 run 都在表里
    const runs = await db
      .selectFrom("reconciliation_run")
      .selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .orderBy("started_at", "desc")
      .execute();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0]!.algorithm_version).toBe("w17-v1");
    expect(runs[0]!.finished_at).not.toBeNull();
  });
});
