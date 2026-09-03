import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createKysely, GatewayLedgerRepository, migrateToLatest, QuotaGateRepository,
  ResourcePoolRepository, RuntimeAssuranceRepository, type Database,
} from "@qianliu/database";
import { generateApiKey, digestApiKey, apiKeyPrefix, type UpstreamCaller } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { buildGateway } from "../server.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";
import { createRealPipeline } from "../pipeline/real-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let key: string;
let mode: "QUOTA" | "WINDOW" | "TECHNICAL" = "QUOTA";
const enterpriseId = randomUUID();
const principalId = randomUUID();
const pepper = "ra-gateway-test-pepper-32bytes!!!";
let resourceId: string;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "RA Gateway" }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "RA User" }).execute();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId, alias: "qianliu-glm", display_name: "GLM", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId, principal_id: principalId, key_prefix: apiKeyPrefix(key),
    key_digest: digestApiKey(key, pepper), allowed_model_ids: JSON.stringify([model.id]) as unknown as string[], status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "zhipu", name: "智谱", adapter_type: "zhipu",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "GLM Plan",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow();
  resourceId = resource.id;
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: model.id,
    provider_resource_id: resource.id, upstream_model: "glm-5.2",
  }).execute();
  await seedMissingBillingRules(db, enterpriseId);
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "zhipu",
    model_alias: "qianliu-glm", quota_value: 1_000_000n,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

  const runtimeRepo = new RuntimeAssuranceRepository(db);
  const actorId = randomUUID();
  await db.insertInto("admin_user").values({
    id: actorId, enterprise_id: enterpriseId, username: "ra-admin", password_hash: "test-only-hash", status: "ACTIVE",
  }).execute();
  const rule = await runtimeRepo.createRule({
    name: "智谱额度熔断", ruleType: "UPSTREAM_SIGNAL", actorId,
    version: { unified_signal: "QUOTA_EXHAUSTED", action: "BLOCK", recovery_method: "UPSTREAM_RESET_TIME", fallback_duration_seconds: 600 },
  });
  await runtimeRepo.publishRule(rule.rule.id, rule.current_version.version, rule.rule.created_by!);
  const windowRule = await runtimeRepo.createRule({
    name: "厂商额度窗口限流", ruleType: "UPSTREAM_SIGNAL", actorId,
    version: { unified_signal: "RATE_LIMIT_RETRY_AFTER", action: "BLOCK", recovery_method: "UPSTREAM_RESET_TIME", fallback_duration_seconds: 600 },
  });
  await runtimeRepo.publishRule(windowRule.rule.id, windowRule.current_version.version, windowRule.rule.created_by!);
  const warn = await runtimeRepo.createRule({
    name: "技术故障预警", ruleType: "OBSERVATION_ALERT", actorId,
    version: { unified_signal: "TECHNICAL_FAILURE", action: "WARN_ONLY", recovery_method: null },
  });
  await runtimeRepo.publishRule(warn.rule.id, warn.current_version.version, warn.rule.created_by!);

  const caller: UpstreamCaller = async () => {
    if (mode === "QUOTA") return {
      status: 429, committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      error: "1310", upstreamCode: "1310", upstreamErrorKind: "QUOTA_EXHAUSTED",
      unifiedAvailabilitySignal: "QUOTA_EXHAUSTED", retryAfterMs: 600_000,
      recoverAt: new Date(Date.now() + 600_000).toISOString(),
    };
    if (mode === "WINDOW") return {
      status: 403, committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      error: "window_exhausted", upstreamErrorKind: "WINDOW_EXHAUSTED",
      unifiedAvailabilitySignal: "RATE_LIMIT_RETRY_AFTER", retryAfterMs: 600_000,
      recoverAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    };
    return {
      status: 503, committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      error: "upstream_http_503", unifiedAvailabilitySignal: "TECHNICAL_FAILURE",
    };
  };
  const ledgerRepo = new GatewayLedgerRepository(db);
  const poolRepo = new ResourcePoolRepository(db);
  const quotaRepo = new QuotaGateRepository(db);
  const pipeline = createRealPipeline({
    db, ledgerRepo, poolRepo, quotaRepo, runtimeAssuranceRepo: runtimeRepo,
    runtimeAssuranceMode: "ENFORCE", runtimeAssuranceWecomNotify: false,
    caller, maxAttempts: 1,
    listCandidates: async () => [{
      resourceId: resource.id, providerId: provider.id, unifiedModelId: model.id,
      providerCode: "zhipu", upstreamModel: "glm-5.2", priority: 100, weight: 100,
      mode: "CODING_PLAN", status: "ACTIVE", probe: false, principalId,
    }],
  });
  app = buildGateway(db, pepper, pipeline);
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

