import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest } from "../index.js";
import { rollbackTo } from "./migration-rollback.js";
import { createMigrator } from "../migrator.js";

const INDEX_NAME = "provider_resource_operating_sync_attempt_daily_uq";

async function dailyUqIndexExists(db: ReturnType<typeof createKysely>): Promise<boolean> {
  const result = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes WHERE indexname = ${INDEX_NAME}
  `.execute(db);
  return result.rows.length > 0;
}

async function attemptRowCount(db: ReturnType<typeof createKysely>): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM provider_resource_operating_sync_attempt
  `.execute(db);
  return result.rows[0]!.count;
}

interface Seed {
  enterpriseId: string; providerId: string; resourceId: string;
}

/** attempt 表有 (enterprise_id, provider_resource_id) → provider_resource 复合外键，先种主体行。 */
async function seedResource(db: ReturnType<typeof createKysely>): Promise<Seed> {
  const enterpriseId = randomUUID(); const providerId = randomUUID(); const resourceId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "0095 迁移测试企业" }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId, name: "DeepSeek API",
    mode: "API", credential_type: "API_KEY",
  }).execute();
  return { enterpriseId, providerId, resourceId };
}

/** 直插 attempt 行（同一 sync_day 可传不同 started_at 以构造多行）。 */
async function insertAttempt(
  db: ReturnType<typeof createKysely>, seed: Seed, startedAt: string,
): Promise<void> {
  await sql`
    INSERT INTO provider_resource_operating_sync_attempt
      (enterprise_id, provider_resource_id, sync_day, balance_status, cost_status,
       started_at, completed_at, next_sync_at, adapter_version)
    VALUES (${seed.enterpriseId}::uuid, ${seed.resourceId}::uuid, '2026-08-18',
            'SUCCESS', 'NOT_SUPPORTED',
            ${startedAt}::timestamptz, ${startedAt}::timestamptz,
            ${startedAt}::timestamptz + interval '15 minutes', 'pool20-025-v1')
  `.execute(db);
}

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe.sequential("0095 官方余额同步解耦（drop provider_resource_operating_sync_attempt_daily_uq）", () => {
  it("迁移水位含 0095：daily_uq 索引已删除（快照/attempt 表本体与既有行不受影响）", async () => {
    expect(await dailyUqIndexExists(db)).toBe(false);
    // 表本体仍在且可写入（0051 表结构未被本迁移改动）。
    const seed = await seedResource(db);
    await insertAttempt(db, seed, "2026-08-18T01:00:00Z");
    expect(await attemptRowCount(db)).toBe(1);
  });

  it("0095 正向/down 全链路：0094 下同日第二行被拒；0095 放开后多行可插且旧行保留；多行时 down 拒绝", async () => {
    const multiPg = await startPostgresContainer("wp3_0095_multi_row");
    const multiDb = createKysely(multiPg.connectionString);
    try {
      // 停在 0094：daily_uq 存在，同日第二行违反唯一索引。
      expect((await createMigrator(multiDb)
        .migrateTo("0094_retire_api_finance_pending_admission")).error).toBeUndefined();
      expect(await dailyUqIndexExists(multiDb)).toBe(true);
      const seed = await seedResource(multiDb);
      await insertAttempt(multiDb, seed, "2026-08-18T01:00:00Z");
      await expect(insertAttempt(multiDb, seed, "2026-08-18T01:20:00Z")).rejects.toThrow();

      // 应用 0095：索引删除；0094 时代插入的旧行保留；同日第二/三行可插。
      expect((await createMigrator(multiDb).migrateToLatest()).error).toBeUndefined();
      expect(await dailyUqIndexExists(multiDb)).toBe(false);
      expect(await attemptRowCount(multiDb)).toBe(1);
      await insertAttempt(multiDb, seed, "2026-08-18T01:20:00Z");
      await insertAttempt(multiDb, seed, "2026-08-18T01:40:00Z");
      expect(await attemptRowCount(multiDb)).toBe(3);

      // down 守卫：同键多行时拒绝重建唯一索引（rollbackTo 逐条回滚：0096 先行，
      // 0095 down 抛出守卫错误）；失败的 down 不改 schema（索引仍不存在）。
      await expect(rollbackTo(multiDb, "0095_official_balance_sync_decouple"))
        .rejects.toThrow(/0095 down/);
      expect(await dailyUqIndexExists(multiDb)).toBe(false);
    } finally {
      await multiDb.destroy();
      await multiPg.stop();
    }
  });

  it("单行路径 down 成功：索引重建且唯一性恢复，重新 up 再次放开", async () => {
    const singlePg = await startPostgresContainer("wp3_0095_single_row");
    const singleDb = createKysely(singlePg.connectionString);
    try {
      expect((await createMigrator(singleDb)
        .migrateTo("0094_retire_api_finance_pending_admission")).error).toBeUndefined();
      const seed = await seedResource(singleDb);
      await insertAttempt(singleDb, seed, "2026-08-18T01:00:00Z");
      expect((await createMigrator(singleDb).migrateToLatest()).error).toBeUndefined();
      expect(await dailyUqIndexExists(singleDb)).toBe(false);

      // 精确回滚到 0095（0096 先行回滚），单键单行时索引重建成功。
      const rolledBack = await rollbackTo(singleDb, "0095_official_balance_sync_decouple");
      expect(rolledBack.at(-1)).toBe("0095_official_balance_sync_decouple");
      expect(rolledBack).toContain("0096_official_balance_refresh_request");
      expect(await dailyUqIndexExists(singleDb)).toBe(true);
      // 唯一性确实恢复：同日第二行再次被拒。
      await expect(insertAttempt(singleDb, seed, "2026-08-18T01:20:00Z")).rejects.toThrow();

      expect((await createMigrator(singleDb).migrateToLatest()).error).toBeUndefined();
      expect(await dailyUqIndexExists(singleDb)).toBe(false);
    } finally {
      await singleDb.destroy();
      await singlePg.stop();
    }
  });
});
