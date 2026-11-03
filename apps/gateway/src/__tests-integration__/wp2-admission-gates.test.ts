/**
 * gateway WP2-S6 集成测试：使用控制与套餐回归电池（task 4.4 / AT-X04 机制层 + AT-AFR-09/10）。
 *
 * 世界：已激活企业（strict_writes_enabled）＋ API 资源无任何资金账户/期初（S2/0094 后世界）。
 * 逐项验证退役资金管理后其余准入与额度门禁全部保留原合同（AFR-05：使用控制与财务参考分开）：
 *   1. AT-AFR-09 机制层：员工 API 月额度不足＋allow_overage=false，资源带正余额经营快照
 *      （模拟"账户有钱"）→ 仍按额度合同拒绝，原因在额度域（月度周期结束），非余额域；零上游调用。
 *   2. AT-AFR-10 机制层：allow_overage=true → 模拟消费成功计量，真实用量与超额继续计量，
 *      授权配置（quota_value/allow_overage/quota_basis）不被清零/改写。
 *   3. Key 限制：principal_key.allowed_model_ids 不含目标模型 → 403 model_not_allowed（管线前拒绝，
 *      零 ai_request/attempt/ledger、零上游——principal-auth.ts createModelAuthorization 合同）。
 *   4. 项目限制：按现役机制构造＝主体授权门禁（principal_grant 状态 DISABLED）→ 403
 *      principal_grant_required；项目级配额走 legacy 计数器（既有锚点 w14-quota-gate.test.ts）。
 *   5. CPQW 套餐窗口耗尽（对照项）：quota_block_state 活跃 → 不进可服务集合（:443 语义），
 *      管理员手改 status 不放行；管线级强锚点＝cpqw-quota-window.test.ts :280/:319/:351＋
 *      DB quota-block 两套件（不重复造重型夹具）。
 *   6. 人工停用：资源归档（archived_at，生产 listCandidates 于 apps/gateway/src/main.ts:67-68
 *      排除）→ 不进候选 → 404 model_not_configured、零上游。provider_resource 无 DISABLED 状态
 *      （0005/0031 CHECK），"停用"的现役机制即归档。
 *   7. 凭证无效：CREDENTIAL_INVALID 隔离 → 不进可服务集合、503 no_healthy_candidate、零上游；
 *      额度同步不可解除凭证隔离（w11 :315 锚点）。S2 wp2-pending-admission.test.ts (c) 为
 *      DB 层锚点，本文件独立补管线 HTTP 路径断言。
 *   8. 真实 EXHAUSTED：EXHAUSTED 隔离 → 拒绝且零上游；恢复按原合同路径（额度同步
 *      QUOTA_SYNC_RECOVERED / 管理恢复 ADMIN_RECOVER → DEGRADED 待真实调用确认，
 *      w11 :282/:264 锚点与 AT-OAB-12"可按现有流程解除耗尽隔离"）。
 *   9. 纯 API 资金 PENDING 不阻断（对照项）：存量 PENDING 留档行可服务（S2 (b) 锚点对照）。
 *
 * 构造模式复用 cpqw-quota-window.test.ts（buildGateway + createRealPipeline + 生产形态
 * listCandidates + 记录上游调用的 caller）；不触达 :443/:451 生产代码语义。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  ResourcePoolRepository,
  QuotaGateRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";
import { RESOURCE_STATUS, STATE_REASON } from "@qianliu/domain";
import type { Outcome } from "@qianliu/contracts";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";

let pg: PostgresTestInstance;
let db: Database;
let poolRepo: ResourcePoolRepository;
let ledgerRepo: GatewayLedgerRepository;
const ENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const PEPPER = "wp2-admission-gates-pepper-32bytes!";
const SHANGHAI_MONTH_START = new Date("2026-11-01T00:00:00+08:00");

let deepseekProviderId: string;
let kimiProviderId: string;
let app: FastifyInstance;
/** 上游调用记录：所有"零上游调用"断言的数据源。 */
const upstreamCalls: Array<{ resourceId: string; mode: string }> = [];

interface Actor {
  principalId: string;
  key: string;
}

