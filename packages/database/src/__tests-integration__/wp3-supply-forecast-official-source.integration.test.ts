import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, SupplyForecastRepository } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer("wp3_forecast_official_source");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

const P2_MS = 1_800_000; // 30 分钟（合同冻结值）

interface Seed {
  enterpriseId: string; resourceId: string; repo: SupplyForecastRepository;
}

async function seedApiResource(name: string): Promise<Seed> {
  const enterpriseId = randomUUID();
  const providerId = randomUUID(); const resourceId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "deepseek", name: `DeepSeek ${name}`, adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: `${name}-API`, mode: "API", credential_type: "API_KEY",
  }).execute();
  return { enterpriseId, resourceId, repo: new SupplyForecastRepository(db) };
}

async function insertSnapshot(seed: Seed, input: {
  version: number; collectedAt: Date; totalBalance: string | null;
  source: string; balanceSource?: string;
}): Promise<void> {
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
    version: input.version, source: input.source,
    collected_at: input.collectedAt, currency: "CNY",
    current_balance: input.totalBalance,
    balance_source: input.balanceSource ?? (input.source === "ADMIN" ? "ADMIN" : "PROVIDER_API"),
    usage_calculation: "MANUAL_SNAPSHOT",
  }).execute();
}

const readLatestForecast = async (seed: Seed) =>
  db.selectFrom("supply_forecast").selectAll()
    .where("provider_resource_id", "=", seed.resourceId)
    .orderBy("snapshot_at", "desc").executeTakeFirst();

describe("WP3/OAB-07 预测来源合格＋时效有效（task 3.4）", () => {
  it("a) 仅 ADMIN 手工快照 → 预测不可计算（official_source_missing），无确定耗尽时间", async () => {
    const seed = await seedApiResource("admin-only");
    const now = new Date("2026-08-18T01:00:00Z");
    await insertSnapshot(seed, { version: 1, collectedAt: new Date(now.getTime() - 60_000),
      totalBalance: "80", source: "ADMIN" });
    const result = await seed.repo.runTick(now, 60_000, P2_MS);
    expect(result.resourcesScanned).toBe(1);
    expect(result.snapshotsCreated).toBe(1);
    const row = await readLatestForecast(seed);
    expect(row).toMatchObject({
      not_calculable_reason: "official_source_missing",
      forecast_exhaust_at: null, remaining_quota: null, confidence: "NOT_CALCULABLE",
    });
    expect(row!.rate_1h).toBeNull();
    // 幂等：同 bucket 重复 tick 不重复落行。
    const again = await seed.repo.runTick(now, 60_000, P2_MS);
    expect(again.snapshotsCreated).toBe(0);
    expect(again.snapshotsSkipped).toBe(1);
  });

  it("b) 官方快照超 P2 → 不可计算/待更新（official_balance_expired），无确定 exhaust_at；P2 内正常计算", async () => {
    const seed = await seedApiResource("stale-official");
    const now = new Date("2026-08-18T01:00:00Z");
    // 31 分钟前官方快照：超 P2（30 分钟）。
    await insertSnapshot(seed, { version: 1,
      collectedAt: new Date(now.getTime() - 31 * 60_000),
      totalBalance: "60", source: "PROVIDER_SYNC" });
    const result = await seed.repo.runTick(now, 60_000, P2_MS);
    expect(result.snapshotsCreated).toBe(1);
    const staleRow = await readLatestForecast(seed);
    expect(staleRow).toMatchObject({
      not_calculable_reason: "official_balance_expired",
      forecast_exhaust_at: null, remaining_quota: null, confidence: "NOT_CALCULABLE",
    });
    expect(staleRow!.forecast_exhaust_at).toBeNull();

    // 新官方快照（3 分钟前，P2 内）→ 回归对照：进入正常计算路径（零用量 →
    // no_consumption_rate，非官方来源类原因），预测行照常产出。
    await insertSnapshot(seed, { version: 2,
      collectedAt: new Date(now.getTime() - 3 * 60_000),
      totalBalance: "55", source: "PROVIDER_SYNC" });
    await seed.repo.runTick(new Date(now.getTime() + 60_000), 60_000, P2_MS);
    const freshRow = await readLatestForecast(seed);
    expect(freshRow!.not_calculable_reason).toBe("no_consumption_rate");
    expect(freshRow!.not_calculable_reason).not.toBe("official_balance_expired");
    expect(freshRow!.forecast_exhaust_at).toBeNull(); // 无消耗速度不给日期（既有数学）
    expect(freshRow!.remaining_quota).toBe("55.00000000");
  });

  it("c) 来源优先级：官方快照新鲜而更新的 ADMIN 快照存在 → 预测仍用官方值", async () => {
    const seed = await seedApiResource("precedence");
    const now = new Date("2026-08-18T01:00:00Z");
    await insertSnapshot(seed, { version: 1,
      collectedAt: new Date(now.getTime() - 2 * 60_000),
      totalBalance: "50", source: "PROVIDER_SYNC" });
    // 更新的手工值（version 更高、时间更新）不得作为余额预测输入。
    await insertSnapshot(seed, { version: 2,
      collectedAt: new Date(now.getTime() - 60_000),
      totalBalance: "999", source: "ADMIN" });
    await seed.repo.runTick(now, 60_000, P2_MS);
    const row = await readLatestForecast(seed);
    expect(row!.not_calculable_reason).toBe("no_consumption_rate");
    expect(row!.remaining_quota).toBe("50.00000000");
    expect(row!.remaining_quota).not.toBe("999.00000000");
  });

  it("d) CP 套餐额度预测保持既有行为：ADMIN 套餐快照照常参与（W5/W6 域不变）", async () => {
    const seed = await seedApiResource("cp-admin");
    const providerId = (await db.selectFrom("provider_resource").select("provider_id")
      .where("id", "=", seed.resourceId).executeTakeFirstOrThrow()).provider_id;
    const planResourceId = randomUUID();
    await db.insertInto("provider_resource").values({
      id: planResourceId, enterprise_id: seed.enterpriseId, provider_id: providerId,
      name: "cp-plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).execute();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: planResourceId,
      version: 1, source: "ADMIN", collected_at: new Date("2026-08-18T00:00:00Z"),
      total_quota: "1000", remaining_quota: "800", quota_unit: "TOKEN",
      reset_cycle: "MONTHLY", reset_anchor_at: new Date("2026-08-01T00:00:00Z"),
      usage_calculation: "MANUAL_SNAPSHOT",
    }).execute();
    const now = new Date("2026-08-18T01:00:00Z");
    // resourcesScanned 为容器全量口径（runTick 无企业过滤），逐资源行验证：
    // CP 行照常计算；本企业的 API 资源无任何快照 → 既有跳过行为。
    const result = await seed.repo.runTick(now, 60_000, P2_MS);
    expect(result.snapshotsSkipped).toBeGreaterThanOrEqual(1);
    const planRow = await db.selectFrom("supply_forecast").selectAll()
      .where("provider_resource_id", "=", planResourceId)
      .orderBy("snapshot_at", "desc").executeTakeFirst();
    expect(planRow).not.toBeNull();
    expect(planRow!.remaining_quota).toBe("800.00000000");
    // 零用量走 computeForecast 正常路径（no_consumption_rate），非来源/时效类原因。
    expect(planRow!.not_calculable_reason).toBe("no_consumption_rate");
    const apiRow = await db.selectFrom("supply_forecast").selectAll()
      .where("provider_resource_id", "=", seed.resourceId)
      .orderBy("snapshot_at", "desc").executeTakeFirst();
    expect(apiRow).toBeUndefined();
  });
});
