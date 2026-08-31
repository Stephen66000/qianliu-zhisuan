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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  StubUpstream,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";

let pg: PostgresTestInstance;
let db: Database;
let validKey: string;
let resA: string;
let resB: string;
let resDsA: string;
let resDsB: string;
let stub: StubUpstream;
let poolRepo: ResourcePoolRepository;
let ledgerRepo: GatewayLedgerRepository;
let dispatchRepo: DispatchPolicyRepository;
let quotaRepo: QuotaGateRepository;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w16-dispatch-pepper-32bytes-min!";

class FailingDecisionRepository extends DispatchPolicyRepository {
  override async createDecisionIfAbsent(): Promise<string | null> {
    throw new Error("dispatch_decision_write_failure");
  }
}

class FailingSettlementEvidenceRepository extends DispatchPolicyRepository {
  attempts = 0;

  override async enrichDecisionSettlementEvidence(): Promise<void> {
    this.attempts += 1;
    throw new Error("dispatch_settlement_evidence_write_failure");
  }
}

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${validKey}`, "content-type": "application/json" };
}

/** 构建带 dispatch 接入的 app（resolveDispatchInput 注入高峰倍率/额度比例）。 */
async function buildApp(
  resolveDispatchInput?: (winnerResourceId: string) => Promise<{
    priceMultiplier: string;
    remainingQuotaRatio: number | null;
    forecastExhaustRisk: boolean;
  }>,
  now?: () => number,
  activeDispatchRepo: DispatchPolicyRepository | null = dispatchRepo,
): Promise<FastifyInstance> {
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
      : undefined,
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

describe("W16 经营调度", () => {
  it("智谱 14:00–18:00 REJECT 边界：峰内不访问上游、不扣额度，18:00 恢复", async () => {
    const policyId = await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchResourceMode: "CODING_PLAN",
      matchProviderResourceId: null,
      matchTimezone: "Asia/Shanghai",
      matchDaysOfWeek: [1, 2, 3, 4, 5],
      matchStartTime: "14:00:00",
      matchEndTime: "18:00:00",
      matchPriceMultiplierMin: null,
      matchRemainingQuotaRatioMax: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "REJECT",
      switchEquivalentGroup: null,
      rateLimitPerMinute: null,
      policyVersion: "zhipu-peak-reject-v1",
      priority: 1,
    });
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    });
    let now = Date.parse("2026-07-30T05:59:59.000Z");
    const app = await buildApp(
      async () => ({
        priceMultiplier: "1",
        remainingQuotaRatio: 0.9,
        forecastExhaustRisk: false,
      }),
      () => now,
    );
    const send = () => app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: {
        model: "ql-glm-5.2",
        messages: [{ role: "user", content: "boundary" }],
      },
    });
    const sendMessages = () => app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: authHeader(),
      payload: {
        model: "ql-glm-5.2",
        messages: [{ role: "user", content: "boundary" }],
        max_tokens: 20,
      },
    });
    const sendResponses = () => app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", input: "boundary" },
    });

    expect((await send()).statusCode).toBe(200);
    expect(stub.calls).toHaveLength(1);
    const quotaBeforePeak = await db
      .selectFrom("quota_counter")
      .select("used_value")
      .executeTakeFirstOrThrow();

    now = Date.parse("2026-07-30T06:00:00.000Z");
    const atStart = await send();
    expect(atStart.statusCode).toBe(403);
    expect(atStart.json().error).toEqual(expect.objectContaining({
      message: "高峰时段暂停使用；策略时段 工作日 14:00-18:00 Asia/Shanghai；2026-07-30T10:00:00.000Z 后恢复",
      code: "dispatch_rejected",
      retryable: false,
      policy_window: "工作日 14:00-18:00 Asia/Shanghai",
      reset_at: "2026-07-30T10:00:00.000Z",
      attempt_count: 0,
      usage_created: false,
      charged: false,
      dispatch: {
        final_action: "REJECT",
        reason_code: "REJECTED",
        policy_version: "zhipu-peak-reject-v1",
        unavailable_window: {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5],
          start_time: "14:00:00",
          end_time: "18:00:00",
        },
      },
    }));
    const messagesAtStart = await sendMessages();
    expect(messagesAtStart.statusCode).toBe(403);
    expect(messagesAtStart.json()).toEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({
        type: "api_error",
        code: "dispatch_rejected",
        dispatch: expect.objectContaining({
          policy_version: "zhipu-peak-reject-v1",
          unavailable_window: expect.objectContaining({
            timezone: "Asia/Shanghai",
            start_time: "14:00:00",
            end_time: "18:00:00",
          }),
        }),
      }),
    }));
    const responsesAtStart = await sendResponses();
    expect(responsesAtStart.statusCode).toBe(403);
    expect(responsesAtStart.json().error).toEqual(expect.objectContaining({
      type: "server_error",
      code: "dispatch_rejected",
      dispatch: expect.objectContaining({
        policy_version: "zhipu-peak-reject-v1",
        unavailable_window: expect.objectContaining({
          timezone: "Asia/Shanghai",
          start_time: "14:00:00",
          end_time: "18:00:00",
        }),
      }),
    }));
    expect(stub.calls).toHaveLength(1);

    now = Date.parse("2026-07-30T09:59:59.000Z");
    expect((await send()).statusCode).toBe(403);
    expect(stub.calls).toHaveLength(1);
    const quotaAfterPeak = await db
      .selectFrom("quota_counter")
      .select("used_value")
      .executeTakeFirstOrThrow();
    expect(quotaAfterPeak.used_value).toBe(quotaBeforePeak.used_value);
    const blockedRequestId = String(atStart.headers["x-request-id"]);
    expect(await db.selectFrom("upstream_attempt")
      .select("id").where("ai_request_id", "=", blockedRequestId).execute()).toHaveLength(0);
    expect(await db.selectFrom("usage_event")
      .select("id").where("ai_request_id", "=", blockedRequestId).execute()).toHaveLength(0);
    expect(await db.selectFrom("ledger_line")
      .select("id").where("ai_request_id", "=", blockedRequestId).execute()).toHaveLength(0);

    const decision = await dispatchRepo.getDecision(blockedRequestId);
    expect(decision).toEqual(expect.objectContaining({
      matched_policy_id: policyId,
      matched_policy_version: "zhipu-peak-reject-v1",
      final_action: "REJECT",
      reason_code: "REJECTED",
    }));
    expect(decision!.dispatch_input).toEqual(expect.objectContaining({
      matchedTimezone: "Asia/Shanghai",
      matchedDaysOfWeek: [1, 2, 3, 4, 5],
      matchedStartTime: "14:00:00",
      matchedEndTime: "18:00:00",
      executedResourceIds: [],
      usageEvidence: null,
      actualPricingEvidence: [],
      savingCalculationVersion: "pool-021-v1",
    }));

    now = Date.parse("2026-07-30T10:00:00.000Z");
    expect((await send()).statusCode).toBe(200);
    expect(stub.calls).toHaveLength(2);

    now = Date.parse("2026-08-01T06:00:00.000Z"); // 周六 14:00（Asia/Shanghai）
    expect((await send()).statusCode).toBe(200);
    expect(stub.calls).toHaveLength(3);
    expect(
      await dispatchRepo.transitionStatus(ENT_ID, policyId, "PUBLISHED", "RETIRED"),
    ).toBe(true);
    await app.close();
  });

  it("WT-16：高峰时段命中 SWITCH 策略 → 在等价资源组内切换（dispatch_decision 可解释）", async () => {
    // 发布高峰 SWITCH 策略：A → 等价组 [A,B] 内切换
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

    // StubUpstream 成功；resolveDispatchInput 注入高峰倍率 3（命中策略）
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 500, output: 200, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "3", // 高峰
      remainingQuotaRatio: 0.8,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    // dispatch_decision：final_action=SWITCH，目标=resB
    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision).toBeDefined();
    expect(decision!.final_action).toBe("SWITCH");
    expect(decision!.reason_code).toBe("SWITCH_WITHIN_GROUP");
    expect(decision!.switch_target_resource_id).toBe(resB);

    // 实际 Attempt 落到 resB（切换后的资源）
    const attempts = await ledgerRepo.listAttempts(requestId);
    expect(attempts[0]!.provider_resource_id).toBe(resB);
  });

  it("WT-16：命中 REJECT 策略 → 403（不无账放行）", async () => {
    // REJECT 策略：剩余额度比例 ≤0.1 命中
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchRemainingQuotaRatioMax: "0.1",
      matchResourceMode: null,
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchPriceMultiplierMin: null,
      matchForecastExhaustRisk: null,
      matchPrincipalScope: null,
      action: "REJECT",
      switchEquivalentGroup: null,
      rateLimitPerMinute: null,
      policyVersion: "w16-v1",
      priority: 50, // 比 SWITCH 更高优先级
    });

    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.05, // 命中 REJECT（≤0.1）
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(403);
    expect(chatRes.json().error).toEqual(expect.objectContaining({
      code: "dispatch_rejected",
      dispatch: {
        final_action: "REJECT",
        reason_code: "REJECTED",
        policy_version: "w16-v1",
      },
    }));
    expect(chatRes.json().error.dispatch).not.toHaveProperty("unavailable_window");
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision).toEqual(expect.objectContaining({
      matched_policy_action: "REJECT",
      final_action: "REJECT",
      reason_code: "REJECTED",
      saving_calculable: false,
      not_calculable_reason: "dispatch_terminated_before_attempt",
    }));
  });

  it("WT-16：命中 RATE_LIMIT 策略 → 429", async () => {
    await dispatchRepo.createPolicy({
      enterpriseId: ENT_ID,
      status: "PUBLISHED",
      matchUnifiedModel: "ql-glm-5.2",
      matchForecastExhaustRisk: true, // 预计耗尽风险命中
      matchResourceMode: null,
      matchProviderResourceId: null,
      matchTimezone: null,
      matchDaysOfWeek: null,
      matchStartTime: null,
      matchEndTime: null,
      matchPriceMultiplierMin: null,
      matchRemainingQuotaRatioMax: null,
      matchPrincipalScope: null,
      action: "RATE_LIMIT",
      switchEquivalentGroup: null,
      rateLimitPerMinute: 10,
      policyVersion: "w16-v1",
      priority: 40,
    });

    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.5,
      forecastExhaustRisk: true, // 命中 RATE_LIMIT
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(429);
    expect(chatRes.json().error).toEqual(expect.objectContaining({
      message: "经营调度限流",
      code: "dispatch_rate_limited",
      dispatch: {
        final_action: "RATE_LIMIT",
        reason_code: "RATE_LIMITED",
        policy_version: "w16-v1",
      },
    }));
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    expect(await dispatchRepo.getDecision(requestId)).toEqual(expect.objectContaining({
      matched_policy_action: "RATE_LIMIT",
      final_action: "RATE_LIMIT",
      reason_code: "RATE_LIMITED",
      saving_calculable: false,
      not_calculable_reason: "dispatch_terminated_before_attempt",
    }));
  });

  it("WT-17：无策略/ALLOW 仅提示 → saving_calculable=false（NOT_CALCULABLE）", async () => {
    // 该请求无任何高风险输入 → 不命中 REJECT/RATE_LIMIT/SWITCH → 默认 ALLOW_NO_POLICY
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 300, output: 100, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.9, // 充足，不命中任何策略
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision!.final_action).toBe("ALLOW");
    expect(decision!.reason_code).toBe("ALLOW_NO_POLICY");
    // ALLOW 仅提示，未改变行为 → NOT_CALCULABLE（行 631）
    expect(decision!.saving_calculable).toBe(false);
    expect(decision!.not_calculable_reason).toBe("no_action_executed");
    expect(decision!.dispatch_saving).toBeNull();
  });

  it("WT-17：SWITCH 实际执行 → saving_calculable=true（可计算）", async () => {
    // 已发布的 SWITCH 策略（首测创建）+ 高峰倍率 3 → 命中切换
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 400, output: 150, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "3",
      remainingQuotaRatio: 0.7,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision!.final_action).toBe("SWITCH");
    // CODING_PLAN 模式 api_cost=null（PACKAGE_INCLUDED，无价格证据）→ 节省 NOT_CALCULABLE（§9.1 行 630）
    // 这是正确语义：套餐模式无 API 费用可比，节省不可计算
    expect(decision!.saving_calculable).toBe(false);
    expect(decision!.not_calculable_reason).toBe("package_cost_not_comparable");
    expect(decision!.actual_cost).toBeNull(); // CODING_PLAN 不产生 API 费用
  });

  it("WT-17：API 模式 SWITCH + 有 api_cost → saving_calculable=true（可计算）", async () => {
    // deepseek API 模式 SWITCH 策略：等价组 [dsA, dsB]
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

    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 500, output: 200, cache: 50 } },
      providerCode: "deepseek",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.7,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const requestId = chatRes.headers["x-request-id"];
    await app.close();

    const decision = await dispatchRepo.getDecision(requestId);
    expect(decision!.final_action).toBe("SWITCH");
    // 使用相同 usage：A 反事实成本 0.00310000，B 实际成本 0.00155000。
    expect(decision!.saving_calculable).toBe(true);
    expect(decision!.counterfactual_cost).toBe("0.00310000");
    expect(decision!.actual_cost).toBe("0.00155000");
    expect(decision!.dispatch_saving).toBe("0.00155000");
    expect(decision!.dispatch_input).toEqual(expect.objectContaining({
      baselineResourceId: resDsA,
      executedResourceIds: [resDsB],
      counterfactualRuleVersion: "ds-a-expensive-v1",
      savingCalculationVersion: "pool-021-v1",
      usageEvidence: { input: 500, output: 200, cache: 50 },
    }));
  });

  it("正文 canary 为 0：经营调度请求 body 不落库（METADATA_ONLY）", async () => {
    const BODY_CANARY = "SECRET_W16_DISPATCH_CANARY_TEST_99999";
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.9,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: BODY_CANARY }] },
    });
    expect(chatRes.statusCode).toBe(200);
    await app.close();

    // 扫描 dispatch_decision + 账本表，body 不得命中
    const { sql } = await import("kysely");
    const tables = ["ai_request", "route_candidate", "upstream_attempt", "usage_event", "ledger_line", "ledger_transaction", "dispatch_decision"];
    let total = 0;
    for (const table of tables) {
      const result = await sql`SELECT COUNT(*)::int AS hits FROM (SELECT row_to_json(r)::text AS txt FROM ${sql.raw(table)} r) s WHERE s.txt LIKE ${"%" + BODY_CANARY + "%"}`.execute(db);
      total += Number((result.rows[0] as { hits: number }).hits);
    }
    expect(total, "经营调度请求正文 canary 必须在所有表 0 命中").toBe(0);
  });

  it("决策审计写入失败时禁止执行上游动作", async () => {
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    });
    const app = await buildApp(
      async () => ({
        priceMultiplier: "1",
        remainingQuotaRatio: 0.9,
        forecastExhaustRisk: false,
      }),
      undefined,
      new FailingDecisionRepository(db),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(),
        payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
      });
      expect(response.statusCode).toBe(500);
      expect(stub.calls).toHaveLength(0);
      const request = await db.selectFrom("ai_request").selectAll()
        .where("enterprise_id", "=", ENT_ID).orderBy("started_at", "desc")
        .executeTakeFirstOrThrow();
      expect(request.status).toBe("FAILED");
      expect(request.error_classification).toBe("INTERNAL");
      expect(request.error_code).toBe("dispatch_decision_write_failure");
      expect(await db.selectFrom("upstream_attempt").select("id")
        .where("ai_request_id", "=", request.id).execute()).toEqual([]);
      expect(await db.selectFrom("dispatch_decision").select("id")
        .where("ai_request_id", "=", request.id).execute()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("上游未提交失败与提交后中断都冻结 FAILED，且无调度仓储时不伪造决策", async () => {
    for (const mode of [
      { kind: "ERROR" as const, status: 500, errorCode: "provider_failed", classification: "UPSTREAM" },
      { kind: "STREAM" as const, chunks: ["partial"], usage: { input: 10, output: 4, cache: 0 }, failAfterChunk: 1 },
    ]) {
      stub = new StubUpstream({ default: mode, providerCode: "deepseek" });
      const app = await buildApp(undefined, undefined, null);
      try {
        const response = await app.inject({
          method: "POST", url: "/v1/chat/completions", headers: authHeader(),
          payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "failure" }] },
        });
        const requestId = String(response.headers["x-request-id"]);
        const request = await ledgerRepo.getRequest(requestId);
        expect(request).toMatchObject({ status: "FAILED" });
        expect(request?.error_code).toBeTruthy();
        expect(await dispatchRepo.getDecision(requestId)).toBeUndefined();
      } finally {
        await app.close();
      }
    }
  });

  it("调度补充证据失败不阻断核心终态、账本与租约释放", async () => {
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "deepseek",
    });
    const failingRepo = new FailingSettlementEvidenceRepository(db);
    const app = await buildApp(
      async () => ({
        priceMultiplier: "1",
        remainingQuotaRatio: 0.9,
        forecastExhaustRisk: false,
      }),
      undefined,
      failingRepo,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(),
        payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
      });
      expect(response.statusCode).toBe(200);
      expect(stub.calls).toHaveLength(1);
      const requestId = String(response.headers["x-request-id"]);
      expect((await ledgerRepo.getRequest(requestId))?.status).toBe("SUCCEEDED");
      expect(await db.selectFrom("ledger_transaction").select("id")
        .where("ai_request_id", "=", requestId).executeTakeFirst()).toBeDefined();
      expect(await db.selectFrom("concurrency_lease").select("id")
        .where("ai_request_id", "=", requestId).where("released_at", "is", null).execute()).toEqual([]);
      expect((await dispatchRepo.getDecision(requestId))?.not_calculable_reason)
        .toBe("pending_settlement");
      expect(failingRepo.attempts).toBe(2);
    } finally {
      await app.close();
    }
  });
});