const actors: Record<string, Actor> = {};
const resources: Record<string, string> = {};
const models: Record<string, string> = {};

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function successOutcome(): Outcome {
  return {
    status: 200,
    committed: true,
    usage: { input: 10, output: 4, cache: 0, quality: "PROVIDER_REPORTED" },
  };
}

/** 生产形态 listCandidates（apps/gateway/src/main.ts:38-100 同构），仅限本世界自有资源。 */
const ownResourceIds = new Set<string>();
const listCandidates = async (entId: string, model: string): Promise<RouteCandidateRow[]> => {
  const routes = await db
    .selectFrom("model_route")
    .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "model_route.id as route_id",
      "provider_resource.id as resource_id",
      "provider_resource.provider_id",
      "unified_model.id as unified_model_id",
      "provider.code as provider_code",
      "model_route.upstream_model",
      "model_route.priority",
      "model_route.weight",
      "provider_resource.mode",
      "provider_resource.status",
    ])
    .where("model_route.enterprise_id", "=", entId)
    .where("unified_model.enterprise_id", "=", entId)
    .where("provider_resource.enterprise_id", "=", entId)
    .where("provider.enterprise_id", "=", entId)
    .where("unified_model.alias", "=", model)
    .where("model_route.enabled", "=", true)
    .where("provider.status", "=", "ACTIVE")
    .where("provider.archived_at", "is", null)
    .where("provider_resource.archived_at", "is", null)
    .execute();
  return routes
    .filter((r) => ownResourceIds.has(r.resource_id))
    .map((r) => ({
      routeId: r.route_id,
      resourceId: r.resource_id,
      providerCode: r.provider_code,
      providerId: r.provider_id,
      unifiedModelId: r.unified_model_id,
      upstreamModel: r.upstream_model,
      priority: r.priority,
      weight: r.weight,
      mode: r.mode as "API" | "CODING_PLAN",
      status: r.status,
      probe: false,
      principalId: "",
    }));
};

const caller: UpstreamCaller = async (resource) => {
  upstreamCalls.push({ resourceId: resource.resourceId, mode: resource.mode });
  return successOutcome();
};

async function insertModel(alias: string): Promise<string> {
  return (await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias, display_name: alias, status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow()).id;
}

async function insertActor(name: string, allowedModelIds: string[], type: "EMPLOYEE" | "PROJECT" = "EMPLOYEE"): Promise<Actor> {
  const principalId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: ENT_ID, type, name,
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify(allowedModelIds) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  return { principalId, key };
}

async function insertApiResourceWithRoute(name: string, modelId: string): Promise<string> {
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: deepseekProviderId, name,
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: modelId,
    provider_resource_id: resource.id, upstream_model: "wp2-upstream", priority: 100, weight: 1,
  }).execute();
  ownResourceIds.add(resource.id);
  return resource.id;
}

/** 已用/预估差额构造：请求体预估 raw = ceil(chars/4)+256（远超下列小额度，确定性不足）。 */
async function insertMonthlyGrant(input: {
  principalId: string; quotaValue: bigint; allowOverage: boolean;
}) {
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: input.principalId, provider: "deepseek",
    model_alias: "*", pool_model_alias: "*", quota_value: input.quotaValue,
    allow_overage: input.allowOverage, quota_basis: "RAW_TOKEN",
    status: "ACTIVE", valid_from: new Date(0),
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  return grant.id;
}

