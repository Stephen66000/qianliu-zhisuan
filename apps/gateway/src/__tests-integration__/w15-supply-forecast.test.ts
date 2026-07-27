/**
 * gateway W15 集成测试：供给预测快照（WT-15 + 数据不足不伪精确）。
 *
 * 用真实 PostgreSQL + usage_event + computeForecast 验证：
 *   - WT-15：多窗口消耗速度、预计耗尽、下一恢复、覆盖时长、可信度
 *   - 预测依据：数据点数 + 算法版本落库（可解释、自然月偏差校准底座）
 *   - 数据不足 → LOW/NOT_CALCULABLE（不伪精确）
 *   - 余额未知 → 不生成耗尽日期
 *   - 快照可复查（supply_forecast 落库，每日快照口径）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  computeForecast,
  FORECAST_CONFIDENCE,
  FORECAST_ALGORITHM_VERSION,
  type WindowUsage,
} from "@qianliu/domain";

let pg: PostgresTestInstance;
let db: Database;
const ENT_ID = randomUUID();
let resourceId: string;
const H = 3600_000;

/** 从 usage_event 聚合窗口消耗（真实 SQL，模拟 worker 每日快照的输入）。 */
async function aggregateWindow(resId: string, windowHours: number, now: Date): Promise<WindowUsage> {
  const since = new Date(now.getTime() - windowHours * H);
  const rows = await db
    .selectFrom("usage_event")
    .select((eb) => [
      eb.fn.sum("input_tokens").as("in_t"),
      eb.fn.sum("output_tokens").as("out_t"),
      eb.fn.countAll().as("cnt"),
      eb.fn.min("created_at").as("first"),
    ])
    .where("provider_resource_id", "=", resId)
    .where("created_at", ">=", since)
    .executeTakeFirstOrThrow();
  const tokens = Number(rows.in_t ?? 0) + Number(rows.out_t ?? 0);
  const dataPoints = Number(rows.cnt);
  const first = rows.first as Date | null;
  const coveredHours = first ? Math.max((now.getTime() - first.getTime()) / H, 0.01) : 0;
  return { tokens, dataPoints, coveredHours: Math.min(coveredHours, windowHours) };
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W15预测" }).execute();
  const principalId = randomUUID();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "员工" }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow();
  resourceId = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "Kimi 资源",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow()).id;

  // 造 usage_event：过去 24h 每小时 2 个（各 input 400 + output 100）
  const keyId = randomUUID();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: "ql-w15", key_digest: "digest-w15", status: "ACTIVE",
  }).execute();
  const now = Date.now();
  for (let h = 0; h < 24; h++) {
    for (let k = 0; k < 2; k++) {
      const reqId = randomUUID();
      await db.insertInto("ai_request").values({
        id: reqId, enterprise_id: ENT_ID, principal_id: principalId, principal_key_id: keyId,
        protocol: "chat", unified_model: "qianliu-kimi-k3", status: "SUCCEEDED",
      }).execute();
      const attemptId = (await db.insertInto("upstream_attempt").values({
        ai_request_id: reqId, enterprise_id: ENT_ID, attempt_no: 1,
        provider_resource_id: resourceId, upstream_model: "kimi-k3",
      }).returningAll().executeTakeFirstOrThrow()).id;
      await db.insertInto("usage_event").values({
        ai_request_id: reqId, enterprise_id: ENT_ID, upstream_attempt_id: attemptId,
        provider_resource_id: resourceId, input_tokens: 400n, output_tokens: 100n,
        cache_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `${reqId}:a1`,
        created_at: new Date(now - h * H - k * 1000),
      }).execute();
    }
  }
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W15 供给预测快照", () => {
  it("WT-15：多窗口速度 + 耗尽 + 恢复 + 覆盖 + 可信度（真实 usage_event 聚合）", async () => {
    const now = new Date();
    const rate1h = await aggregateWindow(resourceId, 1, now);
    const rate24h = await aggregateWindow(resourceId, 24, now);
    const rate7d = await aggregateWindow(resourceId, 168, now);

    // 24h 造了 48 个 event（每 h 2 个，各 500 token）；1h 窗口应抓到最近 2 个
    expect(rate24h.dataPoints).toBe(48);
    expect(rate24h.tokens).toBe(48 * 500);
    expect(rate1h.dataPoints).toBeGreaterThanOrEqual(2);

    const forecast = computeForecast({
      rate1h, rate24h, rate7d,
      remainingQuota: 100000,
      resourceExpiresAt: null,
      nextResetAt: now.getTime() + 7 * 24 * H, // 厂商周期 7 天后重置
      now: now.getTime(),
    });

    // WT-15：速度、耗尽、恢复、覆盖、可信度全可见
    expect(forecast.rate24h).toBeGreaterThan(0);
    expect(forecast.forecastExhaustAt).not.toBeNull();
    expect(forecast.nextRecoverAt).toBe(now.getTime() + 7 * 24 * H);
    expect(forecast.coverageHours).toBeGreaterThan(0);
    expect(forecast.dataPoints).toBeGreaterThanOrEqual(48);
    // 数据足（48+）且多窗口 → HIGH 或 MEDIUM
    expect([FORECAST_CONFIDENCE.HIGH, FORECAST_CONFIDENCE.MEDIUM]).toContain(forecast.confidence);

    // 落库快照（预测依据：data_points + algorithm_version）
    await db.insertInto("supply_forecast").values({
      enterprise_id: ENT_ID, provider_resource_id: resourceId,
      rate_1h: forecast.rate1h?.toFixed(4) ?? null,
      rate_24h: forecast.rate24h?.toFixed(4) ?? null,
      rate_7d: forecast.rate7d?.toFixed(4) ?? null,
      forecast_exhaust_at: forecast.forecastExhaustAt ? new Date(forecast.forecastExhaustAt) : null,
      next_recover_at: forecast.nextRecoverAt ? new Date(forecast.nextRecoverAt) : null,
      coverage_hours: forecast.coverageHours?.toFixed(2) ?? null,
      remaining_quota: "100000",
      confidence: forecast.confidence,
      data_points: forecast.dataPoints,
      not_calculable_reason: forecast.notCalculableReason,
      algorithm_version: FORECAST_ALGORITHM_VERSION,
    }).execute();

    const saved = await db.selectFrom("supply_forecast").selectAll()
      .where("provider_resource_id", "=", resourceId).executeTakeFirstOrThrow();
    expect(saved.confidence).toBe(forecast.confidence);
    expect(saved.algorithm_version).toBe("w15-v1");
    expect(saved.data_points).toBe(forecast.dataPoints);
    expect(saved.forecast_exhaust_at).not.toBeNull();
  });

  it("数据不足：无 usage_event 的资源 → NOT_CALCULABLE/LOW（不伪精确）", async () => {
    // 新资源无消耗
    const provider = await db.selectFrom("provider").selectAll().where("enterprise_id", "=", ENT_ID).executeTakeFirstOrThrow();
    const emptyRes = (await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: provider.id, name: "空闲资源",
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returningAll().executeTakeFirstOrThrow()).id;
    const now = new Date();
    const forecast = computeForecast({
      rate1h: await aggregateWindow(emptyRes, 1, now),
      rate24h: await aggregateWindow(emptyRes, 24, now),
      rate7d: await aggregateWindow(emptyRes, 168, now),
      remainingQuota: 50000,
      resourceExpiresAt: null, nextResetAt: null, now: now.getTime(),
    });
    // 无消耗速度 → 不给耗尽日期
    expect(forecast.forecastExhaustAt).toBeNull();
    expect(forecast.notCalculableReason).toBe("no_consumption_rate");
    expect(forecast.dataPoints).toBe(0);
  });

  it("余额未知 → NOT_CALCULABLE，不生成耗尽日期", async () => {
    const now = new Date();
    const forecast = computeForecast({
      rate1h: await aggregateWindow(resourceId, 1, now),
      rate24h: await aggregateWindow(resourceId, 24, now),
      rate7d: await aggregateWindow(resourceId, 168, now),
      remainingQuota: null, // 余额未知
      resourceExpiresAt: null, nextResetAt: null, now: now.getTime(),
    });
    expect(forecast.confidence).toBe(FORECAST_CONFIDENCE.NOT_CALCULABLE);
    expect(forecast.forecastExhaustAt).toBeNull();
    expect(forecast.notCalculableReason).toBe("remaining_quota_unknown");
  });
});
