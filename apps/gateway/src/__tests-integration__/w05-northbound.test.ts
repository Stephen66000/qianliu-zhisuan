/**
 * gateway W05 契约测试：北向合同冻结（M2 代表性运行链）。
 *
 * 覆盖：
 *   - GET /v1/models 返回 OpenAI 兼容形状
 *   - POST /v1/chat/completions 非流式 + 流式（OpenAI chat.completion / chunk）
 *   - POST /v1/messages（Anthropic）
 *   - WT-14：未支持能力 422 + capability_not_supported + 不可重试
 *   - 鉴权：无 Bearer / 无效 Key / 停用主体 401
 *   - request_id 贯穿响应头
 *
 * 用 Testcontainer PG + 真实 Key（M1 schema）+ stub pipeline。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  createKysely,
  EmployeeModelRuleRepository,
  GatewayLedgerRepository,
  migrateToLatest,
  QuotaGateRepository,
  ResourcePoolRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { hasCurrentInvocationAuthorization } from "../auth/current-model-authorization.js";
import { createRealPipeline } from "../pipeline/real-pipeline.js";
import { stubPipeline } from "../pipeline/stub-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let validKey: string;
let keyId: string;
let allowedModelId: string;
let grantId: string;
let providerId: string;
let resourceId: string;
let routeId: string;
let billingRuleId: string;
let pipelineCalls = 0;
let lastAuthorizedModelId: string | undefined;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w05-test-pepper-32bytes-min!!!!";

beforeAll(async () => {
  pg = process.env.POOL043_W05_DATABASE_URL
    ? { connectionString: process.env.POOL043_W05_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  // 种子：企业 + principal + principal_key + unified_model
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试" }).execute();
  await db
    .insertInto("principal")
    .values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" })
    .execute();
  validKey = generateApiKey();
  keyId = (await db
    .insertInto("principal_key")
    .values({
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      key_prefix: apiKeyPrefix(validKey),
      key_digest: digestApiKey(validKey, PEPPER),
      allowed_model_ids: JSON.stringify([]) as unknown as string[],
      status: "ACTIVE",
    })
    .returning("id")
    .executeTakeFirstOrThrow()).id;
  allowedModelId = (await db
    .insertInto("unified_model")
    .values({
      enterprise_id: ENT_ID,
      alias: "qianliu-deepseek",
      display_name: "仟流 DeepSeek",
      status: "ACTIVE",
    })
    .returning("id")
    .executeTakeFirstOrThrow()).id;
  await db
    .insertInto("unified_model")
    .values({
      enterprise_id: ENT_ID,
      alias: "qianliu-denied",
      display_name: "未授权模型",
      status: "ACTIVE",
    })
    .execute();
  await db
    .updateTable("principal_key")
    .set({ allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[] })
    .where("id", "=", keyId)
    .execute();
  providerId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returning("id").executeTakeFirstOrThrow()).id;
  resourceId = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: providerId, name: "DeepSeek 主账号",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow()).id;
  routeId = (await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: allowedModelId,
    provider_resource_id: resourceId,
    upstream_model: "deepseek-chat",
  }).returning("id").executeTakeFirstOrThrow()).id;
  billingRuleId = (await db.insertInto("billing_rule").values({
    enterprise_id: ENT_ID,
    provider_resource_id: resourceId,
    upstream_model: "deepseek-chat",
    rule_type: "API_PRICE",
    rule_version: "w05-default-price",
    effective_from: new Date(0),
    cache_miss_price: "0.000001",
  }).returning("id").executeTakeFirstOrThrow()).id;
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    provider: "deepseek",
    model_alias: "qianliu-deepseek",
    quota_value: 1_000_000n,
    status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow();
  grantId = grant.id;
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

  app = buildGateway(db, PEPPER, async (input) => {
    pipelineCalls += 1;
    lastAuthorizedModelId = input.request.principal?.authorizedModelId;
    await stubPipeline(input);
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

function authHeader(key = validKey): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe("W05 北向合同", () => {
  it("GET /v1/models 返回 OpenAI 兼容形状 + qianliu-* 别名", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toEqual({
      id: "qianliu-deepseek",
      object: "model",
      owned_by: "qianliu",
    });
  });

  it("Codex 模型目录只返回当前 Key 获授权模型", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models?client_version=0.146.0",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models.map((model: { slug: string }) => model.slug)).toEqual([
      "qianliu-deepseek",
    ]);
    expect(body.models[0]).toMatchObject({
      display_name: "仟流 DeepSeek",
      shell_type: "unified_exec",
      supported_in_api: true,
    });
  });

  it("Grant 撤权或过期后模型目录即时隐藏，不能只依赖 Key 白名单", async () => {
    await db.updateTable("principal_grant").set({ status: "DISABLED" })
      .where("principal_id", "=", PRINCIPAL_ID).where("model_alias", "=", "qianliu-deepseek").execute();
    const revoked = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(revoked.json()).toEqual({ object: "list", data: [] });
    await db.updateTable("principal_grant").set({ status: "ACTIVE", valid_until: new Date(Date.now() - 1_000) })
      .where("principal_id", "=", PRINCIPAL_ID).where("model_alias", "=", "qianliu-deepseek").execute();
    const expired = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(expired.json()).toEqual({ object: "list", data: [] });
    await db.updateTable("principal_grant").set({ valid_until: null })
      .where("principal_id", "=", PRINCIPAL_ID).where("model_alias", "=", "qianliu-deepseek").execute();
  });

  it("池 Grant、显式禁用、route/resource/provider 与调用授权保持同一口径", async () => {
    await db.updateTable("principal_grant").set({
      model_alias: "*", pool_model_alias: "*",
    }).where("id", "=", grantId).execute();
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() }))
      .json().data.map((model: { id: string }) => model.id)).toEqual(["qianliu-deepseek"]);
    expect(await hasCurrentInvocationAuthorization(db, {
      enterpriseId: ENT_ID, principalId: PRINCIPAL_ID, keyId,
      modelAlias: "qianliu-deepseek", providerCode: "deepseek",
      resourceId, upstreamModel: "deepseek-chat", now: new Date(),
    })).toBe(true);

    await db.insertInto("principal_provider_disabled_model").values({
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      provider: "deepseek",
      unified_model_id: allowedModelId,
    }).execute();
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() }))
      .json()).toEqual({ object: "list", data: [] });
    expect(await hasCurrentInvocationAuthorization(db, {
      enterpriseId: ENT_ID, principalId: PRINCIPAL_ID, keyId,
      modelAlias: "qianliu-deepseek", providerCode: "deepseek",
      resourceId, upstreamModel: "deepseek-chat", now: new Date(),
    })).toBe(false);
    await db.deleteFrom("principal_provider_disabled_model")
      .where("enterprise_id", "=", ENT_ID).where("principal_id", "=", PRINCIPAL_ID)
      .where("provider", "=", "deepseek").where("unified_model_id", "=", allowedModelId).execute();

    for (const change of [
      async () => db.updateTable("model_route").set({ enabled: false }).where("id", "=", routeId).execute(),
      async () => db.updateTable("provider_resource").set({ status: "UNAVAILABLE" }).where("id", "=", resourceId).execute(),
      async () => db.updateTable("provider").set({ status: "DISABLED" }).where("id", "=", providerId).execute(),
    ]) {
      await change();
      expect((await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() }))
        .json()).toEqual({ object: "list", data: [] });
      await db.updateTable("model_route").set({ enabled: true }).where("id", "=", routeId).execute();
      await db.updateTable("provider_resource").set({ status: "ACTIVE" }).where("id", "=", resourceId).execute();
      await db.updateTable("provider").set({ status: "ACTIVE" }).where("id", "=", providerId).execute();
    }

    await db.updateTable("principal_grant").set({
      model_alias: "qianliu-deepseek", pool_model_alias: null,
    }).where("id", "=", grantId).execute();
  });

  it("计费规则在 effective_to 边界即时失效，目录与调用栅栏同时关闭", async () => {
    const boundary = new Date();
    await db.updateTable("billing_rule").set({ effective_to: boundary })
      .where("id", "=", billingRuleId).execute();
    try {
      expect((await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() }))
        .json()).toEqual({ object: "list", data: [] });
      await expect(hasCurrentInvocationAuthorization(db, {
        enterpriseId: ENT_ID,
        principalId: PRINCIPAL_ID,
        keyId,
        modelAlias: "qianliu-deepseek",
        providerCode: "deepseek",
        resourceId,
        upstreamModel: "deepseek-chat",
        now: boundary,
      })).resolves.toBe(false);
    } finally {
      await db.updateTable("billing_rule").set({ effective_to: null })
        .where("id", "=", billingRuleId).execute();
    }
  });

  it("计费规则未命中当前星期窗口时，目录与调用栅栏同时关闭", async () => {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      weekday: "short",
    }).format(now);
    const currentIsoDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday) + 1;
    const otherDay = currentIsoDay === 7 ? 1 : currentIsoDay + 1;
    await db.updateTable("billing_rule").set({
      timezone: "Asia/Shanghai",
      days_of_week: JSON.stringify([otherDay]) as unknown as number[],
      start_time: "00:00",
      end_time: "23:59",
    }).where("id", "=", billingRuleId).execute();
    try {
      expect((await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() }))
        .json()).toEqual({ object: "list", data: [] });
      await expect(hasCurrentInvocationAuthorization(db, {
        enterpriseId: ENT_ID,
        principalId: PRINCIPAL_ID,
        keyId,
        modelAlias: "qianliu-deepseek",
        providerCode: "deepseek",
        resourceId,
        upstreamModel: "deepseek-chat",
        now,
      })).resolves.toBe(false);
    } finally {
      await db.updateTable("billing_rule").set({
        timezone: "Asia/Shanghai",
        days_of_week: null,
        start_time: null,
        end_time: null,
      }).where("id", "=", billingRuleId).execute();
    }
  });

  it("最终授权绑定选中资源，同厂商兄弟 route 不能代替已撤权资源", async () => {
    const sibling = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID,
      provider_id: providerId,
      name: "DeepSeek 兄弟账号",
      mode: "API",
      credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    const siblingRoute = await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: allowedModelId,
      provider_resource_id: sibling.id,
      upstream_model: "deepseek-reasoner",
    }).returning("id").executeTakeFirstOrThrow();
    const siblingRule = await db.insertInto("billing_rule").values({
      enterprise_id: ENT_ID,
      provider_resource_id: sibling.id,
      upstream_model: "deepseek-reasoner",
      rule_type: "API_PRICE",
      rule_version: "w05-sibling-price",
      effective_from: new Date(0),
      cache_miss_price: "0.000001",
    }).returning("id").executeTakeFirstOrThrow();
    await db.updateTable("provider_resource").set({ status: "UNAVAILABLE" })
      .where("id", "=", resourceId).execute();
    try {
      await expect(hasCurrentInvocationAuthorization(db, {
        enterpriseId: ENT_ID,
        principalId: PRINCIPAL_ID,
        keyId,
        modelAlias: "qianliu-deepseek",
        providerCode: "deepseek",
        resourceId,
        upstreamModel: "deepseek-chat",
        now: new Date(),
      })).resolves.toBe(false);
    } finally {
      await db.updateTable("provider_resource").set({ status: "ACTIVE" })
        .where("id", "=", resourceId).execute();
      await db.deleteFrom("billing_rule").where("id", "=", siblingRule.id).execute();
      await db.deleteFrom("model_route").where("id", "=", siblingRoute.id).execute();
      await db.deleteFrom("provider_resource").where("id", "=", sibling.id).execute();
    }
  });

  it("仅已取得半开探针的请求可复核 RATE_LIMITED 资源", async () => {
    await db.updateTable("provider_resource").set({ status: "RATE_LIMITED" })
      .where("id", "=", resourceId).execute();
    try {
      const input = {
        enterpriseId: ENT_ID,
        principalId: PRINCIPAL_ID,
        keyId,
        modelAlias: "qianliu-deepseek",
        providerCode: "deepseek",
        resourceId,
        upstreamModel: "deepseek-chat",
        now: new Date(),
      };
      await expect(hasCurrentInvocationAuthorization(db, input)).resolves.toBe(false);
      await expect(hasCurrentInvocationAuthorization(db, {
        ...input,
        allowHalfOpenProbe: true,
      })).resolves.toBe(true);
    } finally {
      await db.updateTable("provider_resource").set({ status: "ACTIVE" })
        .where("id", "=", resourceId).execute();
    }
  });

  it("API 资源不会被额度规则或空价格规则误判为可计费", async () => {
    const ruleRepo = new EmployeeModelRuleRepository(db);
    await db.updateTable("principal_grant").set({
      model_alias: "*", pool_model_alias: "*",
    }).where("id", "=", grantId).execute();
    await db.updateTable("principal_key").set({
      allowed_model_ids: JSON.stringify([]) as unknown as string[],
    }).where("id", "=", keyId).execute();
    await db.updateTable("billing_rule").set({ enabled: false })
      .where("id", "=", billingRuleId).execute();
    const wrongRuleIds: string[] = [];
    for (const values of [
      { rule_type: "MODEL_TIER", multiplier: "1", cache_miss_price: null },
      { rule_type: "API_PRICE", multiplier: null, cache_miss_price: null },
    ]) {
      const inserted = await db.insertInto("billing_rule").values({
        enterprise_id: ENT_ID,
        provider_resource_id: resourceId,
        upstream_model: "deepseek-chat",
        rule_type: values.rule_type,
        rule_version: `w05-wrong-${wrongRuleIds.length}`,
        effective_from: new Date(0),
        multiplier: values.multiplier,
        cache_miss_price: values.cache_miss_price,
      }).returning("id").executeTakeFirstOrThrow();
      wrongRuleIds.push(inserted.id);
    }
    await db.transaction().execute((trx) => ruleRepo.refreshKeyModels(
      trx, ENT_ID, PRINCIPAL_ID,
    ));
    expect((await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("id", "=", keyId).executeTakeFirstOrThrow()).allowed_model_ids).toEqual([]);

    const priced = await db.insertInto("billing_rule").values({
      enterprise_id: ENT_ID,
      provider_resource_id: resourceId,
      upstream_model: "deepseek-chat",
      rule_type: "API_PRICE",
      rule_version: "w05-priced",
      effective_from: new Date(0),
      cache_miss_price: "0.000001",
    }).returning("id").executeTakeFirstOrThrow();
    await db.transaction().execute((trx) => ruleRepo.refreshKeyModels(
      trx, ENT_ID, PRINCIPAL_ID,
    ));
    expect((await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("id", "=", keyId).executeTakeFirstOrThrow()).allowed_model_ids)
      .toEqual([allowedModelId]);

    await db.deleteFrom("billing_rule").where("id", "in", [...wrongRuleIds, priced.id]).execute();
    await db.updateTable("billing_rule").set({ enabled: true })
      .where("id", "=", billingRuleId).execute();
    await db.updateTable("principal_grant").set({
      model_alias: "qianliu-deepseek", pool_model_alias: null,
    }).where("id", "=", grantId).execute();
  });

  it("allowed_model_ids 过滤模型列表，未授权调用在 pipeline/上游前拒绝", async () => {
    await db
      .updateTable("principal_key")
      .set({ allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[] })
      .where("id", "=", keyId)
      .execute();
    const listed = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(listed.json().data.map((model: { id: string }) => model.id)).toEqual(["qianliu-deepseek"]);

    const before = pipelineCalls;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-denied",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("model_not_allowed");
    expect(pipelineCalls).toBe(before);
  });

  it("异常历史 NULL 权限 fail-closed：模型列表为空且调用不进入 pipeline", async () => {
    await sql`
      ALTER TABLE principal_key
      ALTER COLUMN allowed_model_ids DROP NOT NULL
    `.execute(db);
    try {
      await db
        .updateTable("principal_key")
        .set({ allowed_model_ids: null })
        .where("id", "=", keyId)
        .execute();

      const listed = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: authHeader(),
      });
      expect(listed.json()).toEqual({ object: "list", data: [] });
      const codexListed = await app.inject({
        method: "GET",
        url: "/v1/models?client_version=0.146.0",
        headers: authHeader(),
      });
      expect(codexListed.json()).toEqual({ models: [] });

      const before = pipelineCalls;
      const denied = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: {
          model: "qianliu-deepseek",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("model_not_allowed");
      expect(pipelineCalls).toBe(before);
    } finally {
      await db
        .updateTable("principal_key")
        .set({
          allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[],
        })
        .where("id", "=", keyId)
        .execute();
      await sql`
        ALTER TABLE principal_key
        ALTER COLUMN allowed_model_ids SET NOT NULL
      `.execute(db);
    }
  });

  it("Key 模型撤权下一请求即时生效，恢复授权后可继续调用", async () => {
    await db
      .updateTable("principal_key")
      .set({ allowed_model_ids: JSON.stringify([]) as unknown as string[] })
      .where("id", "=", keyId)
      .execute();
    const before = pipelineCalls;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(denied.statusCode).toBe(403);
    expect(pipelineCalls).toBe(before);

    await db
      .updateTable("principal_key")
      .set({ allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[] })
      .where("id", "=", keyId)
      .execute();
    const restored = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("模型停用下一请求即时生效，且在 pipeline/上游前拒绝", async () => {
    await db
      .updateTable("unified_model")
      .set({ status: "INACTIVE" })
      .where("id", "=", allowedModelId)
      .execute();
    const before = pipelineCalls;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("model_not_allowed");
    expect(pipelineCalls).toBe(before);

    await db
      .updateTable("unified_model")
      .set({ status: "ACTIVE" })
      .where("id", "=", allowedModelId)
      .execute();
  });

  it("无 Bearer 返回 401 + OpenAI 错误 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("invalid_principal_key");
    expect(body.error.retryable).toBe(false);
  });

  it("无效 Key 返回 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: authHeader("sk-qianliu-invalid-key"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("停用主体和过期 Key 均在模型授权前 fail-closed", async () => {
    await db.updateTable("principal").set({ status: "DISABLED" })
      .where("id", "=", PRINCIPAL_ID).execute();
    try {
      const disabled = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
      expect(disabled.statusCode).toBe(401);
      expect(disabled.json().error.code).toBe("principal_disabled");
    } finally {
      await db.updateTable("principal").set({ status: "ACTIVE" })
        .where("id", "=", PRINCIPAL_ID).execute();
    }

    await db.updateTable("principal_key").set({ expires_at: new Date(Date.now() - 1_000) })
      .where("id", "=", keyId).execute();
    try {
      const expired = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
      expect(expired.statusCode).toBe(401);
      expect(expired.json().error.code).toBe("key_expired");
    } finally {
      await db.updateTable("principal_key").set({ expires_at: null })
        .where("id", "=", keyId).execute();
    }
  });

  it("POST /v1/chat/completions 非流式返回 chat.completion + usage + request_id 头", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    expect(lastAuthorizedModelId).toBe(allowedModelId);
    // request_id 贯穿
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("POOL-043：真实 pipeline 在调度前冻结稳定模型 ID，同时保留请求 alias", async () => {
    const ledgerRepo = new GatewayLedgerRepository(db);
    const identityApp = buildGateway(db, PEPPER, createRealPipeline({
      db,
      ledgerRepo,
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      listCandidates: async () => [],
      caller: async () => { throw new Error("POOL-043 不应访问上游"); },
    }));
    await identityApp.ready();
    try {
      const response = await identityApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: {
          model: "qianliu-deepseek",
          messages: [{ role: "user", content: "identity" }],
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("model_not_configured");
      const stored = await ledgerRepo.getRequest(response.headers["x-ai-request-id"] as string);
      expect(stored).toMatchObject({
        unified_model: "qianliu-deepseek",
        unified_model_id: allowedModelId,
      });
    } finally {
      await identityApp.close();
    }
  });

  it("POOL-043：真实 pipeline 缺少稳定模型 ID 时在 claim/调度/上游前拒绝", async () => {
    const claimRequest = vi.fn();
    const listCandidates = vi.fn();
    const caller = vi.fn();
    const handler = createRealPipeline({
      db,
      ledgerRepo: { claimRequest } as never,
      poolRepo: {} as never,
      quotaRepo: {} as never,
      listCandidates,
      caller,
    });
    const send = vi.fn();
    const reply = {
      code: vi.fn(),
      header: vi.fn(),
      send,
    };
    reply.code.mockReturnValue(reply);
    reply.header.mockReturnValue(reply);
    const defensiveRequestId = randomUUID();
    const countBefore = await db.selectFrom("ai_request")
      .select((eb) => eb.fn.countAll<string>().as("count")).executeTakeFirstOrThrow();
    await handler({
      request: {
        aiRequestId: defensiveRequestId,
        requestId: "pool043-missing-stable-id",
        principal: {
          principalId: PRINCIPAL_ID,
          enterpriseId: ENT_ID,
          keyId,
          allowedModelIds: [allowedModelId],
          authorizedModelId: null,
        },
      } as never,
      reply: reply as never,
      body: { model: "qianliu-deepseek", messages: [{ role: "user", content: "identity" }] },
      capability: "chat",
    });
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "model_not_allowed" }),
    }));
    expect(claimRequest).not.toHaveBeenCalled();
    expect(listCandidates).not.toHaveBeenCalled();
    expect(caller).not.toHaveBeenCalled();
    const countAfter = await db.selectFrom("ai_request")
      .select((eb) => eb.fn.countAll<string>().as("count")).executeTakeFirstOrThrow();
    expect(countAfter.count).toBe(countBefore.count);
  });

  it("POST /v1/chat/completions 流式返回 SSE chat.completion.chunk + [DONE]", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const text = res.body;
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
    // usage 在最后 chunk
    expect(text).toContain("total_tokens");
  });

  it("POST /v1/messages 返回 Anthropic message 形状", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.usage.input_tokens).toBeDefined();
    expect(body.usage.output_tokens).toBeDefined();
  });

  it("WT-14：POST /v1/embeddings 返回 422 + capability_not_supported + 不可重试", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.type).toBe("capability_not_supported");
    expect(body.error.code).toBe("capability_not_supported");
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBeDefined();
  });

  it("POST /v1/responses 非流式返回 Response + 缓存/推理 Usage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        input: "hi",
        reasoning: { effort: "medium", summary: "auto" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("message");
    expect(body.usage.input_tokens_details.cached_tokens).toBe(2);
    expect(body.usage.output_tokens_details.reasoning_tokens).toBe(3);
    expect(body.reasoning.effort).toBe("medium");
  });

  it("POST /v1/responses 流式事件包含 completed 与完整 Usage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi", stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: response.output_text.delta");
    expect(res.body).toContain("event: response.completed");
    expect(res.body).toContain("reasoning_tokens");
  });

  it("POST /v1/responses 工具调用映射 function_call 与参数流事件", async () => {
    const payload = {
      model: "qianliu-deepseek",
      input: [{ role: "user", content: [{ type: "input_text", text: "调用工具" }] }],
      tools: [{
        type: "function",
        name: "get_weather",
        description: "查询天气",
        parameters: { type: "object", properties: {} },
      }],
    };
    const nonStream = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload,
    });
    expect(nonStream.statusCode).toBe(200);
    expect(nonStream.json().output[0]).toMatchObject({
      type: "function_call",
      name: "get_weather",
      arguments: "{}",
    });

    const stream = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ...payload, stream: true },
    });
    expect(stream.body).toContain("response.function_call_arguments.delta");
    expect(stream.body).toContain("response.output_item.done");
  });

  it("W23：POST /v1/messages/count_tokens 返回 422 + capability_not_supported", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.type).toBe("capability_not_supported");
    expect(body.error.retryable).toBe(false);
  });

  it("W23：WebSocket 握手（Upgrade 头）返回 422 + capability_not_supported，不静默降级", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { ...authHeader(), upgrade: "websocket", connection: "Upgrade" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.type).toBe("capability_not_supported");
    expect(body.error.code).toBe("capability_not_supported");
    expect(body.error.capability).toBe("websocket");
    expect(body.error.retryable).toBe(false);
  });

  it("缺少 model 返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("bodyLimit 已从 Fastify 默认 1MB 抬高：1.5MB 请求体正常进入路由（不再 413）", async () => {
    // 1.5MB 文本内容，超过 Fastify 默认 bodyLimit 1MB；旧实现会返回 413。
    const bigContent = "x".repeat(1.5 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: bigContent }],
      },
    });
    // 进入路由即返回 200（stub pipeline 回声），证明未被 bodyLimit 拦截。
    expect(res.statusCode).toBe(200);
  });

  it("请求体超过 bodyLimit 上限返回 413 + OpenAI envelope + payload_too_large（不再 reason=unknown）", async () => {
    // 11MB 文本内容，超过默认 10MB bodyLimit；触发 FST_ERR_CTP_BODY_TOO_LARGE。
    const oversized = "y".repeat(11 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: oversized }],
      },
    });
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBeDefined();
  });

  it("客户端传 x-request-id 仅作为追踪 ID 回显", async () => {
    const customId = "client-custom-req-id-123";
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { ...authHeader(), "x-request-id": customId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe(customId);
    expect(res.headers["x-ai-request-id"]).toBeDefined();
    expect(res.headers["x-ai-request-id"]).not.toBe(customId);
  });

  it("非法或相互冲突的 Idempotency-Key 在 pipeline 前返回稳定 400", async () => {
    const callsBefore = pipelineCalls;
    const conflicting = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...authHeader(),
        "idempotency-key": "standard-key",
        "x-idempotency-key": "different-key",
      },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json().error.code).toBe("invalid_idempotency_key");
    expect(conflicting.headers["x-ai-request-id"]).toBeDefined();

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "idempotency-key": "contains whitespace" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_idempotency_key");
    expect(pipelineCalls).toBe(callsBefore);
  });
});