beforeAll(async () => {
  pg = await startPostgresContainer("wp2_admission_gates");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);
  ledgerRepo = new GatewayLedgerRepository(db);

  await db.insertInto("enterprise").values({
    id: ENT_ID, name: "仟流测试-WP2使用控制电池", timezone: "Asia/Shanghai",
    employee_quota_monthly_from: SHANGHAI_MONTH_START,
  }).execute();
  await db.insertInto("admin_user").values({
    id: ADMIN_ID, enterprise_id: ENT_ID, username: "wp2-s6-admin",
    display_name: "WP2-S6", password_hash: "test",
  }).execute();
  // 已激活企业（S2 后世界：资源无任何资金账户/期初）。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: ENT_ID, strict_writes_enabled: true,
    activated_at: new Date("2026-10-01T00:00:00+08:00"), activated_by_admin_user_id: ADMIN_ID,
  }).execute();

  deepseekProviderId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returning("id").executeTakeFirstOrThrow()).id;
  kimiProviderId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "Kimi", name: "Kimi", adapter_type: "kimi",
  }).returning("id").executeTakeFirstOrThrow()).id;

  // 模型与资源（每场景独立模型/资源/主体，互不污染）。
  models.quota = await insertModel("wp2-quota-model");
  models.overage = await insertModel("wp2-overage-model");
  models.keyr = await insertModel("wp2-keyr-model");
  models.unrelated = await insertModel("wp2-unrelated-model");
  models.proj = await insertModel("wp2-proj-model");
  models.arch = await insertModel("wp2-arch-model");
  models.cred = await insertModel("wp2-cred-model");
  models.exh = await insertModel("wp2-exh-model");

  resources.quota = await insertApiResourceWithRoute("wp2-quota-resource", models.quota);
  resources.overage = await insertApiResourceWithRoute("wp2-overage-resource", models.overage);
  resources.keyr = await insertApiResourceWithRoute("wp2-keyr-resource", models.keyr);
  resources.proj = await insertApiResourceWithRoute("wp2-proj-resource", models.proj);
  resources.arch = await insertApiResourceWithRoute("wp2-arch-resource", models.arch);
  resources.cred = await insertApiResourceWithRoute("wp2-cred-resource", models.cred);
  resources.exh = await insertApiResourceWithRoute("wp2-exh-resource", models.exh);
  resources.pending = await insertApiResourceWithRoute("wp2-pending-resource", models.unrelated);
  await seedMissingBillingRules(db, ENT_ID);

  // AT-AFR-09 专属：资源带正余额经营快照（模拟"官方/厂商账户有钱"）。
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: ENT_ID, provider_resource_id: resources.quota, version: 1, source: "ADMIN",
    collected_at: new Date("2026-11-01T00:00:00+08:00"), currency: "CNY",
    recharge_amount: "100.00000000", current_balance: "88.88000000",
    balance_updated_at: new Date("2026-11-01T00:00:00+08:00"),
  }).execute();

  // CPQW 对照资源：活跃 block（手改 status 为 DEGRADED 模拟"管理只改可见状态"）＋ 无 block 对照。
  resources.cpBlocked = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: kimiProviderId, name: "wp2-cp-blocked",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", status: "DEGRADED",
    quota_block_state: JSON.stringify({
      schemaVersion: 1, incidentId: randomUUID(), credentialVersion: null,
      startedAt: new Date().toISOString(), unknownWindow: false,
      windows: [{ type: "FIVE_HOUR", observedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 3_600_000).toISOString(), resetSource: "UPSTREAM_RESET_AT" }],
    }) as unknown as Record<string, unknown>,
  }).returning("id").executeTakeFirstOrThrow()).id;
  ownResourceIds.add(resources.cpBlocked);
  resources.cpControl = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: kimiProviderId, name: "wp2-cp-control",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", status: "DEGRADED",
  }).returning("id").executeTakeFirstOrThrow()).id;
  ownResourceIds.add(resources.cpControl);

  // 存量 PENDING 留档行（0094 后种入已退役，直插构造；D4 留档不参与调度语义由本用例对照）。
  await db.insertInto("provider_resource_finance_state").values({
    enterprise_id: ENT_ID, provider_resource_id: resources.pending,
    required_currencies: JSON.stringify([]) as never,
  }).execute();

  // 主体与授权。
  actors.quota = await insertActor("wp2-quota-员工", [models.quota]);
  await insertMonthlyGrant({ principalId: actors.quota.principalId, quotaValue: 100n, allowOverage: false });
  actors.overage = await insertActor("wp2-overage-员工", [models.overage]);
  await insertMonthlyGrant({ principalId: actors.overage.principalId, quotaValue: 10n, allowOverage: true });
  actors.keyr = await insertActor("wp2-keyr-员工", [models.unrelated]);
  await insertMonthlyGrant({ principalId: actors.keyr.principalId, quotaValue: 1_000_000n, allowOverage: false });
  actors.proj = await insertActor("wp2-项目", [models.proj], "PROJECT");
  const projGrant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: actors.proj.principalId, provider: "deepseek",
    model_alias: "*", pool_model_alias: "*", quota_value: 1_000_000n,
    allow_overage: false, status: "ACTIVE", valid_from: new Date(0),
  }).returning("id").executeTakeFirstOrThrow();
  // 项目限制的现役机制＝主体授权门禁：停用项目授权（principal_grant.status=DISABLED，0004 CHECK）。
  await db.updateTable("principal_grant").set({ status: "DISABLED" })
    .where("id", "=", projGrant.id).execute();
  actors.arch = await insertActor("wp2-arch-员工", [models.arch]);
  await insertMonthlyGrant({ principalId: actors.arch.principalId, quotaValue: 1_000_000n, allowOverage: false });
  actors.cred = await insertActor("wp2-cred-员工", [models.cred]);
  await insertMonthlyGrant({ principalId: actors.cred.principalId, quotaValue: 1_000_000n, allowOverage: false });
  actors.exh = await insertActor("wp2-exh-员工", [models.exh]);
  await insertMonthlyGrant({ principalId: actors.exh.principalId, quotaValue: 1_000_000n, allowOverage: false });

  // 真实 EXHAUSTED（直插隔离态，同 w11 :282 构造形态）。
  await db.updateTable("provider_resource").set({ status: "EXHAUSTED" })
    .where("id", "=", resources.exh).execute();

  const pipeline = createRealPipeline({
    db, ledgerRepo, caller, poolRepo, quotaRepo: new QuotaGateRepository(db), listCandidates,
    maxAttempts: 2,
  });
  app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function attemptsFor(resourceId: string) {
  return db.selectFrom("upstream_attempt").selectAll()
    .where("provider_resource_id", "=", resourceId).execute();
}

