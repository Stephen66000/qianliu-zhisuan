import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { migrateToLatest } from "../migrator.js";
import { ensureRequestAttributionSnapshot } from "../repositories/request-attribution-writer.js";
import { UsageAggregateRepository } from "../repositories/usage-aggregate-repository.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let repository: UsageAggregateRepository;

const shanghaiEnterpriseId = randomUUID();
const newYorkEnterpriseId = randomUUID();
const employeeId = randomUUID();
const projectId = randomUUID();
const nyEmployeeId = randomUUID();
const employeeKeyId = randomUUID();
const nyEmployeeKeyId = randomUUID();
const modelId = randomUUID();
let resourceId: string;

interface SeedInput {
  enterpriseId: string;
  principalId: string;
  keyId: string;
  at: Date;
  startedAt?: Date;
  input?: bigint;
  output?: bigint;
  cache?: bigint;
  reasoning?: bigint;
  deducted?: bigint;
  cost?: string;
  withLine?: boolean;
  quality?: string;
}

async function seedSettledRequest(input: SeedInput): Promise<string> {
  const requestId = randomUUID();
  const inputTokens = input.input ?? 10n;
  const outputTokens = input.output ?? 2n;
  const cacheTokens = input.cache ?? 0n;
  const reasoningTokens = input.reasoning ?? 0n;
  const deductedQuota = input.deducted ?? inputTokens + outputTokens;
  const apiCost = input.cost ?? "0.10000000";
  const startedAt = input.startedAt ?? input.at;
  const quality = input.quality ?? "PROVIDER_REPORTED";
  await db.insertInto("ai_request").values({
    id: requestId,
    enterprise_id: input.enterpriseId,
    principal_id: input.principalId,
    principal_key_id: input.keyId,
    protocol: "openai",
    unified_model: input.enterpriseId === shanghaiEnterpriseId ? "ql-aggregate" : "legacy-model",
    unified_model_id: input.enterpriseId === shanghaiEnterpriseId ? modelId : null,
    status: "SUCCEEDED",
    started_at: startedAt,
    finished_at: new Date(startedAt.getTime() + 500),
  }).execute();
  if (input.withLine !== false) {
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId,
      enterprise_id: input.enterpriseId,
      attempt_no: 1,
      provider_resource_id: resourceId,
      upstream_model: "aggregate-upstream",
      finished_at: new Date(input.at.getTime() + 500),
      http_status: 200,
      response_committed: true,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId,
      enterprise_id: input.enterpriseId,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resourceId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_tokens: cacheTokens,
      reasoning_tokens: reasoningTokens,
      usage_quality: quality,
      dedup_key: `aggregate-${requestId}`,
      created_at: input.at,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId,
      enterprise_id: input.enterpriseId,
      usage_event_id: usage.id,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resourceId,
      principal_id: input.principalId,
      resource_mode: "API",
      raw_input_tokens: inputTokens,
      raw_output_tokens: outputTokens,
      raw_cache_tokens: cacheTokens,
      raw_reasoning_tokens: reasoningTokens,
      deducted_quota: deductedQuota,
      api_cost: apiCost,
      usage_quality: quality,
      created_at: input.at,
    }).execute();
  }
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId,
    enterprise_id: input.enterpriseId,
    principal_id: input.principalId,
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    total_cache_tokens: cacheTokens,
    total_reasoning_tokens: reasoningTokens,
    total_deducted_quota: deductedQuota,
    total_api_cost: apiCost,
    usage_quality: quality,
    attempt_count: input.withLine === false ? 0 : 1,
    status: "SETTLED",
    created_at: input.at,
  }).execute();
  return requestId;
}

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_usage_aggregate_test");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  repository = new UsageAggregateRepository(db);

  await db.insertInto("enterprise").values([
    { id: shanghaiEnterpriseId, name: "上海聚合企业", timezone: "Asia/Shanghai" },
    { id: newYorkEnterpriseId, name: "纽约聚合企业", timezone: "America/New_York" },
  ]).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: shanghaiEnterpriseId, type: "EMPLOYEE", name: "聚合员工" },
    { id: projectId, enterprise_id: shanghaiEnterpriseId, type: "PROJECT", name: "聚合项目" },
    { id: nyEmployeeId, enterprise_id: newYorkEnterpriseId, type: "EMPLOYEE", name: "DST 员工" },
  ]).execute();
  await db.insertInto("principal_key").values([
    { id: employeeKeyId, enterprise_id: shanghaiEnterpriseId, principal_id: employeeId,
      key_prefix: "agg-sh", key_digest: randomUUID(), allowed_model_ids: [] },
    { id: nyEmployeeKeyId, enterprise_id: newYorkEnterpriseId, principal_id: nyEmployeeId,
      key_prefix: "agg-ny", key_digest: randomUUID(), allowed_model_ids: [] },
  ]).execute();
  await db.insertInto("unified_model").values({
    id: modelId,
    enterprise_id: shanghaiEnterpriseId,
    alias: "ql-aggregate",
    display_name: "聚合模型",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: shanghaiEnterpriseId,
    code: "aggregate-provider",
    name: "聚合厂商",
    adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  resourceId = (await db.insertInto("provider_resource").values({
    enterprise_id: shanghaiEnterpriseId,
    provider_id: provider.id,
    name: "聚合 API",
    mode: "API",
    credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow()).id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W20-04 UsageAggregateRepository", () => {
  it("完整小时桶幂等 upsert，重放不累计且真实 Token 不含缓存", async () => {
    const requestId = await seedSettledRequest({
      enterpriseId: shanghaiEnterpriseId,
      principalId: employeeId,
      keyId: employeeKeyId,
      at: new Date("2026-08-12T01:25:00.000Z"),
      input: 100n,
      output: 20n,
      cache: 50n,
      reasoning: 5n,
      deducted: 120n,
      cost: "1.25000000",
    });
    await db.insertInto("request_attribution_snapshot").values({
      enterprise_id: shanghaiEnterpriseId,
      ai_request_id: requestId,
      source_principal_id: employeeId,
      project_principal_id: null,
      cost_category: "UNASSIGNED",
      attribution_source: "UNASSIGNED",
      request_occurred_at: new Date("2026-08-12T01:25:00.000Z"),
      version: 1,
      snapshot_origin: "RUNTIME",
    }).execute();
    await repository.markRequestDirty(shanghaiEnterpriseId, requestId);
    const bucket = (await repository.listDirtyBuckets("HOUR"))
      .find((item) => item.enterpriseId === shanghaiEnterpriseId)!;
    expect(bucket.bucketStart.toISOString()).toBe("2026-08-12T01:00:00.000Z");

    await repository.rebuildBucket(bucket);
    const first = await db.selectFrom("usage_bucket_aggregate").selectAll()
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_granularity", "=", "HOUR")
      .where("bucket_start", "=", bucket.bucketStart)
      .executeTakeFirstOrThrow();
    expect(first).toMatchObject({
      source_principal_id: employeeId,
      project_principal_id: null,
      provider_resource_id: resourceId,
      unified_model_id: modelId,
      request_count: "1",
      input_tokens: "100",
      output_tokens: "20",
      cache_tokens: "50",
      reasoning_tokens: "5",
      deducted_quota: "120",
      api_cost: "1.25000000",
      dirty: false,
    });
    expect(BigInt(first.input_tokens) + BigInt(first.output_tokens)).toBe(120n);
    expect(first.max_fact_at?.toISOString()).toBe("2026-08-12T01:25:00.000Z");

    await repository.markRequestDirty(shanghaiEnterpriseId, requestId);
    await repository.rebuildBucket(bucket);
    const replay = await db.selectFrom("usage_bucket_aggregate").selectAll()
      .where("id", "=", first.id).executeTakeFirstOrThrow();
    expect(replay.id).toBe(first.id);
    expect(replay.request_count).toBe("1");
    expect(BigInt(replay.input_tokens) + BigInt(replay.output_tokens)).toBe(120n);
    expect(await repository.listDirtyBuckets("HOUR")).not.toContainEqual(bucket);
  });

  it("归属修正后完整重算替换项目维度，不残留旧行", async () => {
    const request = await db.selectFrom("request_attribution_snapshot")
      .select(["ai_request_id", "id", "request_occurred_at"])
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("source_principal_id", "=", employeeId)
      .orderBy("created_at", "asc")
      .executeTakeFirstOrThrow();
    await db.insertInto("request_attribution_snapshot").values({
      enterprise_id: shanghaiEnterpriseId,
      ai_request_id: request.ai_request_id,
      source_principal_id: employeeId,
      project_principal_id: projectId,
      cost_category: "UNASSIGNED",
      attribution_source: "UNASSIGNED",
      request_occurred_at: request.request_occurred_at,
      version: 2,
      supersedes_id: request.id,
      snapshot_origin: "CORRECTION",
    }).execute();
    await repository.markRequestDirty(shanghaiEnterpriseId, request.ai_request_id);
    const bucket = (await repository.listDirtyBuckets("HOUR"))
      .find((item) => item.enterpriseId === shanghaiEnterpriseId)!;
    const result = await repository.rebuildBucket(bucket);
    expect(result.rowsRemoved).toBe(1);
    const rows = await db.selectFrom("usage_bucket_aggregate")
      .select(["project_principal_id", "request_count"])
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_granularity", "=", "HOUR")
      .where("bucket_start", "=", bucket.bucketStart)
      .execute();
    expect(rows).toEqual([{ project_principal_id: projectId, request_count: "1" }]);
  });

  it("重建与后到归属 dirty 标记并发时不丢失且不重复累计", async () => {
    const row = await db.selectFrom("usage_bucket_aggregate")
      .select(["id", "bucket_start", "timezone", "source_principal_id"])
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_granularity", "=", "HOUR")
      .where("source_principal_id", "=", employeeId)
      .orderBy("bucket_start", "asc")
      .executeTakeFirstOrThrow();
    const request = await db.selectFrom("ledger_transaction")
      .select("ai_request_id")
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("principal_id", "=", row.source_principal_id)
      .orderBy("created_at", "asc")
      .executeTakeFirstOrThrow();
    let releaseBlocker!: () => void;
    let blockerLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { blockerLocked = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("usage_bucket_aggregate").select("id")
        .where("id", "=", row.id).forUpdate().executeTakeFirstOrThrow();
      blockerLocked();
      await release;
    });
    await locked;

    const separator = pg.connectionString.includes("?") ? "&" : "?";
    const rebuildDb = createKysely(`${pg.connectionString}${separator}application_name=usage_rebuild_race`);
    try {
      const rebuild = new UsageAggregateRepository(rebuildDb).rebuildBucket({
        enterpriseId: shanghaiEnterpriseId,
        bucketGranularity: "HOUR",
        bucketStart: row.bucket_start,
        timezone: row.timezone,
      });
      await waitForBlockedRebuild();
      await repository.markRequestDirty(shanghaiEnterpriseId, request.ai_request_id);
      releaseBlocker();
      await Promise.all([blocker, rebuild]);

      const dirty = await repository.listDirtyBuckets("HOUR");
      expect(dirty).toContainEqual({
        enterpriseId: shanghaiEnterpriseId,
        bucketGranularity: "HOUR",
        bucketStart: row.bucket_start,
        timezone: row.timezone,
      });
      await repository.rebuildBucket(dirty.find((item) =>
        item.enterpriseId === shanghaiEnterpriseId
          && item.bucketStart.getTime() === row.bucket_start.getTime())!);
      const aggregate = await db.selectFrom("usage_bucket_aggregate")
        .select(["request_count", "input_tokens", "output_tokens"])
        .where("id", "=", row.id).executeTakeFirstOrThrow();
      expect(aggregate).toEqual({ request_count: "1", input_tokens: "100", output_tokens: "20" });
    } finally {
      releaseBlocker();
      await blocker;
      await rebuildDb.destroy();
    }
  });

  it("Settlement 归属写入在同事务显式标记小时与日桶", async () => {
    const requestId = await seedSettledRequest({
      enterpriseId: shanghaiEnterpriseId,
      principalId: employeeId,
      keyId: employeeKeyId,
      at: new Date("2026-08-13T03:15:00.000Z"),
      withLine: false,
    });
    await db.transaction().execute(async (trx) => {
      await ensureRequestAttributionSnapshot(trx, shanghaiEnterpriseId, requestId);
    });
    const dirty = await db.selectFrom("usage_aggregate_dirty_bucket")
      .select(["bucket_granularity", "bucket_start"])
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_start", ">=", new Date("2026-08-12T16:00:00.000Z"))
      .orderBy("bucket_granularity", "asc")
      .execute();
    expect(dirty.map((row) => [row.bucket_granularity, row.bucket_start.toISOString()]))
      .toEqual([
        ["DAY", "2026-08-12T16:00:00.000Z"],
        ["HOUR", "2026-08-13T03:00:00.000Z"],
      ]);
  });

  it("POOL20-045：月末开始、次月结算按结算时间入桶且重放不重复", async () => {
    const requestId = await seedSettledRequest({
      enterpriseId: shanghaiEnterpriseId,
      principalId: employeeId,
      keyId: employeeKeyId,
      startedAt: new Date("2026-08-31T15:59:30.000Z"),
      at: new Date("2026-09-01T00:10:00.000Z"),
      input: 33n, output: 7n, quality: "ACCOUNT_AGGREGATED", withLine: false,
    });
    await repository.markRequestDirty(shanghaiEnterpriseId, requestId);
    await repository.markRequestDirty(shanghaiEnterpriseId, requestId);
    const dirty = (await repository.listDirtyBuckets("HOUR")).filter((item) =>
      item.enterpriseId === shanghaiEnterpriseId
        && item.bucketStart.getTime() === new Date("2026-09-01T00:00:00.000Z").getTime());
    expect(dirty).toHaveLength(1);
    await repository.rebuildBucket(dirty[0]!);
    const aggregate = await db.selectFrom("usage_bucket_aggregate")
      .select(["request_count", "input_tokens", "output_tokens", "account_aggregated_count"])
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_granularity", "=", "HOUR")
      .where("bucket_start", "=", new Date("2026-09-01T00:00:00.000Z"))
      .executeTakeFirstOrThrow();
    expect(aggregate).toEqual({
      request_count: "1", input_tokens: "33", output_tokens: "7",
      account_aggregated_count: "1",
    });
    expect(await db.selectFrom("usage_bucket_aggregate").select("id")
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_start", "=", new Date("2026-08-31T15:00:00.000Z"))
      .executeTakeFirst()).toBeUndefined();
  });

  it("纽约 DST 回拨保留两个 01 时桶，春季自然日只有 23 个小时桶", async () => {
    const first = await seedSettledRequest({
      enterpriseId: newYorkEnterpriseId,
      principalId: nyEmployeeId,
      keyId: nyEmployeeKeyId,
      at: new Date("2026-11-01T05:30:00.000Z"),
      input: 10n,
      output: 1n,
      cost: "0.1",
      withLine: false,
    });
    const second = await seedSettledRequest({
      enterpriseId: newYorkEnterpriseId,
      principalId: nyEmployeeId,
      keyId: nyEmployeeKeyId,
      at: new Date("2026-11-01T06:30:00.000Z"),
      input: 20n,
      output: 2n,
      cost: "0.2",
      withLine: false,
    });
    await repository.markRequestDirty(newYorkEnterpriseId, first);
    await repository.markRequestDirty(newYorkEnterpriseId, second);
    const dirtyHours = (await repository.listDirtyBuckets("HOUR"))
      .filter((item) => item.enterpriseId === newYorkEnterpriseId);
    expect(dirtyHours.map((item) => item.bucketStart.toISOString())).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
    ]);

    const fall = await repository.rebuildRange({
      enterpriseId: newYorkEnterpriseId,
      from: new Date("2026-11-01T04:00:00.000Z"),
      to: new Date("2026-11-02T05:00:00.000Z"),
    });
    expect(fall.hourBuckets).toBe(25);
    expect(fall.dayBuckets).toBe(1);
    const day = await db.selectFrom("usage_bucket_aggregate")
      .select(["request_count", "input_tokens", "output_tokens"])
      .where("enterprise_id", "=", newYorkEnterpriseId)
      .where("bucket_granularity", "=", "DAY")
      .where("bucket_start", "=", new Date("2026-11-01T04:00:00.000Z"))
      .executeTakeFirstOrThrow();
    expect(day).toEqual({ request_count: "2", input_tokens: "30", output_tokens: "3" });

    const spring = await repository.rebuildRange({
      enterpriseId: newYorkEnterpriseId,
      from: new Date("2026-03-08T05:00:00.000Z"),
      to: new Date("2026-03-09T04:00:00.000Z"),
    });
    expect(spring.hourBuckets).toBe(23);
    expect(spring.dayBuckets).toBe(1);
  });

  it("定时保鲜当前空小时，每日补算范围同时产生 HOUR/DAY 空桶水位", async () => {
    const now = new Date("2026-08-12T00:30:00.000Z");
    expect(await repository.markCurrentHoursDirty(now)).toBe(2);
    const currentDirty = await repository.listDirtyBuckets("HOUR");
    expect(currentDirty).toEqual(expect.arrayContaining([
      expect.objectContaining({
        enterpriseId: shanghaiEnterpriseId,
        bucketStart: new Date("2026-08-12T00:00:00.000Z"),
      }),
      expect.objectContaining({
        enterpriseId: newYorkEnterpriseId,
        bucketStart: new Date("2026-08-12T00:00:00.000Z"),
      }),
    ]));

    const rebuilt = await repository.rebuildRecentSevenDays(now, 1);
    expect(rebuilt.some((item) => item.bucketGranularity === "HOUR")).toBe(true);
    expect(rebuilt.some((item) => item.bucketGranularity === "DAY")).toBe(true);
    const emptyState = await db.selectFrom("usage_aggregate_bucket_state")
      .select(["fact_watermark", "max_fact_at"])
      .where("enterprise_id", "=", shanghaiEnterpriseId)
      .where("bucket_granularity", "=", "HOUR")
      .where("bucket_start", "=", new Date("2026-08-12T00:00:00.000Z"))
      .executeTakeFirstOrThrow();
    expect(emptyState).toEqual({ fact_watermark: null, max_fact_at: null });
  });
});

async function waitForBlockedRebuild(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const query = await sql<{ wait_event_type: string | null }>`
      SELECT wait_event_type
        FROM pg_stat_activity
       WHERE application_name = 'usage_rebuild_race'
       ORDER BY backend_start DESC
       LIMIT 1
    `.execute(db);
    const activity = query.rows[0];
    if (activity?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("usage aggregate rebuild did not reach the expected row lock");
}
