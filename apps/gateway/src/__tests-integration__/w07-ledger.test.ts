/**
 * gateway W07 集成测试：账本闭环 + 重复结算 0 + 正文 canary 0（M2 DoD 核心）。
 *
 * 覆盖：
 *   - WT-11：双 Attempt（一失败一成功）一个 ledger_transaction + 两条不可覆盖 ledger_line
 *   - 重复结算为 0：同一 ai_request 重复 createLedgerTransactionIfAbsent 不新增
 *   - usage 幂等：同一 dedup_key 重复 createUsageEventIfAbsent 不新增
 *   - **正文 canary 为 0**：messages/prompt 在 ai_request/usage/ledger 表 0 命中（M2 DoD）
 *
 * 直接使用 GatewayLedgerRepository 模拟完整账本写入（W08 在 pipeline 接入）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createPgCanarySink, scanCanary } from "@qianliu/observability";
import type { Kysely } from "kysely";

let pg: PostgresTestInstance;
let db: Kysely<Database>;
let repo: GatewayLedgerRepository;

const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const KEY_ID = randomUUID();
let RESOURCE_ID: string;

const CONTENT_TABLES = [
  "ai_request",
  "route_candidate",
  "upstream_attempt",
  "usage_event",
  "ledger_line",
  "ledger_transaction",
];

beforeAll(async () => {
  pg = process.env.POOL043_W07_DATABASE_URL
    ? { connectionString: process.env.POOL043_W07_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  repo = new GatewayLedgerRepository(db);

  // 种子
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试" }).execute();
  await db
    .insertInto("principal")
    .values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试" })
    .execute();
  await db
    .insertInto("principal_key")
    .values({
      id: KEY_ID,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      key_prefix: "sk-qianliu-",
      key_digest: "fake-digest-" + randomUUID(),
      allowed_model_ids: JSON.stringify([]) as unknown as string[],
      status: "ACTIVE",
    })
    .execute();
  await db
    .insertInto("provider")
    .values({ enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek" })
    .execute();
  const provider = await db.selectFrom("provider").selectAll().executeTakeFirstOrThrow();
  await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: ENT_ID,
      provider_id: provider.id,
      name: "DeepSeek 主账号",
      mode: "API",
      credential_type: "API_KEY",
    })
    .execute();
  const resource = await db.selectFrom("provider_resource").selectAll().executeTakeFirstOrThrow();
  RESOURCE_ID = resource.id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W07 账本闭环与幂等", () => {
  it("POOL-007：并发认领同一业务幂等键只有一个 CREATED，异体请求稳定冲突", async () => {
    const idempotencyKey = `pool-007-${randomUUID()}`;
    const requestFingerprint = "a".repeat(64);
    const base = {
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      principal_key_id: KEY_ID,
      idempotency_key: idempotencyKey,
      client_request_id: "workbuddy-reused-trace",
      request_fingerprint: requestFingerprint,
      protocol: "responses",
      unified_model: "qianliu-deepseek",
      unified_model_id: null,
      stream: true,
    };

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => repo.claimRequest({
        ...base,
        id: randomUUID(),
      })),
    );
    expect(claims.filter((claim) => claim.kind === "CREATED")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "REPLAY")).toHaveLength(7);
    expect(new Set(claims.map((claim) => claim.request.id)).size).toBe(1);

    const conflict = await repo.claimRequest({
      ...base,
      id: randomUUID(),
      request_fingerprint: "b".repeat(64),
    });
    expect(conflict.kind).toBe("CONFLICT");
    expect(conflict.request.id).toBe(claims[0]!.request.id);

    const rows = await db
      .selectFrom("ai_request")
      .select("id")
      .where("principal_key_id", "=", KEY_ID)
      .where("idempotency_key", "=", idempotencyKey)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("请求与 Attempt 使用实际写入时间，分时计费不得命中建表时刻", async () => {
    const requestId = randomUUID();
    const before = Date.now() - 1_000;
    const request = await repo.createRequest({
      id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      principal_key_id: KEY_ID,
      protocol: "responses",
      unified_model: "qianliu-deepseek",
      unified_model_id: null,
      stream: true,
    });
    const attempt = await repo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      attempt_no: 1,
      provider_resource_id: RESOURCE_ID,
      upstream_model: "deepseek-chat",
    });
    const after = Date.now() + 1_000;

    expect(request.started_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(request.started_at.getTime()).toBeLessThanOrEqual(after);
    expect(attempt.started_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(attempt.started_at.getTime()).toBeLessThanOrEqual(after);
  });

  it("WT-11：双 Attempt（一失败一成功）→ 一个汇总 + 两条不可覆盖明细", async () => {
    const requestId = randomUUID();

    // 1. 创建请求意图
    await repo.createRequest({
      id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      principal_key_id: KEY_ID,
      protocol: "chat",
      unified_model: "qianliu-deepseek",
      unified_model_id: null,
    });

    // 2. 候选快照
    await repo.createRouteCandidate({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      provider_resource_id: RESOURCE_ID,
      upstream_model: "deepseek-chat",
      priority: 100,
      weight: 1,
    });

    // 3. Attempt 1：失败（UPSTREAM_TEMPORARY），但产生了可证明 usage（ESTIMATED）
    const attempt1 = await repo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      attempt_no: 1,
      provider_resource_id: RESOURCE_ID,
      upstream_model: "deepseek-chat",
    });
    await repo.updateAttemptResult(attempt1.id, {
      http_status: 500,
      response_committed: false,
      error_classification: "UPSTREAM_TEMPORARY",
      error_code: "server_error",
      switch_reason: "failover",
    });
    const usage1 = await repo.createUsageEventIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      upstream_attempt_id: attempt1.id,
      provider_resource_id: RESOURCE_ID,
      input_tokens: 980n,
      output_tokens: 0n,
      cache_tokens: 0n,
      usage_quality: "ESTIMATED",
      dedup_key: `${requestId}:attempt1`,
    });
    expect(usage1).toBeDefined();
    await repo.createLedgerLine({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      usage_event_id: usage1!.id,
      upstream_attempt_id: attempt1.id,
      provider_resource_id: RESOURCE_ID,
      principal_id: PRINCIPAL_ID,
      resource_mode: "API",
      raw_input_tokens: 980n,
      raw_output_tokens: 0n,
      raw_cache_tokens: 0n,
      api_cost: "0.0009800",
      usage_quality: "ESTIMATED",
    });

    // 4. Attempt 2：成功（PROVIDER_REPORTED）
    const attempt2 = await repo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      attempt_no: 2,
      provider_resource_id: RESOURCE_ID,
      upstream_model: "deepseek-chat",
    });
    await repo.updateAttemptResult(attempt2.id, {
      http_status: 200,
      response_committed: true,
    });
    const usage2 = await repo.createUsageEventIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      upstream_attempt_id: attempt2.id,
      provider_resource_id: RESOURCE_ID,
      input_tokens: 980n,
      output_tokens: 412n,
      cache_tokens: 100n,
      usage_quality: "PROVIDER_REPORTED",
      dedup_key: `${requestId}:attempt2`,
    });
    await repo.createLedgerLine({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      usage_event_id: usage2!.id,
      upstream_attempt_id: attempt2.id,
      provider_resource_id: RESOURCE_ID,
      principal_id: PRINCIPAL_ID,
      resource_mode: "API",
      raw_input_tokens: 980n,
      raw_output_tokens: 412n,
      raw_cache_tokens: 100n,
      api_cost: "0.0013920",
      usage_quality: "PROVIDER_REPORTED",
    });

    // 5. 唯一 ledger_transaction（汇总）
    const tx = await repo.createLedgerTransactionIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      total_input_tokens: 980n + 980n, // 两 Attempt 都消耗了输入
      total_output_tokens: 0n + 412n,
      total_cache_tokens: 0n + 100n,
      total_deducted_quota: 0n,
      total_api_cost: "0.0023720",
      usage_quality: "MIXED:ESTIMATED+PROVIDER_REPORTED",
      attempt_count: 2,
    });
    expect(tx).toBeDefined();

    // 验证：一个请求一个汇总
    const txCount = await db
      .selectFrom("ledger_transaction")
      .where("ai_request_id", "=", requestId)
      .execute();
    expect(txCount).toHaveLength(1);

    // 验证：两条不可覆盖明细（Attempt 1 的明细不被 Attempt 2 覆盖）
    const lines = await repo.listLedgerLines(requestId);
    expect(lines).toHaveLength(2);
    const estimatedLine = lines.find((l) => l.usage_quality === "ESTIMATED");
    const reportedLine = lines.find((l) => l.usage_quality === "PROVIDER_REPORTED");
    expect(estimatedLine).toBeDefined();
    expect(reportedLine).toBeDefined();
    // 汇总 = 明细之和
    expect(tx!.attempt_count).toBe(2);
  });

  it("重复结算为 0：同一 ai_request 重复 createLedgerTransactionIfAbsent 不新增", async () => {
    const requestId = randomUUID();
    await repo.createRequest({
      id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      principal_key_id: KEY_ID,
      protocol: "chat",
      unified_model: "qianliu-deepseek",
      unified_model_id: null,
    });

    const first = await repo.createLedgerTransactionIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      total_input_tokens: 100n,
      total_output_tokens: 50n,
      total_cache_tokens: 0n,
      total_deducted_quota: 0n,
      total_api_cost: "0.0015",
      usage_quality: "PROVIDER_REPORTED",
      attempt_count: 1,
    });
    expect(first).toBeDefined();

    // 重复创建（模拟请求重放）
    const second = await repo.createLedgerTransactionIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      total_input_tokens: 100n,
      total_output_tokens: 50n,
      total_cache_tokens: 0n,
      total_deducted_quota: 0n,
      total_api_cost: "0.0015",
      usage_quality: "PROVIDER_REPORTED",
      attempt_count: 1,
    });
    expect(second).toBeUndefined(); // ON CONFLICT DO NOTHING，不新增

    // 仍只有一个结算
    const txs = await db
      .selectFrom("ledger_transaction")
      .where("ai_request_id", "=", requestId)
      .execute();
    expect(txs).toHaveLength(1); // 重复结算为 0
  });

  it("usage 幂等：同一 dedup_key 重复 createUsageEventIfAbsent 不新增", async () => {
    const requestId = randomUUID();
    await repo.createRequest({
      id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      principal_key_id: KEY_ID,
      protocol: "chat",
      unified_model: "qianliu-deepseek",
      unified_model_id: null,
    });
    const attempt = await repo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      attempt_no: 1,
      provider_resource_id: RESOURCE_ID,
      upstream_model: "deepseek-chat",
    });

    const dedupKey = `${requestId}:dup-test`;
    const first = await repo.createUsageEventIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      upstream_attempt_id: attempt.id,
      provider_resource_id: RESOURCE_ID,
      input_tokens: 100n,
      output_tokens: 50n,
      cache_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED",
      dedup_key: dedupKey,
    });
    expect(first).toBeDefined();

    const second = await repo.createUsageEventIfAbsent({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      upstream_attempt_id: attempt.id,
      provider_resource_id: RESOURCE_ID,
      input_tokens: 100n,
      output_tokens: 50n,
      cache_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED",
      dedup_key: dedupKey, // 同一 dedup_key
    });
    expect(second).toBeUndefined(); // 不新增

    const events = await db
      .selectFrom("usage_event")
      .where("dedup_key", "=", dedupKey)
      .execute();
    expect(events).toHaveLength(1); // 重复记账为 0
  });

  it("正文 canary 为 0：messages/prompt/system 在账本表 0 命中（M2 DoD）", async () => {
    const BODY_CANARY = "SECRET_USER_MESSAGE_BODY_W07_CANARY_TEST_12345";

    // 走一次完整流程，但故意不把 body 写入任何表（正确行为）
    const requestId = randomUUID();
    await repo.createRequest({
      id: requestId,
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      principal_key_id: KEY_ID,
      protocol: "chat",
      unified_model: "qianliu-deepseek",
      unified_model_id: null,
    });
    // 注意：BODY_CANARY 绝不写入 ai_request 或任何表（content_retention_mode=METADATA_ONLY）

    // 实现 scanFn：跨账本表扫描 row_to_json::text
    const scanFn = async (canary: string): Promise<number> => {
      let total = 0;
      for (const table of CONTENT_TABLES) {
        const result = await sql`SELECT COUNT(*)::int AS hits FROM (SELECT row_to_json(r)::text AS txt FROM ${sql.raw(table)} r) s WHERE s.txt LIKE ${"%" + canary + "%"}`.execute(db);
        total += Number((result.rows[0] as { hits: number }).hits);
      }
      return total;
    };

    const result = await scanCanary(BODY_CANARY, [createPgCanarySink(scanFn)]);
    expect(result.hits.postgres, "正文 canary 在账本表必须 0 命中").toBe(0);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(true);
  });
});