const request = (url: "/v1/chat/completions" | "/v1/messages") => app.inject({
  method: "POST", url,
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  payload: url === "/v1/messages"
    ? { model: "qianliu-glm", messages: [{ role: "user", content: "hi" }], max_tokens: 20 }
    : { model: "qianliu-glm", messages: [{ role: "user", content: "hi" }] },
});

describe("RA-W04 Gateway 运行保障纵向链路", () => {
  it("智谱额度信号产生唯一事件并返回中文恢复合同", async () => {
    const first = await request("/v1/chat/completions");
    expect(first.statusCode).toBe(503);
    expect(first.json().error).toMatchObject({
      code: "upstream_availability_blocked", retryable: true,
    });
    expect(first.json().error.message).toContain("上游额度已耗尽");
    expect(first.json().error.event_id).toMatch(/^BRK-/);
    expect(first.json().error.recover_at).toBeDefined();

    const second = await request("/v1/chat/completions");
    expect(second.statusCode).toBe(503);
    const open = await db.selectFrom("availability_event").selectAll().where("status", "=", "OPEN").execute();
    expect(open).toHaveLength(1);
  });

  it("Anthropic 外层协议保留，内部同样包含事件和恢复字段", async () => {
    const response = await request("/v1/messages");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "api_error", event_id: expect.stringMatching(/^BRK-/) },
    });
  });

  it("额度窗口熔断在 Anthropic 协议下仍返回 429", async () => {
    await db.updateTable("availability_event").set({ status: "CANCELLED", recovered_at: new Date(), recovery_reason: "测试切换" })
      .where("status", "=", "OPEN").execute();
    const poolRepo = new ResourcePoolRepository(db);
    await poolRepo.adminRecover(resourceId);
    await poolRepo.recordSuccess(resourceId);
    mode = "WINDOW";

    const response = await request("/v1/messages");
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      type: "error",
      error: {
        type: "rate_limit_error",
        code: "upstream_availability_blocked",
        retryable: true,
        event_id: expect.stringMatching(/^BRK-/),
      },
    });
    expect(response.headers["retry-after"]).toBeDefined();
    const recoverAt = Date.parse(response.json().error.recover_at);
    expect(recoverAt).toBeGreaterThan(Date.now());
    expect(recoverAt).toBeLessThanOrEqual(Date.now() + 6 * 60 * 60_000);
  });

  it("普通 5xx 连续发生只 DEGRADED + 预警，不创建硬熔断事件", async () => {
    await db.updateTable("availability_event").set({ status: "CANCELLED", recovered_at: new Date(), recovery_reason: "测试切换" })
      .where("status", "=", "OPEN").execute();
    const poolRepo = new ResourcePoolRepository(db);
    await poolRepo.adminRecover(resourceId);
    await poolRepo.recordSuccess(resourceId);
    mode = "TECHNICAL";
    for (let index = 0; index < 4; index += 1) await request("/v1/chat/completions");
    const resource = await db.selectFrom("provider_resource").selectAll().where("id", "=", resourceId).executeTakeFirstOrThrow();
    expect(resource.status).toBe("DEGRADED");
    const open = await db.selectFrom("availability_event").selectAll().where("status", "=", "OPEN").execute();
    expect(open).toHaveLength(0);
    const warning = await db.selectFrom("alert_event").selectAll().where("signal", "=", "TECHNICAL_FAILURE").executeTakeFirst();
    expect(warning).toBeDefined();
  });
});
