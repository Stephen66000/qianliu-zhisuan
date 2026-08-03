import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  ProviderRepository,
  SupplyForecastRepository,
} from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("POOL-022 供给预测生产闭环", () => {
  it("API 按金额、套餐按扣减额度计算，同 Tick 幂等且经营快照更新后立即补新预测", async () => {
    const now = new Date("2026-08-03T08:00:00.000Z");
    const enterpriseId = randomUUID();
    const principalId = randomUUID();
    await db.insertInto("enterprise").values({ id: enterpriseId, name: "预测企业" }).execute();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "预测员工",
    }).execute();
    const model = await db.insertInto("unified_model").values({
      enterprise_id: enterpriseId, alias: "forecast-model", display_name: "预测模型",
    }).returning("id").executeTakeFirstOrThrow();
    const key = await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId,
      principal_id: principalId,
      key_prefix: "qlk_forecast",
      key_digest: "forecast-digest",
      allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
    }).returning("id").executeTakeFirstOrThrow();
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: "forecast", name: "预测厂商", adapter_type: "test",
    }).returning("id").executeTakeFirstOrThrow();
    const apiResource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "API 余额",
      mode: "API",
      credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    const planResource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "套餐额度",
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
    }).returning("id").executeTakeFirstOrThrow();
    const providerRepo = new ProviderRepository(db);
    await providerRepo.appendOperatingSnapshot(enterpriseId, apiResource.id, {
      source: "ADMIN",
      collected_at: new Date(now.getTime() - 24 * 3_600_000),
      currency: "CNY",
      current_balance: "100.00",
    });
    await providerRepo.appendOperatingSnapshot(enterpriseId, planResource.id, {
      source: "ADMIN",
      collected_at: new Date(now.getTime() - 24 * 3_600_000),
      total_quota: "1000",
      remaining_quota: "1000",
      quota_unit: "TOKEN",
      reset_cycle: "QUARTERLY",
      reset_anchor_at: new Date("2026-07-01T16:00:00.000Z"),
    });

    const ledger = new GatewayLedgerRepository(db);
    for (let index = 0; index < 10; index += 1) {
      const occurredAt = new Date(now.getTime() - (7 - index * 0.7) * 3_600_000);
      await appendLine({
        ledger,
        enterpriseId,
        principalId,
        keyId: key.id,
        resourceId: apiResource.id,
        mode: "API",
        occurredAt,
        apiCost: "1.00000000",
        deductedQuota: null,
      });
      await appendLine({
        ledger,
        enterpriseId,
        principalId,
        keyId: key.id,
        resourceId: planResource.id,
        mode: "CODING_PLAN",
        occurredAt,
        apiCost: null,
        deductedQuota: 10n,
      });
    }

    const repo = new SupplyForecastRepository(db);
    expect(await repo.runTick(now)).toEqual({
      resourcesScanned: 2, snapshotsCreated: 2, snapshotsSkipped: 0,
    });
    expect(await repo.runTick(now)).toEqual({
      resourcesScanned: 2, snapshotsCreated: 0, snapshotsSkipped: 2,
    });
    const forecasts = await db.selectFrom("supply_forecast").selectAll().orderBy("provider_resource_id").execute();
    const api = forecasts.find((row) => row.provider_resource_id === apiResource.id)!;
    const plan = forecasts.find((row) => row.provider_resource_id === planResource.id)!;
    expect(api.consumption_unit).toBe("CURRENCY_PER_HOUR");
    expect(plan.consumption_unit).toBe("QUOTA_PER_HOUR");
    expect(Number(api.rate_24h)).toBeGreaterThan(1);
    expect(Number(plan.rate_24h)).toBeGreaterThan(10);
    expect(api.forecast_exhaust_at).not.toBeNull();
    expect(plan.forecast_exhaust_at).not.toBeNull();
    expect(plan.next_recover_at?.toISOString()).toBe("2026-10-01T16:00:00.000Z");

    const refreshedAt = new Date(now.getTime() + 30_000);
    await providerRepo.appendOperatingSnapshot(enterpriseId, apiResource.id, {
      source: "ADMIN",
      collected_at: refreshedAt,
      currency: "CNY",
      current_balance: "50.00",
    });
    const refreshed = await repo.runTick(refreshedAt);
    expect(refreshed.snapshotsCreated).toBe(1);
    const latestApi = await db.selectFrom("supply_forecast").selectAll()
      .where("provider_resource_id", "=", apiResource.id)
      .orderBy("snapshot_at", "desc").executeTakeFirstOrThrow();
    expect(latestApi.remaining_quota).toBe("50.00000000");
    expect(latestApi.snapshot_at).toEqual(refreshedAt);
  });
});

async function appendLine(input: {
  ledger: GatewayLedgerRepository;
  enterpriseId: string;
  principalId: string;
  keyId: string;
  resourceId: string;
  mode: "API" | "CODING_PLAN";
  occurredAt: Date;
  apiCost: string | null;
  deductedQuota: bigint | null;
}): Promise<void> {
  const requestId = randomUUID();
  await input.ledger.createRequest({
    id: requestId,
    enterprise_id: input.enterpriseId,
    principal_id: input.principalId,
    principal_key_id: input.keyId,
    protocol: "test",
    unified_model: "forecast-model",
  });
  const attempt = await input.ledger.createAttempt({
    ai_request_id: requestId,
    enterprise_id: input.enterpriseId,
    attempt_no: 1,
    provider_resource_id: input.resourceId,
    upstream_model: "forecast-upstream",
  });
  const usage = await input.ledger.createUsageEventIfAbsent({
    ai_request_id: requestId,
    enterprise_id: input.enterpriseId,
    upstream_attempt_id: attempt.id,
    provider_resource_id: input.resourceId,
    input_tokens: 10n,
    output_tokens: 0n,
    cache_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId,
  });
  const line = await input.ledger.createLedgerLine({
    ai_request_id: requestId,
    enterprise_id: input.enterpriseId,
    usage_event_id: usage!.id,
    upstream_attempt_id: attempt.id,
    provider_resource_id: input.resourceId,
    principal_id: input.principalId,
    resource_mode: input.mode,
    raw_input_tokens: 10n,
    raw_output_tokens: 0n,
    raw_cache_tokens: 0n,
    deducted_quota: input.deductedQuota,
    api_cost: input.apiCost,
    usage_quality: "PROVIDER_REPORTED",
  });
  await db.updateTable("ledger_line").set({ created_at: input.occurredAt }).where("id", "=", line.id).execute();
}
