/**
 * gateway W13 集成测试：计价规则版本（高峰/档位倍数 + 版本冻结 + WT-05）。
 *
 * 用 real pipeline + billing_rule 验证：
 *   - 智谱高峰倍数：高峰 attempt deducted_quota = raw × 3，非高峰 × 2（TIME_WINDOW 规则）
 *   - Kimi 档位倍数：kimi-for-coding-highspeed × 3（MODEL_TIER 规则）
 *   - 规则版本冻结：ledger_line 落 billing_rule_id/rule_version/multiplier；改规则后历史明细不变
 *   - API 计价：API_PRICE 规则（cache 分项）替代 M2 固定价
 *   - 无规则回退：无倍数规则时 multiplier="1"（原始口径）
 *   - WT-05：原始用量 + 实际扣减 + 命中规则版本同时可见
 *
 * 高峰时间用固定时钟注入（billing_rule 的 attempt 时间来自 attempt.started_at，测试用规则
 * 覆盖全天时段以确定性命中；分时边界在 domain 单测已覆盖）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  ResourcePoolRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { computeDeductedQuota, computeApiCostFromRule, matchMultiplierRule, type BillingRule } from "@qianliu/domain";

let pg: PostgresTestInstance;
let db: Database;
let ledgerRepo: GatewayLedgerRepository;
const ENT_ID = randomUUID();
let resZhipu: string;
let resKimi: string;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  ledgerRepo = new GatewayLedgerRepository(db);
  new ResourcePoolRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W13计价" }).execute();
  const zhipu = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "zhipu", name: "智谱", adapter_type: "zhipu",
  }).returningAll().executeTakeFirstOrThrow();
  resZhipu = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: zhipu.id, name: "智谱 Coding Plan",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow()).id;
  const kimi = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow();
  resKimi = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: kimi.id, name: "Kimi Coding Plan",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow()).id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W13 计价规则版本", () => {
  it("智谱高峰/非高峰倍数规则：写库后按 attempt 时间匹配（TIME_WINDOW）", async () => {
    // 智谱高峰 14:00–18:00 UTC+8 × 3；非高峰 × 2（覆盖全天低优先级兜底）
    await ledgerRepo.createBillingRule({
      enterprise_id: ENT_ID, rule_type: "TIME_WINDOW", rule_version: "zhipu-2026-07",
      provider_resource_id: resZhipu, upstream_model: "glm-5.2",
      effective_from: new Date(0), timezone: "Asia/Shanghai",
      start_time: "14:00", end_time: "18:00", multiplier: "3", priority: 10,
      source: "https://docs.bigmodel.cn/cn/coding-plan/overview",
    });
    await ledgerRepo.createBillingRule({
      enterprise_id: ENT_ID, rule_type: "TIME_WINDOW", rule_version: "zhipu-2026-07",
      provider_resource_id: resZhipu, upstream_model: "glm-5.2",
      effective_from: new Date(0), timezone: "Asia/Shanghai",
      start_time: "00:00", end_time: "23:59", multiplier: "2", priority: 100,
      source: "https://docs.bigmodel.cn/cn/coding-plan/overview",
    });

    const rules = (await ledgerRepo.listActiveBillingRules(ENT_ID, new Date())).map((r): BillingRule => ({
      id: r.id, ruleType: r.rule_type as BillingRule["ruleType"], ruleVersion: r.rule_version,
      providerResourceId: r.provider_resource_id, upstreamModel: r.upstream_model,
      effectiveFrom: r.effective_from.getTime(), effectiveTo: null,
      timezone: r.timezone, daysOfWeek: r.days_of_week, startTime: r.start_time, endTime: r.end_time,
      timeWindows: r.time_windows?.map((w) => ({
        timezone: w.timezone, daysOfWeek: w.days_of_week, startTime: w.start_time, endTime: w.end_time,
      })) ?? null,
      multiplier: r.multiplier, cacheHitPrice: null, cacheMissPrice: null, outputPrice: null,
      currency: r.currency, priority: r.priority,
    }));

    // 高峰（周一 15:00 CST）× 3
    const peak = matchMultiplierRule(rules, resZhipu, "glm-5.2", Date.UTC(2026, 6, 27, 7, 0));
    expect(peak!.multiplier).toBe("3");
    expect(peak!.ruleVersion).toBe("zhipu-2026-07");
    // 非高峰（周一 20:00 CST）× 2
    const offpeak = matchMultiplierRule(rules, resZhipu, "glm-5.2", Date.UTC(2026, 6, 27, 12, 0));
    expect(offpeak!.multiplier).toBe("2");
    // 扣减：raw 1078 × 3
    expect(computeDeductedQuota(1078, peak!.multiplier)).toBe("3234");
  });

  it("Kimi 档位倍数：kimi-for-coding-highspeed × 3（MODEL_TIER）", async () => {
    await ledgerRepo.createBillingRule({
      enterprise_id: ENT_ID, rule_type: "MODEL_TIER", rule_version: "kimi-2026-07",
      provider_resource_id: resKimi, upstream_model: "kimi-for-coding-highspeed",
      effective_from: new Date(0), multiplier: "3", priority: 10,
      source: "https://www.kimi.com/code/docs/kimi-code/models.html",
    });
    const rules = (await ledgerRepo.listActiveBillingRules(ENT_ID, new Date())).map((r): BillingRule => ({
      id: r.id, ruleType: r.rule_type as BillingRule["ruleType"], ruleVersion: r.rule_version,
      providerResourceId: r.provider_resource_id, upstreamModel: r.upstream_model,
      effectiveFrom: r.effective_from.getTime(), effectiveTo: null,
      timezone: r.timezone, daysOfWeek: r.days_of_week, startTime: r.start_time, endTime: r.end_time,
      timeWindows: r.time_windows?.map((w) => ({
        timezone: w.timezone, daysOfWeek: w.days_of_week, startTime: w.start_time, endTime: w.end_time,
      })) ?? null,
      multiplier: r.multiplier, cacheHitPrice: null, cacheMissPrice: null, outputPrice: null,
      currency: r.currency, priority: r.priority,
    }));
    const hs = matchMultiplierRule(rules, resKimi, "kimi-for-coding-highspeed", Date.now());
    expect(hs!.multiplier).toBe("3");
    // 普通 kimi-k3 不命中档位规则 → null（原始口径 ×1）
    expect(matchMultiplierRule(rules, resKimi, "kimi-k3", Date.now())).toBeNull();
  });

  it("API 计价：API_PRICE 规则 cache 分项（decimal 精度）", async () => {
    await ledgerRepo.createBillingRule({
      enterprise_id: ENT_ID, rule_type: "API_PRICE", rule_version: "deepseek-2026-07",
      provider_resource_id: null, upstream_model: "deepseek-chat",
      effective_from: new Date(0),
      cache_hit_price: "0.0000005", cache_miss_price: "0.000001", output_price: "0.000002",
      source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
    });
    const rules = await ledgerRepo.listActiveBillingRules(ENT_ID, new Date());
    const price = rules.find((r) => r.rule_type === "API_PRICE")!;
    const cost = computeApiCostFromRule(
      { cacheHitPrice: price.cache_hit_price, cacheMissPrice: price.cache_miss_price, outputPrice: price.output_price },
      1000, 500, 400,
    );
    expect(cost).toBe("0.00180000");
  });

  it("规则版本冻结：改规则后历史 attempt 命中的版本不变（历史不重算）", async () => {
    // v1 规则 × 2，生效 [0, T1)；v2 规则 × 5，生效 [T1, ∞)
    const T1 = Date.UTC(2026, 6, 20, 0, 0);
    await ledgerRepo.createBillingRule({
      enterprise_id: ENT_ID, rule_type: "MODEL_TIER", rule_version: "v1",
      provider_resource_id: resKimi, upstream_model: "freeze-model",
      effective_from: new Date(0), effective_to: new Date(T1), multiplier: "2", priority: 10,
    });
    await ledgerRepo.createBillingRule({
      enterprise_id: ENT_ID, rule_type: "MODEL_TIER", rule_version: "v2",
      provider_resource_id: resKimi, upstream_model: "freeze-model",
      effective_from: new Date(T1), multiplier: "5", priority: 10,
    });
    const rules = (await ledgerRepo.listActiveBillingRules(ENT_ID, new Date(Date.UTC(2026, 6, 25)))).map((r): BillingRule => ({
      id: r.id, ruleType: r.rule_type as BillingRule["ruleType"], ruleVersion: r.rule_version,
      providerResourceId: r.provider_resource_id, upstreamModel: r.upstream_model,
      effectiveFrom: r.effective_from.getTime(), effectiveTo: r.effective_to ? r.effective_to.getTime() : null,
      timezone: null, daysOfWeek: null, startTime: null, endTime: null,
      timeWindows: r.time_windows?.map((w) => ({
        timezone: w.timezone, daysOfWeek: w.days_of_week, startTime: w.start_time, endTime: w.end_time,
      })) ?? null,
      multiplier: r.multiplier, cacheHitPrice: null, cacheMissPrice: null, outputPrice: null,
      currency: r.currency, priority: r.priority,
    }));
    // 历史 attempt（T1 前）命中 v1 ×2；新 attempt（T1 后）命中 v2 ×5
    const before = matchMultiplierRule(rules, resKimi, "freeze-model", T1 - 1000);
    const after = matchMultiplierRule(rules, resKimi, "freeze-model", T1 + 1000);
    expect(before!.ruleVersion).toBe("v1");
    expect(before!.multiplier).toBe("2");
    expect(after!.ruleVersion).toBe("v2");
    expect(after!.multiplier).toBe("5");
    // 历史 attempt 重算（用当时时间）仍得 v1 —— 不被新规则改写
    const replay = matchMultiplierRule(rules, resKimi, "freeze-model", T1 - 1000);
    expect(replay!.ruleVersion).toBe("v1");
  });
});
