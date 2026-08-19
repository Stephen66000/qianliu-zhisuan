import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator } from "../migrator.js";
import { UsageAggregateRepository } from "../repositories/usage-aggregate-repository.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

const enterpriseId = "91000000-0000-4000-8000-000000000001";
const adminId = "91000000-0000-4000-8000-000000000002";
const principalId = "91000000-0000-4000-8000-000000000003";
const keyId = "91000000-0000-4000-8000-000000000004";
const providerId = "91000000-0000-4000-8000-000000000005";
const resourceId = "91000000-0000-4000-8000-000000000006";

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_0054_capacity");
  db = createKysely(pg.connectionString);
  const migrated = await createMigrator(db).migrateTo("0053_operating_bill_opening_balance");
  if (migrated.error) throw migrated.error;
  await db.insertInto("enterprise").values({
    id: enterpriseId, name: "0054 百万存量企业", timezone: "Asia/Shanghai",
  }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "migration-capacity",
    password_hash: "unused",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "容量员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "migration-capacity", key_digest: "migration-capacity", allowed_model_ids: [],
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "migration-capacity",
    name: "容量厂商", adapter_type: "openai",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: "容量 API", mode: "API", credential_type: "API_KEY",
  }).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("POOL20-045 0054 百万存量迁移", () => {
  it("失败整体回滚；百万 ledger/usage_event 迁移受控生成 dirty 并可恢复读模型", async () => {
    await seedFacts(1);
    await sql`
      CREATE FUNCTION reject_0054_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '0054 injected dirty failure'; END; $$;
    `.execute(db);
    await sql`CREATE TRIGGER reject_0054_dirty BEFORE INSERT ON usage_aggregate_dirty_bucket
        FOR EACH ROW EXECUTE FUNCTION reject_0054_dirty()`.execute(db);
    const failed = await createMigrator(db).migrateToLatest();
    expect(failed.error).toBeDefined();
    const failedHead = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1
    `.execute(db);
    expect(failedHead.rows[0]?.name).toBe("0053_operating_bill_opening_balance");
    const oldConstraint = await qualityConstraint();
    expect(oldConstraint.definition).not.toContain("MIXED");
    await sql`DROP TRIGGER reject_0054_dirty ON usage_aggregate_dirty_bucket`.execute(db);
    await sql`DROP FUNCTION reject_0054_dirty()`.execute(db);

    await db.deleteFrom("ledger_transaction").where("enterprise_id", "=", enterpriseId).execute();
    await db.deleteFrom("usage_event").where("enterprise_id", "=", enterpriseId).execute();
    await db.deleteFrom("upstream_attempt").where("enterprise_id", "=", enterpriseId).execute();
    await db.deleteFrom("ai_request").where("enterprise_id", "=", enterpriseId).execute();
    await seedFacts(1_000_000);

    const started = performance.now();
    const migrated = await createMigrator(db).migrateToLatest();
    const elapsedMs = performance.now() - started;
    expect(migrated.error).toBeUndefined();
    expect(elapsedMs).toBeLessThan(120_000);
    expect((await qualityConstraint()).definition).toContain("MIXED");
    const facts = await sql<{ ledger: string; usage: string; dirty: string; aggregate: string; state: string }>`
      SELECT (SELECT count(*)::text FROM ledger_transaction WHERE enterprise_id = ${enterpriseId}) AS ledger,
             (SELECT count(*)::text FROM usage_event WHERE enterprise_id = ${enterpriseId}) AS usage,
             (SELECT count(*)::text FROM usage_aggregate_dirty_bucket WHERE enterprise_id = ${enterpriseId}) AS dirty,
             (SELECT count(*)::text FROM usage_bucket_aggregate WHERE enterprise_id = ${enterpriseId}) AS aggregate,
             (SELECT count(*)::text FROM usage_aggregate_bucket_state WHERE enterprise_id = ${enterpriseId}) AS state
    `.execute(db);
    expect(facts.rows[0]).toEqual({
      ledger: "1000000", usage: "1000000", dirty: "776", aggregate: "0", state: "0",
    });

    const repository = new UsageAggregateRepository(db);
    let rebuilt = 0;
    for (const granularity of ["HOUR", "DAY"] as const) {
      while (true) {
        const batch = await repository.rebuildDirtyBuckets(granularity, 1_000);
        rebuilt += batch.length;
        if (batch.length === 0) break;
      }
    }
    expect(rebuilt).toBe(776);
    const restored = await sql<{ dirty: string; aggregate: string; state: string }>`
      SELECT (SELECT count(*)::text FROM usage_aggregate_dirty_bucket WHERE enterprise_id = ${enterpriseId}) AS dirty,
             (SELECT count(*)::text FROM usage_bucket_aggregate WHERE enterprise_id = ${enterpriseId}) AS aggregate,
             (SELECT count(*)::text FROM usage_aggregate_bucket_state WHERE enterprise_id = ${enterpriseId}) AS state
    `.execute(db);
    expect(restored.rows[0]).toEqual({ dirty: "0", aggregate: "776", state: "776" });

    const emptyAt = new Date("2027-01-01T00:30:00.000Z");
    await repository.markCurrentHoursDirty(emptyAt);
    const emptyBucket = (await repository.listDirtyBuckets("HOUR", 1_000))
      .find((row) => row.enterpriseId === enterpriseId && row.bucketStart < emptyAt);
    expect(emptyBucket).toBeDefined();
    await repository.rebuildBucket(emptyBucket!);
    expect(await db.selectFrom("usage_aggregate_bucket_state").select("bucket_start")
      .where("enterprise_id", "=", enterpriseId)
      .where("bucket_start", "=", emptyBucket!.bucketStart).executeTakeFirst()).toBeDefined();

    process.stdout.write(`${JSON.stringify({
      event: "usage_aggregate_0054_capacity", ledger_rows: 1_000_000,
      usage_event_rows: 1_000_000, migration_ms: Math.round(elapsedMs),
      dirty_buckets: 776, rebuild_batch_limit: 1_000,
    })}\n`);
  }, 600_000);
});

async function qualityConstraint() {
  const result = await sql<{ definition: string }>`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conname = 'usage_event_quality_check'
  `.execute(db);
  return result.rows[0]!;
}

async function seedFacts(count: number) {
  await sql`
    INSERT INTO ai_request (
      id, enterprise_id, principal_id, principal_key_id, protocol, unified_model,
      status, started_at, finished_at
    )
    SELECT md5('request-' || g::text)::uuid, ${enterpriseId}::uuid, ${principalId}::uuid,
           ${keyId}::uuid, 'openai', 'migration-model', 'SUCCEEDED',
           '2026-01-01T00:00:00Z'::timestamptz + (g % 744) * interval '1 hour',
           '2026-01-01T00:00:01Z'::timestamptz + (g % 744) * interval '1 hour'
      FROM generate_series(1, ${count}) g
  `.execute(db);
  await sql`
    INSERT INTO upstream_attempt (
      id, ai_request_id, enterprise_id, attempt_no, provider_resource_id,
      upstream_model, finished_at, http_status, response_committed
    )
    SELECT md5('attempt-' || g::text)::uuid, md5('request-' || g::text)::uuid,
           ${enterpriseId}::uuid, 1, ${resourceId}::uuid, 'migration-model',
           '2026-01-01T00:00:01Z'::timestamptz + (g % 744) * interval '1 hour', 200, true
      FROM generate_series(1, ${count}) g
  `.execute(db);
  await sql`
    INSERT INTO usage_event (
      id, ai_request_id, enterprise_id, upstream_attempt_id, provider_resource_id,
      input_tokens, output_tokens, cache_tokens, reasoning_tokens, usage_quality,
      dedup_key, created_at
    )
    SELECT md5('usage-' || g::text)::uuid, md5('request-' || g::text)::uuid,
           ${enterpriseId}::uuid, md5('attempt-' || g::text)::uuid, ${resourceId}::uuid,
           10, 2, 1, 0, 'PROVIDER_REPORTED', 'migration-' || g::text,
           '2026-01-01T00:05:00Z'::timestamptz + (g % 744) * interval '1 hour'
      FROM generate_series(1, ${count}) g
  `.execute(db);
  await sql`
    INSERT INTO ledger_transaction (
      ai_request_id, enterprise_id, principal_id, total_input_tokens,
      total_output_tokens, total_cache_tokens, total_reasoning_tokens,
      total_deducted_quota, total_api_cost, usage_quality, attempt_count, status, created_at
    )
    SELECT md5('request-' || g::text)::uuid, ${enterpriseId}::uuid, ${principalId}::uuid,
           10, 2, 1, 0, 0, 0, 'PROVIDER_REPORTED', 1, 'SETTLED',
           '2026-01-01T00:05:00Z'::timestamptz + (g % 744) * interval '1 hour'
      FROM generate_series(1, ${count}) g
  `.execute(db);
}
