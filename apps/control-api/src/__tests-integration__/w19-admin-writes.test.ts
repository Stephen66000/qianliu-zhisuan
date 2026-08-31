/**
 * control-api W19 集成测试：管理写操作闭环（更新/停用/凭证恢复/并发）。
 *
 * 覆盖（W19 DoD：管理动作即时生效、二次确认语义后端为状态校验、并发修改测试）：
 *   - PATCH /provider-resources/:id（改名/并发 409）
 *   - PATCH /unified-models/:id（停用 + audit）
 *   - PATCH /model-routes/:id（权重/启停）
 *   - PATCH /grants/:id（调额/停用）
 *   - POST/PATCH /billing-rules（创建/编辑 + version 并发）
 *   - POST /provider-resources/:id/recover（WT-19：隔离态恢复 + 轮换凭证；非隔离态 409）
 *   - 六要素：401 未认证、404 越界/不存在、audit 落 operation_log
 *   - canary：轮换凭证的明文绝不进 DB
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";
import type { RuleExtractor } from "../billing-rule-imports/extractor.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let adminCookie: string;

const TEST_PASSWORD = "W19-Test-Password!";
const ENT_ID = randomUUID();
const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流 W19 测试企业" }).execute();
  const hash = await hashPassword(TEST_PASSWORD);
  await db
    .insertInto("admin_user")
    .values({ id: ADM_ID, enterprise_id: ENT_ID, username: "admin", password_hash: hash, status: "ACTIVE" })
    .execute();

  const { buildControlApi } = await import("../server.js");
  const ruleExtractor: RuleExtractor = {
    extract: async ({ targetUpstreamModel }) => ({
      extractorModel: "ql-k3",
      extractorRequestId: "chatcmpl-import-test",
      extraction: {
        source_kind: "pricing_table",
        unit_basis: "CNY_PER_MILLION_TOKENS",
        rows: [],
        ambiguities: ["上下文单位待确认"],
      },
      targetEvidence: {
        model_name: targetUpstreamModel,
        context_display: "1M",
        input_price: { current: "0.4", original: "0.8" },
        output_price: { current: "1.4", original: "2.8" },
        cache_storage: "限时免费",
        cache_hit_price: { current: "0.115", original: "0.23" },
        input_modalities: ["图片", "文本"],
        badges: ["5折限时两周"],
        time_windows: [],
        model_tier_multiplier: null,
      },
      candidateRules: [{
        rule_type: "API_PRICE",
        windows: [],
        multiplier: "",
        cache_hit_price: "0.000000115",
        cache_miss_price: "0.0000004",
        output_price: "0.0000014",
        currency: "CNY",
        priority: 100,
      }],
      warnings: [{ code: "SOURCE_AMBIGUITY_1", message: "上下文单位待确认", field: null, blocking: false }],
    }),
  };
  app = buildControlApi(db, { ruleExtractor });
  await app.ready();

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: TEST_PASSWORD },
  });
  const setCookie = loginRes.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

/** provider 按 code 复用（provider 表 UNIQUE(enterprise_id, code)，重复 insert 会撞唯一约束）。 */
async function ensureProvider(code: "deepseek" | "zhipu" | "kimi") {
  const existing = await db
    .selectFrom("provider")
    .selectAll()
    .where("enterprise_id", "=", ENT_ID)
    .where("code", "=", code)
    .executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("provider")
    .values({ enterprise_id: ENT_ID, code, name: `${code} 测试`, adapter_type: code })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function seedProviderResource(status = "ACTIVE") {
  const provider = await ensureProvider("zhipu");
  const resource = await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: ENT_ID,
      provider_id: provider.id,
      name: `智谱主账号-${randomUUID().slice(0, 8)}`,
      mode: "API",
      credential_type: "API_KEY",
      status,
      credential_version: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { provider, resource };
}

async function countAudit(action: string): Promise<number> {
  const rows = await db
    .selectFrom("operation_log")
    .select("id")
    .where("enterprise_id", "=", ENT_ID)
    .where("action", "=", action)
    .execute();
  return rows.length;
}

describe("W19 管理写操作闭环", () => {
  it("PATCH /provider-resources/:id 改名成功并写 audit", async () => {
    const { resource } = await seedProviderResource();
    const res = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "智谱主账号（华北）",
        upstream_models: ["glm-4.6", "glm-z-plan"],
        concurrency_limit: 32,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource.name).toBe("智谱主账号（华北）");
    expect(res.json().resource.upstream_models).toEqual(["glm-4.6", "glm-z-plan"]);
    expect(res.json().resource.concurrency_limit).toBe(32);
    expect(res.json().resource.id).toBe(resource.id);
    expect(res.json().resource.version).toBe(resource.version + 1);
    expect(res.json().resource.credential_ciphertext).toBeUndefined();
    expect(res.json().resource.credential_version).toBe(resource.credential_version);
    expect(await countAudit("provider_resource.update")).toBe(1);
  });

  it("PATCH /provider-resources/:id 并发修改 → 409 conflict", async () => {
    const { resource } = await seedProviderResource();
    // 第一次更新成功（updated_at 变化）
    const first = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "第一次改名",
      },
    });
    expect(first.statusCode).toBe(200);
    // 用旧 expected_updated_at 再改 → 409
    const stale = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "过期快照改名",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");
  });

  it("PATCH /unified-models/:id 停用并写 audit（W19 补齐 create audit）", async () => {
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `qianliu-glm-${randomUUID().slice(0, 8)}`,
        display_name: "仟流 GLM",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/unified-models/${model.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: model.version,
        status: "DISABLED",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model.status).toBe("DISABLED");
    expect(await countAudit("unified_model.disable")).toBe(1);
  });

  it("PATCH /model-routes/:id 调整权重与停用", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `route-model-${randomUUID().slice(0, 8)}`,
        display_name: "路由模型",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const route = await db
      .insertInto("model_route")
      .values({
        enterprise_id: ENT_ID,
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/model-routes/${route.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: route.version,
        weight: 5,
        enabled: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().route.weight).toBe(5);
    expect(res.json().route.enabled).toBe(false);
    expect(await countAudit("model_route.update")).toBe(1);
  });

  it("PATCH /grants/:id 调额与停用", async () => {
    const principal = await db
      .insertInto("principal")
      .values({ enterprise_id: ENT_ID, type: "EMPLOYEE", name: "W19 员工" })
      .returningAll()
      .executeTakeFirstOrThrow();
    const grant = await db
      .insertInto("principal_grant")
      .values({
        enterprise_id: ENT_ID,
        principal_id: principal.id,
        provider: "zhipu",
        model_alias: "glm-4.6",
        quota_value: 100_000n,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/grants/${grant.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: grant.version,
        quota_value: "200000",
        status: "DISABLED",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant.status).toBe("DISABLED");
    expect(await countAudit("grant.disable")).toBe(1);
  });

  it("POST/PATCH /billing-rules 配置不可原地改写，生命周期修改仍使用乐观锁", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `billing-model-${randomUUID().slice(0, 8)}`,
        display_name: "计价规则模型",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("model_route")
      .values({
        enterprise_id: ENT_ID,
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        enabled: true,
      })
      .execute();
    const created = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: {
        rule_type: "API_PRICE",
        rule_version: "w19-web-v1",
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        effective_from: new Date().toISOString(),
        cache_miss_price: "0.000001",
        output_price: "0.000002",
        priority: 10,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().rule.version).toBe(1);
    expect(await countAudit("billing_rule.create")).toBe(1);

    const rule = created.json().rule;
    const updated = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: rule.version,
        enabled: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule.output_price).toBe("0.000002");
    expect(updated.json().rule.enabled).toBe(false);
    expect(updated.json().rule.version).toBe(2);
    expect(await countAudit("billing_rule.update")).toBe(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 1, enabled: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");

    const inPlacePriceChange = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 2, output_price: "0.000003" },
    });
    expect(inPlacePriceChange.statusCode).toBe(400);
    expect(inPlacePriceChange.json().error).toBe("invalid_request");
  });

  it("POST /billing-rule-sets 校验差异后原子创建同一 Model Route 的整套规则", async () => {
    const { resource } = await seedProviderResource();
    const upstreamModel = `glm-copy-${randomUUID().slice(0, 8)}`;
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `billing-copy-${randomUUID().slice(0, 8)}`,
        display_name: "整套规则复制模型",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: model.id,
      provider_resource_id: resource.id,
      upstream_model: upstreamModel,
      enabled: true,
    }).execute();

    const copied = await app.inject({
      method: "POST",
      url: "/billing-rule-sets",
      headers: { cookie: adminCookie },
      payload: {
        rules: [
          {
            rule_type: "API_PRICE",
            rule_version: "copy-v1",
            provider_resource_id: resource.id,
            upstream_model: upstreamModel,
            effective_from: new Date().toISOString(),
            cache_miss_price: "0.000001",
            output_price: "0.000002",
            priority: 10,
            source: "WEB_ADMIN_COPY:source-api",
          },
          {
            rule_type: "TIME_WINDOW",
            rule_version: "copy-v1",
            provider_resource_id: resource.id,
            upstream_model: upstreamModel,
            effective_from: new Date().toISOString(),
            windows: [{
              timezone: "Asia/Shanghai",
              days_of_week: [1, 2, 3, 4, 5, 6, 7],
              start_time: "14:00",
              end_time: "18:00",
            }],
            multiplier: "3",
            priority: 20,
            source: "WEB_ADMIN_COPY:source-window",
          },
        ],
      },
    });

    expect(copied.statusCode).toBe(201);
    expect(copied.json().rules).toHaveLength(2);
    expect(await db.selectFrom("billing_rule")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("provider_resource_id", "=", resource.id)
      .where("upstream_model", "=", upstreamModel)
      .execute()).toHaveLength(2);
    expect(await countAudit("billing_rule_set.copy")).toBe(1);

    const invalidModel = `${upstreamModel}-invalid`;
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: model.id,
      provider_resource_id: resource.id,
      upstream_model: invalidModel,
      enabled: true,
    }).execute();
    const rejected = await app.inject({
      method: "POST",
      url: "/billing-rule-sets",
      headers: { cookie: adminCookie },
      payload: {
        rules: [
          {
            rule_type: "API_PRICE",
            rule_version: "invalid-v1",
            provider_resource_id: resource.id,
            upstream_model: invalidModel,
            effective_from: new Date().toISOString(),
            output_price: "0.000002",
          },
          {
            rule_type: "TIME_WINDOW",
            rule_version: "invalid-v1",
            provider_resource_id: resource.id,
            upstream_model: invalidModel,
            effective_from: new Date().toISOString(),
            windows: [{
              timezone: "Asia/Shanghai",
              start_time: "14:00",
              end_time: "18:00",
            }],
          },
        ],
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(await db.selectFrom("billing_rule")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("upstream_model", "=", invalidModel)
      .execute()).toHaveLength(0);
  });

  it("官网截图预览不保存原图，确认后原子创建规则并防重放", async () => {
    const { resource } = await seedProviderResource();
    const upstreamModel = `glm-5.3-flash-${randomUUID().slice(0, 6)}`;
    const model = await db.insertInto("unified_model").values({
      enterprise_id: ENT_ID,
      alias: `screenshot-${randomUUID().slice(0, 8)}`,
      display_name: "截图识别模型",
    }).returningAll().executeTakeFirstOrThrow();
    const route = await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: model.id,
      provider_resource_id: resource.id,
      upstream_model: upstreamModel,
      enabled: true,
    }).returningAll().executeTakeFirstOrThrow();
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nEAAAAAASUVORK5CYII=";
    const preview = await app.inject({
      method: "POST",
      url: "/billing-rule-imports/preview",
      headers: { cookie: adminCookie },
      payload: { model_route_id: route.id, image_data_url: image },
    });
    expect(preview.statusCode, JSON.stringify(preview.json())).toBe(201);
    const imported = preview.json().import;
    expect(imported.extractorModel).toBe("ql-k3");
    expect(imported.candidateRules[0]).toMatchObject({
      cache_miss_price: "0.0000004",
      output_price: "0.0000014",
    });
    const stored = await db.selectFrom("billing_rule_import").selectAll()
      .where("id", "=", imported.id).executeTakeFirstOrThrow();
    expect(stored.image_sha256).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain("iVBORw0KGgo");
    expect(stored.source_evidence).not.toHaveProperty("extracted");
    expect(JSON.stringify(stored)).not.toContain("上下文单位待确认");

    const wrongUnit = await app.inject({
      method: "POST",
      url: `/billing-rule-imports/${imported.id}/confirm`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: imported.version,
        rule_version: "screenshot-v1",
        effective_from: new Date().toISOString(),
        effective_to: null,
        acknowledged_warning_codes: [],
        source_price_unit: "CNY_PER_TOKEN",
        rules: imported.candidateRules,
      },
    });
    expect(wrongUnit.statusCode).toBe(409);
    expect(wrongUnit.json().error).toBe("source_unit_mismatch");

    const confirmed = await app.inject({
      method: "POST",
      url: `/billing-rule-imports/${imported.id}/confirm`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: imported.version,
        rule_version: "screenshot-v1",
        effective_from: new Date().toISOString(),
        effective_to: null,
        acknowledged_warning_codes: [],
        source_price_unit: "CNY_PER_MILLION_TOKENS",
        rules: imported.candidateRules,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().rules).toHaveLength(1);
    expect(confirmed.json().rules[0].source).toBe(`SCREENSHOT_IMPORT:${imported.id}`);
    expect(await countAudit("billing_rule_import.preview")).toBe(1);
    expect(await countAudit("billing_rule_import.confirm")).toBe(1);

    const replay = await app.inject({
      method: "POST",
      url: `/billing-rule-imports/${imported.id}/confirm`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: imported.version,
        rule_version: "screenshot-v1",
        effective_from: new Date().toISOString(),
        effective_to: null,
        acknowledged_warning_codes: [],
        source_price_unit: "CNY_PER_MILLION_TOKENS",
        rules: imported.candidateRules,
      },
    });
    expect(replay.statusCode).toBe(409);

    const atomicPreview = await app.inject({
      method: "POST",
      url: "/billing-rule-imports/preview",
      headers: { cookie: adminCookie },
      payload: { model_route_id: route.id, image_data_url: image },
    });
    const atomicImport = atomicPreview.json().import;
    const beforeCount = (await db.selectFrom("billing_rule").select("id")
      .where("enterprise_id", "=", ENT_ID).where("upstream_model", "=", upstreamModel).execute()).length;
    await sql`CREATE OR REPLACE FUNCTION fail_screenshot_confirm_audit() RETURNS trigger AS $$ BEGIN IF NEW.action = 'billing_rule_import.confirm' THEN RAISE EXCEPTION 'injected screenshot audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`.execute(db);
    await sql`CREATE TRIGGER fail_screenshot_confirm_audit BEFORE INSERT ON operation_log FOR EACH ROW EXECUTE FUNCTION fail_screenshot_confirm_audit()`.execute(db);
    try {
      const failedConfirm = await app.inject({
        method: "POST",
        url: `/billing-rule-imports/${atomicImport.id}/confirm`,
        headers: { cookie: adminCookie },
        payload: {
          expected_version: atomicImport.version,
          rule_version: "screenshot-v2",
          effective_from: new Date().toISOString(),
          effective_to: null,
          acknowledged_warning_codes: [],
          source_price_unit: "CNY_PER_MILLION_TOKENS",
          rules: atomicImport.candidateRules,
        },
      });
      expect(failedConfirm.statusCode).toBe(500);
      expect((await db.selectFrom("billing_rule_import").select("status")
        .where("id", "=", atomicImport.id).executeTakeFirstOrThrow()).status).toBe("EXTRACTED");
      expect((await db.selectFrom("billing_rule").select("id")
        .where("enterprise_id", "=", ENT_ID).where("upstream_model", "=", upstreamModel).execute()).length)
        .toBe(beforeCount);
    } finally {
      await sql`DROP TRIGGER IF EXISTS fail_screenshot_confirm_audit ON operation_log`.execute(db);
      await sql`DROP FUNCTION IF EXISTS fail_screenshot_confirm_audit()`.execute(db);
    }
  });

  it("POST/GET /billing-rules 单条规则持久化两个时窗，并强制价格/倍率语义隔离", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `billing-window-${randomUUID().slice(0, 8)}`,
        display_name: "多时窗计价模型",
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: model.id,
      provider_resource_id: resource.id,
      upstream_model: "deepseek-chat",
      enabled: true,
    }).execute();
    const basePayload = {
      rule_type: "API_PRICE",
      rule_version: "deepseek-peak-v1",
      provider_resource_id: resource.id,
      upstream_model: "deepseek-chat",
      effective_from: "2026-07-01T00:00:00.000Z",
      windows: [
        {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "09:00",
          end_time: "12:00",
        },
        {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "14:00",
          end_time: "18:00",
        },
      ],
      cache_hit_price: "0.000001",
      cache_miss_price: "0.000002",
      output_price: "0.000004",
      priority: 10,
    };
    const created = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: basePayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().rule).toMatchObject({
      timezone: "Asia/Shanghai",
      start_time: "09:00",
      end_time: "12:00",
      time_windows: basePayload.windows,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().rules.find((rule: { id: string }) => rule.id === created.json().rule.id),
    ).toMatchObject({ time_windows: basePayload.windows });

    const editedWindows = [
      basePayload.windows[1],
      basePayload.windows[0],
    ];
    const newVersion = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: {
        ...basePayload,
        rule_version: "deepseek-peak-v2",
        effective_from: "2026-08-01T00:00:00.000Z",
        windows: editedWindows,
      },
    });
    expect(newVersion.statusCode).toBe(201);
    expect(newVersion.json().rule).toMatchObject({
      rule_version: "deepseek-peak-v2",
      time_windows: editedWindows,
      timezone: "Asia/Shanghai",
      start_time: "14:00",
      end_time: "18:00",
    });

    const immutableWindowPatch = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${created.json().rule.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: created.json().rule.version,
        windows: editedWindows,
      },
    });
    expect(immutableWindowPatch.statusCode).toBe(400);

    const mixedSemantics = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: { ...basePayload, multiplier: "2" },
    });
    expect(mixedSemantics.statusCode).toBe(400);
    expect(mixedSemantics.json().message).toContain("API 价格规则不能配置额度倍率");
  });

  it("调度策略草稿经校验后发布并停用，全部状态可查询且写审计", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `glm-dispatch-${randomUUID().slice(0, 8)}`,
        display_name: "智谱调度模型",
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const principals = await db
      .insertInto("principal")
      .values([
        { enterprise_id: ENT_ID, type: "EMPLOYEE", name: "于滔", department_label: "研发部", status: "ACTIVE" },
        { enterprise_id: ENT_ID, type: "PROJECT", name: "智算项目", department_label: null, status: "ACTIVE" },
      ])
      .returning("id")
      .execute();
    const created = await app.inject({
      method: "POST",
      url: "/dispatch-policies",
      headers: { cookie: adminCookie },
      payload: {
        match_unified_model: model.alias,
        match_resource_mode: "CODING_PLAN",
        match_provider_resource_id: resource.id,
        match_timezone: "Asia/Shanghai",
        match_days_of_week: [1, 2, 3, 4, 5, 6, 7],
        match_start_time: "14:00:00",
        match_end_time: "18:00:00",
        action: "REJECT",
        policy_version: "zhipu-peak-reject-v1",
        priority: 10,
        description: "智谱高峰硬拒绝",
      },
    });
    expect(created.statusCode).toBe(201);
    const policy = created.json().policy;
    expect(policy.status).toBe("DRAFT");

    const edited = await app.inject({
      method: "PATCH",
      url: `/dispatch-policies/${policy.id}`,
      headers: { cookie: adminCookie },
      payload: {
        match_unified_model: model.alias,
        match_resource_mode: "CODING_PLAN",
        match_provider_resource_id: resource.id,
        match_timezone: "Asia/Shanghai",
        match_days_of_week: [1, 2, 3, 4, 5, 6, 7],
        match_start_time: "14:00:00",
        match_end_time: "18:00:00",
        match_principal_scope: principals.map((principal) => principal.id),
        action: "REJECT",
        policy_version: "zhipu-peak-reject-v2",
        priority: 9,
        description: "指定主体高峰硬拒绝",
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().policy).toMatchObject({
      status: "DRAFT",
      policyVersion: "zhipu-peak-reject-v2",
      matchPrincipalScope: principals.map((principal) => principal.id),
      priority: 9,
    });

    const directPublish = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(directPublish.statusCode).toBe(409);

    const validated = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().policy.status).toBe("VALIDATED");

    const published = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().policy.status).toBe("PUBLISHED");

    const immutableEdit = await app.inject({
      method: "PATCH",
      url: `/dispatch-policies/${policy.id}`,
      headers: { cookie: adminCookie },
      payload: {
        match_principal_scope: null,
        action: "REJECT",
        policy_version: "forbidden",
        priority: 1,
      },
    });
    expect(immutableEdit.statusCode).toBe(409);

    const listed = await app.inject({
      method: "GET",
      url: "/dispatch-policies",
      headers: { cookie: adminCookie },
    });
    expect(
      listed.json().policies.find((item: { id: string }) => item.id === policy.id),
    ).toMatchObject({
      status: "PUBLISHED",
      action: "REJECT",
      matchStartTime: "14:00:00",
      matchEndTime: "18:00:00",
    });

    const retired = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/retire`,
      headers: { cookie: adminCookie },
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().policy.status).toBe("RETIRED");

    const otherEnterpriseId = randomUUID();
    await db.insertInto("enterprise").values({ id: otherEnterpriseId, name: "POOL-016 隔离企业" }).execute();
    const otherPrincipal = await db
      .insertInto("principal")
      .values({
        enterprise_id: otherEnterpriseId,
        type: "EMPLOYEE",
        name: "其他企业员工",
        department_label: null,
        status: "ACTIVE",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const crossEnterpriseDraft = await app.inject({
      method: "POST",
      url: "/dispatch-policies",
      headers: { cookie: adminCookie },
      payload: {
        match_principal_scope: [otherPrincipal.id],
        action: "REJECT",
        policy_version: "pool016-cross-enterprise",
        priority: 100,
      },
    });
    expect(crossEnterpriseDraft.statusCode).toBe(201);
    const crossEnterpriseValidation = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${crossEnterpriseDraft.json().policy.id}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(crossEnterpriseValidation.statusCode).toBe(400);
    expect(crossEnterpriseValidation.json().error).toBe("invalid_reference");

    expect(await countAudit("dispatch_policy.create")).toBe(2);
    expect(await countAudit("dispatch_policy.update")).toBe(1);
    expect(await countAudit("dispatch_policy.validate")).toBe(1);
    expect(await countAudit("dispatch_policy.publish")).toBe(1);
    expect(await countAudit("dispatch_policy.retire")).toBe(1);
  });

  it("POST /provider-resources/:id/recover：隔离态恢复 + 轮换凭证 + 明文 0 命中 canary", async () => {
    const { resource } = await seedProviderResource("CREDENTIAL_INVALID");
    const canarySecret = "sk-w19-ROTATION-CANARY-SECRET-98765";
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: { credential_plaintext: canarySecret },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resource.status).toBe("DEGRADED");
    expect(body.resource.credential_version).toBe(2);
    expect(JSON.stringify(body)).not.toContain(canarySecret);

    // 状态迁移事件（actor=admin）
    const events = await db
      .selectFrom("resource_status_event")
      .selectAll()
      .where("provider_resource_id", "=", resource.id)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.from_status).toBe("CREDENTIAL_INVALID");
    expect(events[0]!.to_status).toBe("DEGRADED");
    expect(events[0]!.actor).toBe("admin");

    // audit
    expect(await countAudit("provider_resource.recover")).toBe(1);

    // canary：轮换明文在 provider_resource 表 0 命中
    const scan = await sql`
      SELECT COUNT(*) AS hits FROM (
        SELECT row_to_json(t)::text AS row_text FROM provider_resource t
      ) s WHERE s.row_text LIKE ${"%" + canarySecret + "%"}
    `.execute(db);
    expect(Number((scan.rows[0] as { hits: number | bigint }).hits)).toBe(0);
    // 密文已写入且不含明文
    const row = await db
      .selectFrom("provider_resource")
      .select(["credential_ciphertext"])
      .where("id", "=", resource.id)
      .executeTakeFirstOrThrow();
    expect(row.credential_ciphertext).not.toBeNull();
    expect(row.credential_ciphertext).not.toContain(canarySecret);
  });

  it("POST /provider-resources/:id/recover：非隔离态 → 409 invalid_state", async () => {
    const { resource } = await seedProviderResource("ACTIVE");
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_state");
  });

  it("POST /provider-resources/:id/recover：不轮换凭证也可恢复（仅状态）", async () => {
    const { resource } = await seedProviderResource("EXHAUSTED");
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource.status).toBe("DEGRADED");
    expect(res.json().resource.credential_version).toBe(1);
  });

  it("六要素：未认证 401 / 不存在 404 / 跨企业不可见", async () => {
    const noAuth = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${randomUUID()}`,
      payload: { expected_version: 1, name: "x" },
    });
    expect(noAuth.statusCode).toBe(401);

    const notFound = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 1, name: "x" },
    });
    expect(notFound.statusCode).toBe(404);

    const recoverNotFound = await app.inject({
      method: "POST",
      url: `/provider-resources/${randomUUID()}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(recoverNotFound.statusCode).toBe(404);
  });
});