describe("WP2-S6 使用控制与套餐回归电池（AT-X04 / AT-AFR-09/10 机制层）", () => {
  it("AT-AFR-09：员工月额度不足＋禁止超额，快照正余额（账户有钱）仍按额度合同拒绝，原因在额度域，零上游", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    // 前提确认：资源可服务（正余额快照不影响准入）；快照余额为正（"账户有钱"）。
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).toContain(resources.quota);
    const snapshot = await db.selectFrom("provider_resource_operating_snapshot").selectAll()
      .where("provider_resource_id", "=", resources.quota).executeTakeFirstOrThrow();
    expect(Number(snapshot.current_balance)).toBeGreaterThan(0);
    expect(Number(snapshot.recharge_amount)).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.quota.key),
      payload: { model: "wp2-quota-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    // 拒绝原因在额度域：主体（员工）月度额度耗尽语义，不提"余额/账户有钱"。
    expect(body.error.code).toBe("provider_quota_exhausted");
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("额度已用完");
    expect(body.error.message).not.toContain("余额");
    // 月度周期合同：重置点＝员工月度周期结束（DB principal_quota_period 同源）。
    const period = await db.selectFrom("principal_quota_period").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", actors.quota.principalId).executeTakeFirstOrThrow();
    expect(period.period_key).toBe("2026-11");
    expect(body.error.next_reset_at).toBe(new Date(period.period_end).toISOString());
    expect(period.allow_overage).toBe(false);

    // 零上游调用＋零账本事实（拒绝发生在预占前，预占未生效）。
    expect(upstreamCalls).toHaveLength(0);
    expect(await attemptsFor(resources.quota)).toEqual([]);
    expect(await db.selectFrom("ledger_line").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", actors.quota.principalId).execute()).toEqual([]);
    expect(period.used_value).toBe("0");
    expect(period.reserved_value).toBe("0");
  });

  it("AT-AFR-10：允许超额授权放行，真实用量与超额继续计量，授权配置不被清零/改写", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    const grantBefore = await db.selectFrom("principal_grant").selectAll()
      .where("principal_id", "=", actors.overage.principalId).executeTakeFirstOrThrow();

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.overage.key),
      payload: { model: "wp2-overage-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(200);

    // 真实用量继续计量（raw 10+4=14），实际消耗超限（14 > 10）记录超额。
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.resourceId).toBe(resources.overage);
    const period = await db.selectFrom("principal_quota_period").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", actors.overage.principalId).executeTakeFirstOrThrow();
    expect(period).toMatchObject({ period_key: "2026-11", limit_value: "10", used_value: "14", reserved_value: "0" });
    const request = await db.selectFrom("ai_request").selectAll()
      .where("principal_id", "=", actors.overage.principalId).executeTakeFirstOrThrow();
    const transaction = await db.selectFrom("ledger_transaction").selectAll()
      .where("ai_request_id", "=", request.id).executeTakeFirstOrThrow();
    expect(transaction.overage).toBe(true);

    // 授权配置不被清零/改写（allow_overage/quota_value/quota_basis/pool 行原样）。
    const grantAfter = await db.selectFrom("principal_grant").selectAll()
      .where("principal_id", "=", actors.overage.principalId).executeTakeFirstOrThrow();
    expect(grantAfter.allow_overage).toBe(true);
    expect(grantAfter.quota_value).toBe(grantBefore.quota_value);
    expect(grantAfter.quota_basis).toBe(grantBefore.quota_basis);
    expect(grantAfter.pool_model_alias).toBe(grantBefore.pool_model_alias);
    expect(grantAfter.status).toBe("ACTIVE");
    // 冻结周期保留创建时授权口径（既有 0092 合同：月内配置变化不回写已开周期）。
    expect(period.allow_overage).toBe(true);
    expect(period.quota_basis).toBe("RAW_TOKEN");
  });

  it("Key 限制：allowed_model_ids 不含目标模型 → 403 model_not_allowed，零账本事实零上游", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.keyr.key),
      payload: { model: "wp2-keyr-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("model_not_allowed");
    expect(body.error.retryable).toBe(false);

    // 管线前拒绝：不创建 ai_request/attempt/ledger，不访问上游（principal-auth 合同）。
    expect(upstreamCalls).toHaveLength(0);
    expect(await db.selectFrom("ai_request").selectAll()
      .where("principal_id", "=", actors.keyr.principalId).execute()).toEqual([]);
    expect(await attemptsFor(resources.keyr)).toEqual([]);
    expect(await db.selectFrom("ledger_line").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", actors.keyr.principalId).execute()).toEqual([]);
  });

  it("项目限制：项目授权停用（grant DISABLED）→ 403 principal_grant_required，零上游", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.proj.key),
      payload: { model: "wp2-proj-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("principal_grant_required");
    expect(body.error.retryable).toBe(false);

    expect(upstreamCalls).toHaveLength(0);
    expect(await attemptsFor(resources.proj)).toEqual([]);
    const request = await db.selectFrom("ai_request").selectAll()
      .where("principal_id", "=", actors.proj.principalId).executeTakeFirstOrThrow();
    expect(request).toMatchObject({ status: "FAILED", error_code: "principal_grant_required" });
  });

  it("CPQW 套餐窗口耗尽（对照项）：quota_block_state 活跃 → 不进可服务集合，手改 status 不放行", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    // :443 语义：活跃 block 阻止生成，与可见 status 无关（管理员手改 DEGRADED 不清 block）。
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).not.toContain(resources.cpBlocked);
    expect(servable.map((s) => s.id)).toContain(resources.cpControl);
    const blockedRow = await db.selectFrom("provider_resource").select(["status", "quota_block_state"])
      .where("id", "=", resources.cpBlocked).executeTakeFirstOrThrow();
    expect(blockedRow.status).toBe("DEGRADED");
    expect(blockedRow.quota_block_state).not.toBeNull();
    // 管线级强锚点＝cpqw-quota-window.test.ts :280/:319/:351＋DB quota-block 两套件（本文件不重复造重型夹具）。
  });

  it("人工停用（归档）：资源不进候选 → 404 model_not_configured，零上游", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    // 与 POST /provider-resources/:id/archive（providerRepo.archiveResource）同构：置 archived_at。
    await db.updateTable("provider_resource").set({ archived_at: new Date() })
      .where("id", "=", resources.arch).execute();

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.arch.key),
      payload: { model: "wp2-arch-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("model_not_configured");

    expect(upstreamCalls).toHaveLength(0);
    expect(await attemptsFor(resources.arch)).toEqual([]);
    // 生产候选查询按 archived_at 排除（main.ts:68 同构过滤）——无任何候选产出。
    const candidates = await listCandidates(ENT_ID, "wp2-arch-model");
    expect(candidates).toEqual([]);
  });

  it("凭证无效：CREDENTIAL_INVALID 隔离拒绝、503 零上游；额度同步不可解除凭证隔离", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    const transition = await poolRepo.recordFailure(
      resources.cred, "UPSTREAM_CREDENTIAL_INVALID", new Date(),
    );
    expect(transition).not.toBeNull();
    expect(transition!.toStatus).toBe(RESOURCE_STATUS.CREDENTIAL_INVALID);
    expect(transition!.reason).toBe(STATE_REASON.CREDENTIAL_REJECTED);
    expect(transition!.isolates).toBe(true);

    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).not.toContain(resources.cred);

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.cred.key),
      payload: { model: "wp2-cred-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("no_healthy_candidate");

    expect(upstreamCalls).toHaveLength(0);
    expect(await attemptsFor(resources.cred)).toEqual([]);
    // 厂商额度同步只解除额度隔离，不能解除凭证隔离（w11 :315 锚点语义）。
    expect(await poolRepo.recordQuotaSyncRecovery(resources.cred)).toBeNull();
    expect((await poolRepo.getResource(resources.cred))?.status).toBe("CREDENTIAL_INVALID");
  });

  it("真实 EXHAUSTED：隔离拒绝零上游；解除耗尽隔离仍按原合同恢复路径（额度同步/管理恢复 → DEGRADED）", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).not.toContain(resources.exh);

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: authHeader(actors.exh.key),
      payload: { model: "wp2-exh-model", messages: [{ role: "user", content: "isolated test" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("no_healthy_candidate");
    expect(upstreamCalls).toHaveLength(0);
    expect(await attemptsFor(resources.exh)).toEqual([]);

    // 原恢复合同：额度接口确认窗口恢复 → DEGRADED/QUOTA_SYNC_RECOVERED（w11 :282 锚点）；
    // 随后真实调用确认（recordSuccess）回到 ACTIVE。管理恢复（adminRecover）对隔离态同样
    // 产出 DEGRADED/ADMIN_RECOVER（deriveAdminRecovery；AT-OAB-12"可按现有流程解除耗尽隔离"）。
    const synced = await poolRepo.recordQuotaSyncRecovery(resources.exh);
    expect(synced).toMatchObject({
      toStatus: RESOURCE_STATUS.DEGRADED, reason: STATE_REASON.QUOTA_SYNC_RECOVERED, cooldownUntil: null,
    });
    expect(await poolRepo.recordSuccess(resources.exh)).toMatchObject({ toStatus: RESOURCE_STATUS.ACTIVE });

    // 第二个 EXHAUSTED 资源验证管理恢复路径（DB 层，无路由依赖）。
    const second = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: kimiProviderId, name: "wp2-exh-admin-recover",
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", status: "EXHAUSTED",
    }).returning("id").executeTakeFirstOrThrow();
    const recovered = await poolRepo.adminRecover(second.id);
    expect(recovered).toMatchObject({
      toStatus: RESOURCE_STATUS.DEGRADED, reason: STATE_REASON.ADMIN_RECOVER, isolates: false,
    });
    expect((await poolRepo.listStatusEvents(second.id)).at(-1)).toMatchObject({
      from_status: "EXHAUSTED", to_status: "DEGRADED", reason: STATE_REASON.ADMIN_RECOVER, actor: "admin",
    });
  });

  it("纯 API 资金 PENDING 不阻断（对照项）：存量 PENDING 留档行资源可服务", async () => {
    upstreamCalls.length = 0; // 各用例独立计数上游调用。
    const stateRow = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", resources.pending).executeTakeFirstOrThrow();
    expect(stateRow.state).toBe("PENDING");
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).toContain(resources.pending);
    // S2 DB/网关锚点＝wp2-pending-admission.test.ts (a)/(b)；本文件以对照项保留独立断言。
  });
});
