/**
 * gateway W16 集成测试：经营调度 + 等价切换 + 限流/拒绝 + 反事实节省（WT-16/17）。
 *
 * 用 real pipeline（dispatchRepo + 已发布策略 + decideDispatch + StubUpstream + 真实账本）验证：
 *   - WT-16：高峰时段命中 SWITCH 策略 → 在等价资源组内切换；route_candidate/dispatch_decision 可解释输入/动作/结果
 *   - WT-16：命中 REJECT → 403；命中 RATE_LIMIT → 429（不无账放行）
 *   - WT-17：SWITCH 实际执行 + 有成本 → dispatch_saving 可计算；ALLOW 仅提示 → saving_calculable=false
 *
 * 真实 HTTP 在 DEP-PROVIDER-CREDENTIALS 解锁后由佳哥跑。
 */
import { beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  ResourcePoolRepository,
  DispatchPolicyRepository,
  QuotaGateRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  type StubUpstream,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";

let pg: PostgresTestInstance;
export let db: Database;
let validKey: string;
export let resA: string;
export let resB: string;
export let resDsA: string;
export let resDsB: string;
export let stub: StubUpstream;
let poolRepo: ResourcePoolRepository;
export let ledgerRepo: GatewayLedgerRepository;
export let dispatchRepo: DispatchPolicyRepository;
let quotaRepo: QuotaGateRepository;
export const ENT_ID = randomUUID();
export const PRINCIPAL_ID = randomUUID();
const PEPPER = "w16-dispatch-pepper-32bytes-min!";

export function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${validKey}`, "content-type": "application/json" };
}

/** 构建带 dispatch 接入的 app（resolveDispatchInput 注入高峰倍率/额度比例）。 */
export async function buildApp(
  resolveDispatchInput?: (winnerResourceId: string) => Promise<{
    priceMultiplier: string | null;
    remainingQuotaRatio: number | null;
    forecastExhaustRisk: boolean;
  }>,
  now?: () => number,
  activeDispatchRepo: DispatchPolicyRepository | null = dispatchRepo,
): Promise<FastifyInstance> {
  // Old tests supplied a scalar; persist it as a price fixture so runtime decisions use frozen DB rules.
  if (resolveDispatchInput) {
    for (const id of [resA, resB]) {
      const supplied = await resolveDispatchInput(id);
      await db.updateTable("billing_rule").set({ multiplier: supplied.priceMultiplier ?? "1" })
        .where("enterprise_id", "=", ENT_ID).where("provider_resource_id", "=", id)
        .where("rule_type", "in", ["MODEL_TIER", "TIME_WINDOW"]).execute();
    }
  }
  const caller = async (res: unknown, req: unknown, n: number) =>
    stub.invoke(res as never, req as never, n);
  const listCandidates = async (entId: string, model: string): Promise<RouteCandidateRow[]> => {
    const routes = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider.code as provider_code",
        "model_route.upstream_model",
        "model_route.priority",
        "model_route.weight",
        "provider_resource.mode",
        "provider_resource.status",
      ])
      .where("model_route.enterprise_id", "=", entId)
      .where("unified_model.alias", "=", model)
      .where("model_route.enabled", "=", true)
      .execute();
    return routes.map((r) => ({
      resourceId: r.resource_id,
      providerCode: r.provider_code,
      upstreamModel: r.upstream_model,
      priority: r.priority,
      weight: r.weight,
      mode: r.mode as "API" | "CODING_PLAN",
      status: r.status,
      probe: false,
      principalId: PRINCIPAL_ID,
    }));
  };
  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    caller,
    poolRepo,
    quotaRepo,
    dispatchRepo: activeDispatchRepo ?? undefined,
    listCandidates,
    resolveDispatchInput: resolveDispatchInput
      ? async (_entId, _pid, _model, winnerResourceId) =>
          resolveDispatchInput(winnerResourceId)
      : activeDispatchRepo ? (ent, _pid, _model, resourceId, _mode, at, upstreamModel) =>
        activeDispatchRepo.resolveResourceOperatingInput(ent, resourceId, at, upstreamModel) : undefined,
    now,
    maxAttempts: 2,
  });
  const app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
  return app;
}


beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);
  ledgerRepo = new GatewayLedgerRepository(db);
  dispatchRepo = new DispatchPolicyRepository(db);
  quotaRepo = new QuotaGateRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W16调度" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" }).execute();
  validKey = generateApiKey();
  const keyRowId = (await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    allowed_model_ids: JSON.stringify([]) as unknown as string[],
    status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow()).id;
  const authorizedModel = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID,
    alias: "ql-glm-5.2",
    display_name: "仟流 智谱 Coding Plan",
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.updateTable("principal_key").set({
    allowed_model_ids: JSON.stringify([authorizedModel.id]) as unknown as string[],
  }).where("id", "=", keyRowId).execute();

  // 两个等价智谱资源 A/B（A 高优先级，B 低优先级备选）
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "zhipu", name: "智谱", adapter_type: "zhipu",
  }).returningAll().executeTakeFirstOrThrow();
  const a = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "智谱账号A",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow();
  const b = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "智谱账号B",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow();
  resA = a.id;
  resB = b.id;
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: authorizedModel.id,
    provider_resource_id: resA,
    upstream_model: "glm-5.2",
    priority: 100,
    weight: 1,
  }).execute();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: authorizedModel.id,
    provider_resource_id: resB,
    upstream_model: "glm-5.2",
    priority: 200, // B 低优先级（数值大）
    weight: 1,
  }).execute();

  // W14：CODING_PLAN 模式额度门禁需要 principal_grant + quota_counter（F-01 接入后必填）。
  // 两智谱资源同 provider(zhipu)/alias(ql-glm-5.2)，共享一个 grant；quota_value 充足覆盖多用例。
  // API 与 CODING_PLAN 都要求模型 grant；只有 CODING_PLAN 会预占/扣减 quota_counter。
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    provider: "zhipu",
    model_alias: "ql-glm-5.2",
    quota_value: 10_000_000n,
    allow_overage: false,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

  // 另一组 deepseek API 资源对（用于 WT-17 可计算节省：API 模式有 api_cost）
  const deepseekModel = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID,
    alias: "qianliu-deepseek",
    display_name: "仟流 DeepSeek",
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.updateTable("principal_key").set({
    allowed_model_ids: JSON.stringify([
      authorizedModel.id,
      deepseekModel.id,
    ]) as unknown as string[],
  }).where("id", "=", keyRowId).execute();
  const dsProvider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const dsA = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: dsProvider.id, name: "DeepSeek账号A",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  const dsB = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: dsProvider.id, name: "DeepSeek账号B",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  resDsA = dsA.id;
  resDsB = dsB.id;
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: deepseekModel.id,
    provider_resource_id: resDsA,
    upstream_model: "deepseek-chat",
    priority: 100,
    weight: 1,
  }).execute();
  await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    provider: "deepseek",
    model_alias: "qianliu-deepseek",
    quota_value: 10_000_000n,
  }).execute();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: deepseekModel.id,
    provider_resource_id: resDsB,
    upstream_model: "deepseek-chat",
    priority: 200,
    weight: 1,
  }).execute();
  // POOL-021：两侧使用不同且可追溯的 API_PRICE 版本，验证反事实不是复制 actual。
  await ledgerRepo.createBillingRule({
    enterprise_id: ENT_ID,
    rule_type: "API_PRICE",
    rule_version: "ds-a-expensive-v1",
    provider_resource_id: resDsA,
    upstream_model: "deepseek-chat",
    effective_from: new Date(0),
    cache_hit_price: "0.000002",
    cache_miss_price: "0.000004",
    output_price: "0.000006",
    priority: 100,
  });
  await ledgerRepo.createBillingRule({
    enterprise_id: ENT_ID,
    rule_type: "API_PRICE",
    rule_version: "ds-b-cheap-v1",
    provider_resource_id: resDsB,
    upstream_model: "deepseek-chat",
    effective_from: new Date(0),
    cache_hit_price: "0.000001",
    cache_miss_price: "0.000002",
    output_price: "0.000003",
    priority: 100,
  });
  await seedMissingBillingRules(db, ENT_ID);
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);


export function setStub(value: StubUpstream): void {
  stub = value;
}

/** 显式准备策略，允许节省及故障测试单独运行。 */
export async function seedCodingPlanSwitch(): Promise<void> {
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchPriceMultiplierMin: "3", // 高峰倍率 ≥3 命中
      matchResourceMode: "CODING_PLAN",
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchRemainingQuotaRatioMax: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "SWITCH",
      switchEquivalentGroup: [resA, resB],
      rateLimitPerMinute: null,
      policyVersion: "w16-v1",
      priority: 100,
    });
}

export async function seedApiSwitch(): Promise<void> {
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "qianliu-deepseek",
      matchResourceMode: "API",
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchPriceMultiplierMin: null,
      matchRemainingQuotaRatioMax: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "SWITCH",
      switchEquivalentGroup: [resDsA, resDsB],
      rateLimitPerMinute: null,
      policyVersion: "w16-v1",
      priority: 30, // 最高优先级
    });
}
